/**
 * bob-promote-action — Layer 4.1 Phase 1.6: extraction -> approvable agentic action
 *
 * POST /functions/v1/bob-promote-action
 * Body: { attachment_id, action_type, organization_id?, client_organization_id? }
 *
 * Closes the FIRST link of the Bob loop: an extracted attachment becomes a
 * PENDING row in the canonical bob_agentic_actions ledger, which then flows
 * through the bell -> bob-proposal-approver -> bob-proposal-execute.
 *
 * Phase 1.6 supports one action_type: 'create_service_agreement_draft'.
 *
 * Provider-org resolution (owner rule):
 *   - If organization_id is supplied, it must be one the caller is authorised
 *     for (authorized_organization_ids or their own organization_id).
 *   - Else if the caller is SINGLE-org (authorized_organization_ids <= 1),
 *     default to the caller's organization_id.
 *   - Else (MULTI-org, none supplied) -> 409 'organization_required' so Bob /
 *     the UI prompts the user to pick the org. No guessing.
 *
 * Client-org: from client_organization_id, else best-effort resolve the
 *   extracted client name against organizations.name. If unresolved, the action
 *   is still created (pending) but proposed_payload.client_organization_id is
 *   left null — the executor's guard blocks apply until it is set (honest; no
 *   fabricated FK). The extracted name is kept in proposed_payload.client_name.
 *
 * Auth: JWT from admin/master/grand_master in the org.
 * Live-schema verified (2026-06-28): bob_attachments(organization_id, purpose,
 *   processing_state, extraction_summary, extraction_payload, confidence, ...);
 *   bob_agentic_actions(organization_id, user_id, action_type, context_table,
 *   proposed_payload, status, bob_reasoning, confidence_score, ...).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_PROMOTE = [
  'grand_master',
  'master',
  'admin'
];
const SUPPORTED_ACTIONS = new Set([
  'create_service_agreement_draft'
]);
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
    if (!callerProfile || !CAN_PROMOTE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const attachmentId = (body.attachment_id ?? '').trim();
    const actionType = (body.action_type ?? '').trim();
    if (!attachmentId) return json({
      error: 'attachment_id is required'
    }, 400);
    if (!SUPPORTED_ACTIONS.has(actionType)) {
      return json({
        error: `Unsupported action_type (Phase 1.6 supports: ${[
          ...SUPPORTED_ACTIONS
        ].join(', ')})`
      }, 422);
    }
    // ── Provider-org resolution (owner rule) ──
    const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
    const isMultiOrg = authorizedOrgs.length > 1;
    let providerOrgId = (body.organization_id ?? '').trim();
    if (providerOrgId) {
      const allowed = providerOrgId === callerProfile.organization_id || authorizedOrgs.includes(providerOrgId) || callerProfile.role === 'grand_master';
      if (!allowed) return json({
        error: 'Not authorised for the specified organization_id'
      }, 403);
    } else if (!isMultiOrg) {
      providerOrgId = String(callerProfile.organization_id);
    } else {
      return json({
        error: 'organization_required',
        message: 'You manage multiple organizations. Specify which organization this agreement belongs to.',
        authorized_organization_ids: authorizedOrgs
      }, 409);
    }
    if (!providerOrgId) return json({
      error: 'Could not resolve a provider organization'
    }, 422);
    // ── Load the extracted attachment ──
    const { data: att, error: attErr } = await admin.from('bob_attachments').select('id, organization_id, file_name, purpose, processing_state, extraction_summary, extraction_payload, confidence').eq('id', attachmentId).single();
    if (attErr || !att) return json({
      error: 'Attachment not found'
    }, 404);
    const payload = att.extraction_payload ?? {};
    const extractedName = typeof payload.name === 'string' ? payload.name : typeof payload.client_organization === 'string' ? payload.client_organization : '';
    const agreementName = typeof payload.service_type === 'string' ? `${payload.service_type} agreement${extractedName ? ` — ${extractedName}` : ''}` : extractedName ? `Service agreement — ${extractedName}` : `Service agreement (from ${att.file_name})`;
    // ── Client-org: explicit, else best-effort resolve by name (never fabricate) ──
    let clientOrgId = (body.client_organization_id ?? '').trim() || null;
    if (!clientOrgId && extractedName) {
      const { data: match } = await admin.from('organizations').select('id').ilike('name', extractedName).maybeSingle();
      if (match?.id) clientOrgId = String(match.id);
    }
    const proposedPayload = {
      name: agreementName,
      client_organization_id: clientOrgId,
      client_name: extractedName || null,
      source_attachment_id: att.id
    };
    if (typeof payload.monthly_report_template_code === 'string') {
      proposedPayload.monthly_report_template_code = payload.monthly_report_template_code;
    }
    // Bob is the PROPOSER (not the human who triggered it); the human approves.
    // This keeps the approver free of a self-approval conflict and works for
    // single-admin orgs. The triggering human is recorded for audit.
    const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
    proposedPayload.triggered_by = caller.id;
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const { data: created, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: providerOrgId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'create_service_agreement_draft',
      context_table: 'service_agreements',
      proposed_payload: proposedPayload,
      status: 'pending',
      bob_reasoning: att.extraction_summary ?? 'Draft service agreement from an uploaded document.',
      confidence_score: typeof att.confidence === 'number' ? att.confidence : null,
      idempotency_key: idempotencyKey
    }).select('id, status').single();
    if (insErr || !created) {
      return json({
        error: 'Could not create agentic action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: created.id,
      status: created.status,
      client_resolved: Boolean(clientOrgId),
      note: clientOrgId ? 'Pending approval. Approve in the notifications bell, then it can be executed.' : 'Pending approval. The client organisation could not be resolved — set it before executing.'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
