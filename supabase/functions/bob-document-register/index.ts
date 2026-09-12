/**
 * bob-document-register — governed, dedupe-aware intake of an already-uploaded
 * document into the document registry (Phase 1).
 *
 * Reuses the EXISTING upload path (bob-uploads bucket / bob_attachments) and
 * the EXISTING extraction bridge (bob-extract-document). Never browses buckets.
 *
 * Intake flow (dedupe by content, not filename):
 *   1. Resolve the object coordinates from the attachment/event.
 *   2. Extract text + compute a strong content hash (sha256) FIRST.
 *   3. Record the upload event (provenance) — ALWAYS, even on a dedupe hit.
 *   4. Look up an existing canonical `documents` row by hash WITHIN the caller's
 *      permitted scope (own-org tenant docs, or the approved global library).
 *   5. If found, LINK the event to it (no duplicate byte-store, no reclassify
 *      unless the existing classification is missing/low-confidence/stale).
 *   6. If not found, create the canonical doc + version and run Bob's
 *      classification proposal. It stays conversation/tenant scoped until a
 *      human promotes it.
 *
 * Canonical identity = content_hash + scope. A DIFFERENT hash is always a new
 * document version even if the title is identical (version drift).
 *
 * Tenant safety: dedupe lookup is constrained to the caller's org OR the global
 * approved library. Identical bytes under ANOTHER tenant are never revealed.
 *
 * Auth: Supabase JWT required. Caller must be admin/master/grand_master/admin_officer.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient as _createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const createClient = (url, key, opts)=>_createClient(url, key, opts);
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_REGISTER = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer'
]);
// Bump when the classification heuristic/policy changes so older records are
// treated as stale and re-run on next sight.
const CLASSIFIER_MODEL_VERSION = 1;
const RECLASSIFY_CONFIDENCE_FLOOR = 0.6;
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
/**
 * Heuristic sensitivity classifier (Phase 1). Conservative: defaults to tenant
 * scope, only marks public/internal on clear signals, flags obvious risk
 * markers so borderline material lands as pending review. A Bob proposal only
 * — never authoritative for legal/privacy cases.
 */ function classify(text) {
  const t = (text || '').toLowerCase();
  const has = (re)=>re.test(t);
  const contains_pii = has(/\b(\d{2,3}[-\s]?\d{3}[-\s]?\d{3,4})\b/) || has(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/) || has(/\b(date of birth|dob|passport|driver licence|driver's licence|ird number|nhi)\b/);
  const contains_financial_data = has(/\b(invoice|account number|bank|iban|gst|payment|remittance|salary|payroll)\b/);
  const contains_legal_privilege = has(/\b(privileged|legal advice|without prejudice|solicitor|counsel|litigation)\b/);
  const contains_operational_security = has(/\b(alarm code|access code|patrol route|guard schedule|key safe|master key|cctv password)\b/);
  const looksPublic = has(/\b(bylaw|act \d{4}|regulation|standard|published|council form|public notice|manual)\b/);
  let privacy_class = 'tenant_sensitive';
  let confidence = 0.5;
  let rationale = 'Defaulted to tenant-scoped: no strong public/internal signal.';
  if (contains_pii || contains_financial_data || contains_legal_privilege) {
    privacy_class = 'restricted';
    confidence = 0.7;
    rationale = 'Contains PII / financial / legal-privilege markers — restricted, no shared library.';
  } else if (contains_operational_security) {
    privacy_class = 'tenant_sensitive';
    confidence = 0.65;
    rationale = 'Operational-security content — kept tenant-scoped.';
  } else if (looksPublic) {
    privacy_class = 'public';
    confidence = 0.6;
    rationale = 'Looks like published/public source material. Human review recommended before global promotion.';
  }
  return {
    privacy_class,
    contains_pii,
    contains_operational_security,
    contains_financial_data,
    contains_legal_privilege,
    confidence,
    rationale
  };
}
// A classification is stale/insufficient if absent, low-confidence, missing a
// class, or produced by an older classifier model version.
function needsReclassification(cls) {
  if (!cls) return true;
  if (!cls.privacy_class) return true;
  if (cls.classifier_source === 'human_review') return false; // human wins
  if (typeof cls.confidence === 'number' && cls.confidence < RECLASSIFY_CONFIDENCE_FLOOR) return true;
  const modelV = Number(cls?.model_version ?? cls?.metadata_model_version ?? 0);
  if (modelV < CLASSIFIER_MODEL_VERSION) return true;
  return false;
}
async function recordClassification(admin, versionId, text) {
  const c = classify(text);
  const { data, error } = await admin.from('document_classifications').insert({
    document_version_id: versionId,
    privacy_class: c.privacy_class,
    contains_pii: c.contains_pii,
    contains_operational_security: c.contains_operational_security,
    contains_financial_data: c.contains_financial_data,
    contains_legal_privilege: c.contains_legal_privilege,
    classifier_source: 'bob',
    confidence: c.confidence,
    rationale: c.rationale
  }).select('*').single();
  if (error) {
    console.error('[bob-document-register] classification insert failed:', error.message);
    return null;
  }
  return data;
}
function recommendedDestination(privacyClass) {
  if (privacyClass === 'public' || privacyClass === 'internal_non_sensitive') {
    return 'propose_global_reference_pending_review';
  }
  if (privacyClass === 'tenant_sensitive') return 'tenant_reference';
  if (privacyClass === 'restricted') return 'tenant_scoped_restricted';
  return 'conversation_only';
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      error: 'Unauthorized'
    }, 401);
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: {
          Authorization: authHeader
        }
      }
    });
    const { data: { user }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !user) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id').eq('id', user.id).single();
    if (!profile || !CAN_REGISTER.has(String(profile.role))) {
      return json({
        error: 'Forbidden: admin/master/grand_master/admin_officer required'
      }, 403);
    }
    const isGM = String(profile.role) === 'grand_master';
    const body = await req.json();
    // Resolve object coordinates from the existing attachment row where possible.
    let bucket = body.storage_bucket ?? 'bob-uploads';
    let objectRef = body.storage_object_ref ?? '';
    let filename = body.original_filename ?? '';
    let mime = body.mime_type ?? '';
    let orgId = body.organization_id ?? null;
    let conversationId = body.conversation_id ?? null;
    if (body.attachment_id) {
      const { data: att, error: attErr } = await admin.from('bob_attachments').select('id, organization_id, conversation_id, file_name, file_type, storage_bucket, storage_path').eq('id', body.attachment_id).single();
      if (attErr || !att) return json({
        error: 'attachment_id not found'
      }, 404);
      bucket = att.storage_bucket;
      objectRef = att.storage_path;
      filename = att.file_name;
      mime = att.file_type;
      orgId = att.organization_id;
      conversationId = att.conversation_id;
    }
    if (!objectRef || !filename) {
      return json({
        error: 'Provide attachment_id, or storage_object_ref + original_filename'
      }, 400);
    }
    // Tenant isolation: non-GM callers may only act within their own org.
    if (!isGM && orgId && orgId !== profile.organization_id) {
      return json({
        error: 'Forbidden: cannot register a document outside your organization'
      }, 403);
    }
    // 1) Extract text + hash FIRST. The checksum is our content identity.
    let extractedText = '';
    let sha256 = null;
    let ocrRequired = false;
    let extractionConfidence = null;
    try {
      const extractResp = await fetch(`${SUPABASE_URL}/functions/v1/bob-extract-document`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader
        },
        body: JSON.stringify({
          storage_bucket: bucket,
          storage_path: objectRef,
          file_name: filename
        })
      });
      const extract = await extractResp.json();
      if (extract?.success) {
        extractedText = String(extract.table_text || extract.text || '');
        sha256 = extract.checksum ?? null;
        ocrRequired = !extract.has_text;
        extractionConfidence = extract.has_text ? 0.9 : 0.0;
      } else {
        ocrRequired = true;
      }
    } catch (e) {
      console.error('[bob-document-register] extraction failed:', e);
      ocrRequired = true;
    }
    // 2) Look up an existing canonical document by HASH within PERMITTED SCOPE.
    //    Permitted scope = caller's own-org tenant docs OR the approved global
    //    library. We deliberately never match another tenant's rows, so an
    //    identical file under another tenant stays invisible here.
    let canonical = null;
    let dedupHit = false;
    if (sha256) {
      const { data: candidates } = await admin.from('documents').select('id, organization_id, current_scope, original_filename').eq('sha256', sha256).in('current_scope', [
        'conversation_only',
        'tenant_reference',
        'tenant',
        'global_reference'
      ]).order('created_at', {
        ascending: true
      });
      const permitted = (candidates ?? []).filter((d)=>{
        if (d.current_scope === 'global_reference') return true; // approved global lib
        if (isGM) return true;
        return d.organization_id && d.organization_id === profile.organization_id; // own tenant only
      });
      // Prefer a global reference (deliberate shared exception) over a tenant copy.
      canonical = permitted.find((d)=>d.current_scope === 'global_reference') ?? permitted[0] ?? null;
      dedupHit = Boolean(canonical);
    }
    // 3) Create the canonical document if there was no in-scope match.
    if (!canonical) {
      const { data: doc, error: docErr } = await admin.from('documents').insert({
        attachment_id: body.attachment_id ?? null,
        storage_bucket: bucket,
        storage_object_ref: objectRef,
        original_filename: filename,
        mime_type: mime || 'application/octet-stream',
        sha256,
        uploaded_by: user.id,
        source_channel: 'chat_upload',
        conversation_id: conversationId,
        organization_id: orgId,
        current_scope: 'conversation_only'
      }).select('id, organization_id, current_scope').single();
      if (docErr || !doc) throw new Error(`documents insert failed: ${docErr?.message}`);
      canonical = doc;
    }
    // 4) Record the upload event — ALWAYS, even on a dedupe hit. Provenance for
    //    who/where/when attached this, independent of the canonical row.
    await admin.from('document_upload_events').insert({
      document_id: canonical.id,
      attachment_id: body.attachment_id ?? null,
      sha256: sha256 ?? 'unknown',
      original_filename: filename,
      mime_type: mime || null,
      uploaded_by: user.id,
      organization_id: orgId,
      conversation_id: conversationId,
      source_channel: 'chat_upload',
      was_deduplicated: dedupHit
    });
    // 5) Resolve the current version + its latest classification.
    let versionId = null;
    let existingClass = null;
    if (dedupHit) {
      const { data: ver } = await admin.from('document_versions').select('id').eq('document_id', canonical.id).order('created_at', {
        ascending: false
      }).limit(1).maybeSingle();
      versionId = ver?.id ?? null;
      if (versionId) {
        const { data: cls } = await admin.from('document_classifications').select('*').eq('document_version_id', versionId).order('created_at', {
          ascending: false
        }).limit(1).maybeSingle();
        existingClass = cls ?? null;
      }
    }
    // Create a version if none exists yet (new doc, or a legacy doc without one).
    if (!versionId) {
      const { data: version, error: verErr } = await admin.from('document_versions').insert({
        document_id: canonical.id,
        version_label: 'v1',
        extracted_text: extractedText || null,
        extraction_confidence: extractionConfidence,
        ocr_required: ocrRequired,
        metadata_json: {
          registered_by: user.id,
          classifier_model_version: CLASSIFIER_MODEL_VERSION
        }
      }).select('id').single();
      if (verErr || !version) throw new Error(`document_versions insert failed: ${verErr?.message}`);
      versionId = version.id;
    }
    if (versionId && extractedText.trim()) {
      const { error: refreshVersionError } = await admin.from('document_versions').update({ extracted_text: extractedText, extraction_confidence: extractionConfidence, ocr_required: ocrRequired, metadata_json: { registered_by: user.id, classifier_model_version: CLASSIFIER_MODEL_VERSION, refreshed_at: new Date().toISOString() } }).eq('id', versionId);
      if (refreshVersionError) throw new Error(`document_versions refresh failed: ${refreshVersionError.message}`);
    }
    // 6) Classify only when needed: new doc, or existing classification is
    //    missing / low-confidence / stale. Global-reference hits are trusted and
    //    skipped unless their metadata/classification is incomplete.
    let classification = existingClass;
    const wantClassify = body.classify !== false && extractedText.trim().length > 0;
    const reclassify = needsReclassification(existingClass);
    if (wantClassify && reclassify) {
      classification = await recordClassification(admin, versionId, extractedText);
    }
    const pc = classification?.privacy_class ?? null;
    return json({
      success: true,
      deduplicated: dedupHit,
      document_id: canonical.id,
      document_version_id: versionId,
      canonical_scope: canonical.current_scope,
      organization_id: canonical.organization_id,
      ocr_required: ocrRequired,
      has_text: Boolean(extractedText.trim()),
      reclassified: Boolean(wantClassify && reclassify),
      classification,
      recommended_destination: recommendedDestination(pc),
      note: dedupHit ? reclassify ? 'Recognised existing document by content hash; linked this upload and refreshed a stale/low-confidence classification.' : 'Recognised existing document by content hash; linked this upload and reused the existing classification. No duplicate copy stored.' : ocrRequired ? 'New document registered. No text extracted (likely scanned/image-based); needs OCR before reliable classification.' : 'New document registered, text stored, Bob classification proposal recorded. Human approval required before any shared-library promotion.'
    });
  } catch (err) {
    console.error('[bob-document-register] error:', err);
    return json({
      error: 'Document register failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
