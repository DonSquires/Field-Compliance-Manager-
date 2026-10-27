/**
 * bob-propose-zone-patrol-stop — governed producer: add a ZONE to a patrol route
 * as a stop (unified stop model, !709 Phase 1a).
 *
 * POST /functions/v1/bob-propose-zone-patrol-stop
 * Body: {
 *   zone_id,                 // EXPLICIT id (never a name)
 *   patrol_route_id,         // EXPLICIT id (never a name)
 *   modules: [ { module_key, is_required?, module_config?, display_order? }, ... ],
 *   schedule?: { active_days?, visits_per_shift?, min_gap_between_visits_minutes?,
 *                time_window_type?, window_start?, window_end?, dwell_minutes?,
 *                sla_arrive_within_minutes?, sla_depart_within_minutes?,
 *                preferred_stop_order?, officer_instructions? },
 *   reasoning?
 * }
 *
 * Files ONE pending create_zone_patrol_stop action; the executor performs the
 * writes on approve. Bob is the PROPOSER; a human approves in the bell.
 *
 * Identity discipline (bob_identity_resolution_across_orgs card): both the zone
 * and the route are taken as EXPLICIT ids and re-checked against the caller's
 * ownership tree; NEVER resolved by name. The executor re-checks org ownership
 * of both as defence in depth.
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
  'admin',
  'admin_officer'
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
const SCHEDULE_FIELDS = [
  'active_days',
  'visits_per_shift',
  'min_gap_between_visits_minutes',
  'time_window_type',
  'window_start',
  'window_end',
  'dwell_minutes',
  'sla_arrive_within_minutes',
  'sla_depart_within_minutes',
  'preferred_stop_order',
  'officer_instructions'
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
    const zoneId = (body.zone_id ?? '').trim();
    const patrolRouteId = (body.patrol_route_id ?? '').trim();
    const serviceAgreementLocationId = (body.service_agreement_location_id ?? '').trim();
    if (!zoneId || !UUID_RE.test(zoneId)) return json({
      error: 'zone_id is required and must be an explicit id (UUID), not a name'
    }, 400);
    if (!patrolRouteId || !UUID_RE.test(patrolRouteId)) return json({
      error: 'patrol_route_id is required and must be an explicit id (UUID), not a name'
    }, 400);
    if (!serviceAgreementLocationId || !UUID_RE.test(serviceAgreementLocationId)) return json({
      error: 'service_agreement_location_id is required — a zone patrol stop must name its authorising contract (owner ruling 2026-08-15, #328)'
    }, 400);
    const modules = Array.isArray(body.modules) ? body.modules : [];
    if (modules.length === 0) return json({
      error: 'modules must be a non-empty array (a stop carries one or more modules)'
    }, 400);
    // Resolve the owning org from the ZONE row (authoritative), then authorise the
    // caller against it — never trust a caller-supplied org.
    const { data: zone } = await admin.from('location_zones').select('id, organization_id').eq('id', zoneId).maybeSingle();
    if (!zone) return json({
      error: `zone_id ${zoneId} does not exist`
    }, 422);
    const orgId = String(zone.organization_id);
    // Confirm the route exists AND shares the zone's org (structural cross-org guard).
    const { data: route } = await admin.from('patrol_routes').select('id, organization_id').eq('id', patrolRouteId).maybeSingle();
    if (!route) return json({
      error: `patrol_route_id ${patrolRouteId} does not exist`
    }, 422);
    if (String(route.organization_id) !== orgId) {
      return json({
        error: 'patrol_route_id belongs to a different organization than the zone — resolve the correct route for this zone\'s organisation'
      }, 409);
    }
    // Authorise the caller for that org.
    const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
    let allowed = orgId === callerProfile.organization_id || authorizedOrgs.includes(orgId) || effectiveRole === 'grand_master';
    if (!allowed) {
      const { data: mtree } = await callerClient.rpc('is_master_for_org', {
        p_org_id: orgId
      });
      allowed = mtree === true;
    }
    if (!allowed) return json({
      error: 'Not authorised for the organisation that owns this zone/route'
    }, 403);
    const zpsPayload = {
      zone_id: zoneId,
      patrol_route_id: patrolRouteId,
      service_agreement_location_id: serviceAgreementLocationId,
      modules,
      triggered_by: caller.id
    };
    const schedule = body.schedule ?? {};
    for (const k of SCHEDULE_FIELDS){
      if (schedule[k] !== undefined && schedule[k] !== null) zpsPayload[k] = schedule[k];
    }
    const moduleKeys = modules.map((m)=>typeof m.module_key === 'string' ? m.module_key : '?').join(', ');
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes adding a zone to a patrol route as a stop with module(s): ${moduleKeys}.`;
    // Ledger: organization_id = CALLER'S home org (the bell the requesting user
    // sees); user_id = the requesting user. The zone/route ownership is in the
    // payload; the executor re-checks org from the zone row.
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const { data: action, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: String(callerProfile.organization_id),
      user_id: caller.id,
      action_type: 'create_zone_patrol_stop',
      context_table: 'client_site_patrol_config',
      proposed_payload: zpsPayload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      context_summary: typeof body.context_summary === 'string' ? body.context_summary : `Zone patrol stop: ${moduleKeys}`,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !action) {
      return json({
        error: 'Could not create the zone-patrol-stop action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: action.id,
      note: `Proposed (pending approval): add zone as a stop on the route with module(s): ${moduleKeys}. Approve it in the bell (with a reason).`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
