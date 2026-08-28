/**
 * bob-propose-client-root-org — governed producer for a NATIONAL client tenant.
 *
 * POST /functions/v1/bob-propose-client-root-org
 * Body: {
 *   client: { name, contact_email?, contact_phone?, billing_email?,
 *             billing_address?, account_notes? },
 *   reasoning?
 * }
 *
 * Creates a top-level CLIENT organisation with NO parent (a new tenant root,
 * e.g. LINZ). This is deliberately SEPARATE from bob-propose-client-onboarding /
 * create_client_org (which require a parent branch/provider): creating a tenant
 * ROOT is a rare, high-blast-radius act, so it carries a tighter role guard
 * (grand_master ONLY) and its own audit signature. See docs/BOB_MODULE_ONBOARDING.md.
 *
 * Governance (mirrors the other producers):
 *   - JWT; grand_master ONLY (stricter than admin/master onboarding).
 *   - Bob is the PROPOSER (BOB_SYSTEM_USER_ID); the triggering human is recorded
 *     in proposed_payload.triggered_by and approves the action in the bell.
 *   - Nothing is written to organizations here — only a PENDING ledger row.
 *     The real write happens on approve -> execute (create_client_root_org).
 *
 * Ledger organization_id = the caller's home org (the APPROVAL QUEUE / bell +
 * who may approve). The created tenant has no parent; ownership is expressed by
 * parent_organization_id = null on the resulting org, not by the queue org.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Tenant-root creation is owner-level only.
const CAN_PROPOSE = [
  'grand_master'
];
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CLIENT_OPTIONAL = [
  'contact_email',
  'contact_phone',
  'billing_email',
  'billing_address',
  'account_notes'
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
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id').eq('id', caller.id).single();
    if (!callerProfile || !CAN_PROPOSE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: creating a national client tenant requires grand_master'
      }, 403);
    }
    const body = await req.json();
    const client = body.client ?? {};
    const clientName = typeof client.name === 'string' ? client.name.trim() : '';
    if (!clientName) return json({
      error: 'client.name is required'
    }, 400);
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes creating national client tenant '${clientName}' (no parent; tenant root).`;
    const rootPayload = {
      name: clientName,
      is_national: true,
      triggered_by: caller.id
    };
    for (const k of CLIENT_OPTIONAL){
      if (typeof client[k] === 'string' && String(client[k]).trim()) rootPayload[k] = String(client[k]).trim();
    }
    // Ledger organization_id = caller's home org (approval queue / bell scope).
    const queueOrgId = String(callerProfile.organization_id);
    const { data: action, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: queueOrgId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'create_client_root_org',
      context_table: 'organizations',
      proposed_payload: rootPayload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null
    }).select('id').single();
    if (insErr || !action) {
      return json({
        error: 'Could not create the client-root action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: action.id,
      note: `Proposed (pending approval): create national client tenant '${clientName}'. Approve it in the bell; then add its branches under it.`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
