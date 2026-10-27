/**
 * bob-perceive-image — unified image perception (OCR + vision) for Bob
 *
 * Purpose:
 *   Give Bob one call to "observe" an image: extract text (OCR) and a vision
 *   description/observations, with provenance. Wraps the existing inference
 *   service (bob-inference) actions rather than duplicating model logic.
 *
 * Evidence-safe: never mutates the source image; advisory only.
 *
 * Auth:
 *   Supabase JWT required. Caller must be admin/master/grand_master/admin_officer/officer.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const BOB_INFERENCE_URL = Deno.env.get('BOB_INFERENCE_URL') ?? '';
const BOB_INFERENCE_SECRET = Deno.env.get('BOB_INFERENCE_SECRET') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PERCEIVE = new Set([
  'grand_master',
  'master',
  'admin',
  'admin_officer',
  'officer'
]);
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
async function callInference(action: string, payload: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, any> }> {
  const res = await fetch(BOB_INFERENCE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bob-Secret': BOB_INFERENCE_SECRET
    },
    body: JSON.stringify({
      action,
      ...payload
    })
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch  {
    data = {
      raw: text.slice(0, 500)
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    data
  };
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
    const { data: profile } = await admin.from('user_profiles').select('id, role, organization_id, deactivated_at').eq('id', user.id).single();
    if (!profile || profile.deactivated_at || !CAN_PERCEIVE.has(String(profile.role))) {
      return json({
        error: 'Forbidden: insufficient role for image perception'
      }, 403);
    }
    if (!BOB_INFERENCE_URL || !BOB_INFERENCE_SECRET) {
      return json({
        error: 'inference_not_configured',
        message: 'BOB_INFERENCE_URL/SECRET are not set.'
      }, 503);
    }
    const body = await req.json();
    const attachmentId = String(body.attachment_id ?? '').trim();
    if (!attachmentId) return json({
      error: 'attachment_id is required'
    }, 400);
    const incidentMode = body.mode === 'incident_identity_document';
    const submissionMode = body.mode === 'person_identity_submission';
    const attachmentClient = incidentMode || submissionMode ? admin : callerClient;
    const { data: att } = await attachmentClient.from('bob_attachments').select('id, organization_id, uploaded_by, file_name, purpose, storage_bucket, storage_path, extraction_payload').eq('id', attachmentId).maybeSingle();
    if (!att) return json({
      error: 'Attachment not found'
    }, 404);
    if (att.uploaded_by !== user.id) return json({ error: 'Attachment belongs to another user' }, 403);
    if (body.mode === 'identity_document' || incidentMode || submissionMode) {
      if (!incidentMode && !submissionMode && !['grand_master', 'master', 'admin', 'admin_officer'].includes(String(profile.role))) {
        return json({ error: 'Forbidden: administrator identity review required' }, 403);
      }
      const personRecordId = String(body.person_record_id ?? '').trim();
      const organizationId = String(body.organization_id ?? att.organization_id ?? '').trim();
      const documentKind = String(body.document_kind ?? '').trim();
      const incidentId = incidentMode ? String(body.incident_id ?? att.extraction_payload?.incident_id ?? '').trim() : '';
      const expectedPrefix = incidentMode
        ? `org/${organizationId}/identity/${user.id}/incident-${incidentId}/`
        : submissionMode
          ? `org/${organizationId}/identity/${user.id}/submission-${personRecordId}/`
          : `org/${organizationId}/identity/${user.id}/`;
      if (!personRecordId || !organizationId || !documentKind || att.organization_id !== organizationId) {
        return json({ error: 'Identity document organization, person, and kind are required' }, 400);
      }
      if (att.purpose !== 'identity_document' || att.storage_bucket !== 'identity-evidence' || !att.storage_path.startsWith(expectedPrefix)) {
        return json({ error: 'Identity attachment is outside the governed private intake path' }, 400);
      }
      if (incidentMode) {
        const { data: canRecord } = await callerClient.rpc('can_record_incident_person', { p_incident_id: incidentId, p_actor: user.id });
        const payloadPerson = String(att.extraction_payload?.person_record_id ?? '');
        if (!incidentId || canRecord !== true || payloadPerson !== personRecordId || String(att.extraction_payload?.document_kind ?? '') !== documentKind) {
          return json({ error: 'Forbidden: assigned incident identity context required' }, 403);
        }
        const { data: incidentLink } = await admin.from('incident_person_links').select('id').eq('incident_id', incidentId).eq('person_record_id', personRecordId).maybeSingle();
        if (!incidentLink) return json({ error: 'Record the person on the incident before adding identity evidence' }, 400);
      } else if (submissionMode) {
        // Any member may submit evidence for a person they can see; an administrator still approves it.
        const payload = att.extraction_payload ?? {};
        if (String(payload.capture_authority ?? '') !== 'member_submission'
          || String(payload.person_record_id ?? '') !== personRecordId
          || String(payload.document_kind ?? '') !== documentKind) {
          return json({ error: 'Forbidden: identity submission context does not match' }, 403);
        }
        const { data: visiblePerson } = await callerClient.from('person_records').select('id, organization_id').eq('id', personRecordId).maybeSingle();
        if (!visiblePerson || visiblePerson.organization_id !== organizationId) {
          return json({ error: 'Forbidden: this person is not visible to you' }, 403);
        }
      } else {
        const { data: canAdminister } = await callerClient.rpc('is_admin_for_org', { target_org_id: organizationId });
        if (!canAdminister) return json({ error: 'Forbidden: administrator access to this organization is required' }, 403);
      }
      const inference = await callInference('identity_document', {
        attachment_id: att.id,
        organization_id: organizationId,
        actor_id: user.id,
        document_kind: documentKind,
      });
      if (!inference.ok || !inference.data?.success) return json({ error: 'Identity document perception failed', detail: inference.data }, 502);
      const image = inference.data.image ?? {};
      const proposedFields = {
        ...(inference.data.proposed_fields ?? {}),
        document_classification: inference.data.classification ?? null,
        document_definition: inference.data.document_definition ?? null,
      };
      const { data: proposal, error: proposalError } = await admin.rpc('register_deterministic_identity_document_proposal', {
        p_actor_user_id: user.id,
        p_organization_id: organizationId,
        p_person_record_id: personRecordId,
        p_attachment_id: att.id,
        p_document_kind: documentKind,
        p_sha256: inference.data.sha256,
        p_proposed_fields: proposedFields,
        p_face_embedding: image.face_embedding ?? null,
        p_face_confidence: image.face_confidence ?? null,
        p_face_count: image.face_count ?? 0,
      });
      if (proposalError) return json({ error: proposalError.message }, 400);
      if (incidentMode) {
        const identityDocumentId = proposal?.identity_document_id;
        const { error: incidentProposalError } = await admin.rpc('attach_incident_identity_proposal', {
          p_actor_user_id: user.id,
          p_incident_id: incidentId,
          p_person_record_id: personRecordId,
          p_identity_document_id: identityDocumentId,
        });
        if (incidentProposalError) return json({ error: incidentProposalError.message }, 400);
      }
      return json({
        success: true,
        proposal,
        document_kind: documentKind,
        proposed_fields: proposedFields,
        ocr: inference.data.ocr ?? {},
        face: { count: image.face_count ?? 0, candidate_ready_after_approval: Boolean(image.face_count === 1 && image.face_embedding) },
        authority: 'provisional',
        review_required: true,
      });
    }
    const wantOcr = body.want_ocr !== false;
    const wantVision = body.want_vision !== false;
    const result: Record<string, any> = {
      success: true,
      attachment_id: att.id,
      file_name: att.file_name,
      provenance: {
        storage_path: att.storage_path,
        organization_id: att.organization_id
      },
      advisory: true
    };
    if (wantVision) {
      const vision = await callInference('describe_image', {
        attachment_id: att.id,
        question: body.question ?? ''
      });
      result.vision = vision.ok ? vision.data.vision ?? vision.data : {
        error: `vision_failed_${vision.status}`
      };
    }
    if (wantOcr) {
      const ocr = await callInference('ocr_image', {
        attachment_id: att.id
      });
      result.ocr = ocr.ok ? ocr.data.ocr ?? ocr.data.text ?? ocr.data : {
        error: `ocr_failed_${ocr.status}`,
        note: 'If OCR action is unavailable in inference, add ocr_image support server-side.'
      };
    }
    result.note = 'Advisory perception only. Original image is unchanged. Verify text/observations before acting.';
    result.audit = {
      actor_id: user.id,
      role: profile.role
    };
    return json(result);
  } catch (err) {
    console.error('[bob-perceive-image] error:', err);
    return json({
      error: 'Image perception failed',
      detail: err instanceof Error ? err.message : String(err)
    }, 500);
  }
});
