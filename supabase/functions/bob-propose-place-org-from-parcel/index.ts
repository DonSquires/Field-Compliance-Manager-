/**
 * bob-propose-place-org-from-parcel — governed producer for a PLACE-RECORD org.
 *
 * POST /functions/v1/bob-propose-place-org-from-parcel
 * Body: {
 *   name,                    // required; display name (usually the address)
 *   gps_lat, gps_lng,        // required; the resolved point
 *   parcel_polygon,          // required; GeoJSON geometry from LINZ boundary_for_point
 *   resolved_from_address?,  // the address entered (traceability)
 *   parcel_id?,              // LINZ parcel id, if available
 *   conversation_id?
 * }
 *
 * Creates the ACCOUNTABLE-PLACE org for a physical property (e.g. a noise
 * source residence) so evidence can anchor to a real org whose jurisdiction IS
 * its own LINZ parcel (recursive containment: the parcel org nests inside its
 * council's district by ST_Contains). See #19 / #226 and STAGING 2026-07-31.
 *
 * GOVERNANCE + AUTO-APPLY (owner ruling 2026-07-31):
 *   - JWT required; admin/master/grand_master (same as sibling producers).
 *   - Bob is the PROPOSER (BOB_SYSTEM_USER_ID); the triggering human is recorded
 *     in proposed_payload.triggered_by (provenance; never a service-account id).
 *   - Ad-hoc dispatch place-records AUTO-APPLY: there is no signed agreement to
 *     manage, the write is bounded + one-off + parcel-specific, and it is a
 *     RECORD not a tenant. So this files the action 'pending' then chains
 *     straight into bob-proposal-execute (service-role), which auto-approves
 *     create_place_org_from_parcel inline via its owner-ruled bypass list.
 *   - The real write (dedup + org create + jurisdiction stamp + read-back +
 *     rollback) lives ONLY in the executor — nothing is written here.
 *
 * Live-schema verified: bob_agentic_actions(organization_id, user_id,
 *   action_type, context_table, proposed_payload jsonb, status, bob_reasoning,
 *   conversation_id, context_summary).
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
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
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
        error: 'Forbidden: creating a place-record org requires admin, master, or grand_master'
      }, 403);
    }
    const body = await req.json();
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const lat = typeof body.gps_lat === 'number' ? body.gps_lat : null;
    const lng = typeof body.gps_lng === 'number' ? body.gps_lng : null;
    const parcelPolygon = body.parcel_polygon && typeof body.parcel_polygon === 'object' ? body.parcel_polygon : null;
    if (!name) return json({
      error: 'name is required'
    }, 400);
    if (lat === null || lng === null) return json({
      error: 'gps_lat and gps_lng are required (the resolved point)'
    }, 400);
    if (!parcelPolygon) return json({
      error: 'parcel_polygon (GeoJSON geometry from LINZ) is required — a place-record must anchor to a real parcel'
    }, 400);
    const proposedPayload = {
      name,
      gps_lat: lat,
      gps_lng: lng,
      parcel_polygon: parcelPolygon,
      triggered_by: caller.id
    };
    if (typeof body.resolved_from_address === 'string' && body.resolved_from_address.trim()) {
      proposedPayload.resolved_from_address = body.resolved_from_address.trim();
    }
    if (typeof body.parcel_id === 'string' && body.parcel_id.trim()) {
      proposedPayload.parcel_id = body.parcel_id.trim();
    }
    // Ledger organization_id = caller's home org (bell/audit scope). The created
    // place-record is own-rooted; its ownership is expressed by
    // parent_organization_id = null on the resulting org, not by this queue org.
    const queueOrgId = String(callerProfile.organization_id);
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const { data: action, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: queueOrgId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'create_place_org_from_parcel',
      context_table: 'organizations',
      proposed_payload: proposedPayload,
      status: 'pending',
      bob_reasoning: `Ad-hoc place-record org for '${name}' anchored to its LINZ parcel (auto-apply; evidence anchor).`,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      context_summary: `Place-record: ${name}`,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !action) {
      return json({
        error: 'Could not create the place-org action',
        details: insErr?.message
      }, 500);
    }
    // Auto-apply: chain straight into the executor (service-role). The executor
    // auto-approves create_place_org_from_parcel inline (owner-ruled bypass) and
    // performs the governed write (dedup + create + jurisdiction stamp +
    // read-back + rollback). Same apply-after-approve pattern as
    // bob-proposal-approver / bob-plan-step-advance.
    try {
      const execRes = await fetch(`${SUPABASE_URL}/functions/v1/bob-proposal-execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
        },
        body: JSON.stringify({
          action_id: action.id
        })
      });
      const execBody = await execRes.json().catch(()=>({}));
      if (execRes.ok && execBody.success) {
        return json({
          success: true,
          action_id: action.id,
          organization_id: execBody.result_record_id,
          deduped: execBody.deduped === true,
          note: execBody.note ?? 'Place-record org created (auto-applied).'
        });
      }
      // Executor reached but the write failed (e.g. jurisdiction stamp rolled
      // back). Surface loudly — the action row already carries status='failed'
      // + error_message from the executor.
      return json({
        success: false,
        action_id: action.id,
        error: execBody.error ?? 'Place-record creation failed during execution'
      }, 502);
    } catch (execErr) {
      return json({
        success: false,
        action_id: action.id,
        error: `Executor call failed: ${execErr instanceof Error ? execErr.message : 'unknown error'}`
      }, 502);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
