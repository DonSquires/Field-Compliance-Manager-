/**
 * bob-propose-freedom-camping-org-strategy — governed producer for a
 * council's Freedom Camping policy setup, derived from a reviewed bylaw
 * extraction (upload or URL — see bob-fetch-bylaw-source).
 *
 * POST /functions/v1/bob-propose-freedom-camping-org-strategy
 * Body: {
 *   organization_id,              // the council/client org this strategy applies to
 *   settings?: {                  // -> freedom_camping_org_settings (0191)
 *     verification_mode?, enforcement_ladder_mode?,
 *     movement_similarity_threshold?, default_authorising_act?,
 *     default_issuing_authority?, show_homeless_exempt_kpi?, notes?
 *   },
 *   zone_updates?: [{              // -> location_zones + zone_compliance_matrix
 *     zone_id,                     // MUST be an explicit existing zone id — never a name
 *     rule_type?,                  // 'prohibited' | 'restricted' | 'unrestricted'
 *     scv_exempts_restriction?,
 *     max_consecutive_nights?, max_nights_per_month?, scv_required?,
 *   }],
 *   source_attachment_id?,        // the bob_attachments row this was extracted from (audit trail)
 *   reasoning?, conversation_id?, context_summary?
 * }
 *
 * Files ONE pending propose_freedom_camping_org_strategy action; the executor
 * performs the real writes on approve. Bob is the PROPOSER; a human reviews
 * the extracted draft (amending zone-by-zone if needed — see #87 for the
 * planned structured review UI) and approves in the bell. Per
 * docs/BOB_DOCUMENT_INTELLIGENCE_RUNBOOK.md: Bob never edits bylaw-derived
 * config directly — a misread rule_type has real enforcement consequences.
 *
 * Identity discipline (bob_identity_resolution_across_orgs card): the target
 * org is an EXPLICIT id, authorised against the caller's ownership tree
 * (is_master_for_org) — never resolved by name. zone_updates.zone_id is
 * likewise always an explicit id; the executor re-validates each zone
 * belongs to organization_id before writing anything.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PROPOSE = [
  'grand_master',
  'master',
  'admin'
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Owner elevation: mirrors the conductor's OWNER_EMAILS set so the downstream
// permission check is consistent with what the conductor already advertised as
// available (#125, same class as #107).
const OWNER_EMAILS = new Set([
  'don.squires@firstsecurity.co.nz',
  'squires.don@live.com',
  'squires.don@gmail.com'
]);
const SETTINGS_FIELDS = [
  'verification_mode',
  'enforcement_ladder_mode',
  'movement_similarity_threshold',
  'default_authorising_act',
  'default_issuing_authority',
  'show_homeless_exempt_kpi',
  'notes'
];
const ZONE_UPDATE_FIELDS = [
  'rule_type',
  'scv_exempts_restriction',
  'max_consecutive_nights',
  'max_nights_per_month',
  'scv_required'
];
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  const json = (body, status = 200)=>new Response(JSON.stringify(body), {
      status,
      headers: {
        ...CORS,
        'Content-Type': 'application/json'
      }
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
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) return json({
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids').eq('id', caller.id).single();
    // Owner elevation: mirrors the conductor (#125, same class as #107).
    const callerEmail = (caller.email ?? '').toLowerCase().trim();
    const effectiveRole = OWNER_EMAILS.has(callerEmail) ? 'grand_master' : callerProfile?.role ?? '';
    if (!callerProfile || !CAN_PROPOSE.includes(effectiveRole)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const targetOrgId = (body.organization_id ?? '').trim();
    if (!targetOrgId) return json({
      error: 'organization_id is required (the council/client org this strategy applies to)'
    }, 400);
    if (!UUID_RE.test(targetOrgId)) return json({
      error: 'organization_id must be an explicit org id (UUID), not a name'
    }, 400);
    const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
    let allowed = targetOrgId === callerProfile.organization_id || authorizedOrgs.includes(targetOrgId) || effectiveRole === 'grand_master';
    if (!allowed) {
      const { data: mtree } = await callerClient.rpc('is_master_for_org', {
        p_org_id: targetOrgId
      });
      allowed = mtree === true;
    }
    if (!allowed) return json({
      error: 'Not authorised for the specified organization_id'
    }, 403);
    const { data: org } = await admin.from('organizations').select('id').eq('id', targetOrgId).maybeSingle();
    if (!org) return json({
      error: `organization_id ${targetOrgId} does not exist`
    }, 422);
    const settingsIn = body.settings && typeof body.settings === 'object' ? body.settings : {};
    const settingsPayload = {};
    for (const k of SETTINGS_FIELDS){
      if (settingsIn[k] !== undefined && settingsIn[k] !== null) settingsPayload[k] = settingsIn[k];
    }
    const rawZoneUpdates = Array.isArray(body.zone_updates) ? body.zone_updates : [];
    const zoneUpdates = [];
    for (const zu of rawZoneUpdates){
      const zoneId = typeof zu.zone_id === 'string' ? zu.zone_id.trim() : '';
      if (!zoneId) return json({
        error: 'Every zone_updates entry requires an explicit zone_id (never a name)'
      }, 400);
      if (!UUID_RE.test(zoneId)) return json({
        error: `zone_updates.zone_id '${zoneId}' must be a UUID`
      }, 400);
      const entry = {
        zone_id: zoneId
      };
      for (const k of ZONE_UPDATE_FIELDS){
        if (zu[k] !== undefined && zu[k] !== null) entry[k] = zu[k];
      }
      zoneUpdates.push(entry);
    }
    if (!Object.keys(settingsPayload).length && !zoneUpdates.length) {
      return json({
        error: 'Nothing to propose: supply settings and/or zone_updates extracted from the bylaw'
      }, 400);
    }
    const sourceAttachmentId = typeof body.source_attachment_id === 'string' && body.source_attachment_id.trim() ? body.source_attachment_id.trim() : null;
    if (sourceAttachmentId && !UUID_RE.test(sourceAttachmentId)) {
      return json({
        error: 'source_attachment_id must be a UUID'
      }, 400);
    }
    const payload = {
      organization_id: targetOrgId,
      triggered_by: caller.id,
      settings: settingsPayload,
      zone_updates: zoneUpdates
    };
    if (sourceAttachmentId) payload.source_attachment_id = sourceAttachmentId;
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes a Freedom Camping policy strategy from a reviewed bylaw extraction: ${Object.keys(settingsPayload).length} org setting(s), ${zoneUpdates.length} zone update(s).`;
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id.trim() ? body.conversation_id.trim() : null;
    const contextSummary = typeof body.context_summary === 'string' && body.context_summary.trim() ? body.context_summary.trim() : 'Freedom Camping org strategy (bylaw-derived)';
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const queueOrgId = String(callerProfile.organization_id);
    const { data: action, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: queueOrgId,
      user_id: caller.id,
      action_type: 'propose_freedom_camping_org_strategy',
      context_table: 'freedom_camping_org_settings',
      proposed_payload: payload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: conversationId,
      context_summary: contextSummary,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !action) {
      return json({
        error: 'Could not create the org-strategy action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: action.id,
      note: `Proposed (pending approval): Freedom Camping policy strategy for this council — ${Object.keys(settingsPayload).length} setting(s), ${zoneUpdates.length} zone update(s). Review carefully in the bell before approving: a misread rule classification (prohibited/restricted/unrestricted) has real enforcement consequences.`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
