/**
 * bob-propose-patrol-route-assignment — governed producer for "add a site to a
 * patrol route" (the Morrison Square chore's third step).
 *
 * POST /functions/v1/bob-propose-patrol-route-assignment
 * Body: {
 *   site_id?,                 // the client site (direct), OR
 *   parent_action_id?,        // a create_client_site action to read the site id from
 *   patrol_route_id,          // the route to put the site on (must exist under the org)
 *   organization_id?,         // owning provider/branch org; resolved like the other producers
 *   module_key?,              // default 'general_patrol'
 *   active_days?,             // int[] 1=Mon..7=Sun; default every day
 *   visits_per_shift?,        // default 1
 *   min_gap_between_visits_minutes?,
 *   time_window_type?,        // 'fixed' | 'sunrise_sunset' | 'seasonal'; default 'fixed'
 *   window_start?, window_end?,   // 'HH:MM' when fixed
 *   dwell_minutes?, sla_arrive_within_minutes?, sla_depart_within_minutes?,
 *   preferred_stop_order?,
 *   officer_instructions?,
 *   required_actions?,        // string[] e.g. ["check_signage","photograph_area"]
 *   reasoning?
 * }
 *
 * Emits ONE pending `create_patrol_route_assignment` bob_agentic_actions row.
 * Nothing is written to client_site_patrol_config here — the human approves in
 * the bell, then bob-proposal-execute performs the governed insert.
 *
 * The site→route link IS client_site_patrol_config.patrol_route_id (validated
 * against SitePatrolConfigPanel.tsx + PatrolRoutesPage.tsx + migration 0030).
 * The geofence/service area is NOT the link.
 *
 * Governance mirrors bob-propose-client-onboarding: JWT; admin/master/grand_master;
 * Bob is the proposer (BOB_SYSTEM_USER_ID); the human is proposed_payload.triggered_by.
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
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
// Owner elevation: mirrors the conductor's OWNER_EMAILS set so the downstream
// permission check is consistent with what the conductor already advertised as
// available (#125, same class as #107).
const OWNER_EMAILS = new Set([
  'don.squires@firstsecurity.co.nz',
  'squires.don@live.com',
  'squires.don@gmail.com'
]);
// module_key CHECK values from migration 0030 (client_site_patrol_config).
const MODULE_KEYS = new Set([
  'freedom_camping',
  'parking_enforcement',
  'noise_control',
  'biosecurity',
  'smoke_complaints',
  'static_guarding',
  'access_control',
  'ems',
  'alarm_response',
  'welfare_check',
  'general_patrol'
]);
const TIME_WINDOW_TYPES = new Set([
  'fixed',
  'sunrise_sunset',
  'seasonal'
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
    const siteId = typeof body.site_id === 'string' ? body.site_id.trim() : '';
    const parentActionId = typeof body.parent_action_id === 'string' ? body.parent_action_id.trim() : '';
    const patrolRouteId = typeof body.patrol_route_id === 'string' ? body.patrol_route_id.trim() : '';
    if (!siteId && !parentActionId) {
      return json({
        error: 'site_id (or parent_action_id pointing at a create_client_site action) is required'
      }, 400);
    }
    if (!patrolRouteId) {
      return json({
        error: 'patrol_route_id is required (the route to add the site to). Look up the branch\'s routes and pass the chosen route id.'
      }, 400);
    }
    const moduleKey = typeof body.module_key === 'string' && body.module_key.trim() ? body.module_key.trim() : 'general_patrol';
    if (!MODULE_KEYS.has(moduleKey)) {
      return json({
        error: `module_key '${moduleKey}' is not valid (allowed: ${[
          ...MODULE_KEYS
        ].join(', ')})`
      }, 400);
    }
    const timeWindowType = typeof body.time_window_type === 'string' && body.time_window_type.trim() ? body.time_window_type.trim() : 'fixed';
    if (!TIME_WINDOW_TYPES.has(timeWindowType)) {
      return json({
        error: `time_window_type '${timeWindowType}' is not valid (allowed: ${[
          ...TIME_WINDOW_TYPES
        ].join(', ')})`
      }, 400);
    }
    // ── Resolve the owning org (same rule as the other producers) ──
    const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
    const isMultiOrg = authorizedOrgs.length > 1;
    let orgId = typeof body.organization_id === 'string' ? body.organization_id.trim() : '';
    if (orgId) {
      const allowed = orgId === callerProfile.organization_id || authorizedOrgs.includes(orgId) || effectiveRole === 'grand_master';
      if (!allowed) return json({
        error: 'Not authorised for the specified organization_id'
      }, 403);
    } else if (!isMultiOrg) {
      orgId = String(callerProfile.organization_id);
    } else {
      return json({
        error: 'organization_required',
        message: 'You manage multiple organizations. Specify which org owns this patrol route/site.',
        authorized_organization_ids: authorizedOrgs
      }, 409);
    }
    if (!orgId) return json({
      error: 'Could not resolve an organization'
    }, 422);
    // Confirm the patrol route exists under this org (the site→route link target).
    const { data: route } = await admin.from('patrol_routes').select('id, name, route_code, organization_id').eq('id', patrolRouteId).maybeSingle();
    if (!route) return json({
      error: `patrol_route_id ${patrolRouteId} does not exist`
    }, 422);
    if (String(route.organization_id) !== orgId) {
      return json({
        error: 'patrol_route_id belongs to a different organization than the one resolved for this assignment'
      }, 422);
    }
    // Build the schedule payload (only pass through provided values; the executor
    // + DB defaults fill the rest). Numeric/array coercion is defensive.
    const payload = {
      patrol_route_id: patrolRouteId,
      module_key: moduleKey,
      time_window_type: timeWindowType,
      triggered_by: caller.id
    };
    if (siteId) payload.site_id = siteId;
    if (parentActionId) payload.parent_action_id = parentActionId;
    if (Array.isArray(body.active_days)) payload.active_days = body.active_days.map((d)=>Number(d)).filter((n)=>Number.isInteger(n) && n >= 1 && n <= 7);
    if (body.visits_per_shift != null) payload.visits_per_shift = Number(body.visits_per_shift);
    if (body.min_gap_between_visits_minutes != null) payload.min_gap_between_visits_minutes = Number(body.min_gap_between_visits_minutes);
    if (timeWindowType === 'fixed') {
      if (typeof body.window_start === 'string' && body.window_start.trim()) payload.window_start = body.window_start.trim();
      if (typeof body.window_end === 'string' && body.window_end.trim()) payload.window_end = body.window_end.trim();
    }
    if (body.dwell_minutes != null) payload.dwell_minutes = Number(body.dwell_minutes);
    if (body.sla_arrive_within_minutes != null) payload.sla_arrive_within_minutes = Number(body.sla_arrive_within_minutes);
    if (body.sla_depart_within_minutes != null) payload.sla_depart_within_minutes = Number(body.sla_depart_within_minutes);
    if (body.preferred_stop_order != null) payload.preferred_stop_order = Number(body.preferred_stop_order);
    if (typeof body.officer_instructions === 'string' && body.officer_instructions.trim()) payload.officer_instructions = body.officer_instructions.trim();
    if (Array.isArray(body.required_actions)) payload.required_actions = body.required_actions.map((a)=>String(a)).filter(Boolean);
    const routeLabel = route.route_code ? `[${route.route_code}] ${route.name}` : String(route.name);
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes adding the site to patrol route ${routeLabel} (${moduleKey}), parent-first.`;
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const { data: act, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: orgId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'create_patrol_route_assignment',
      context_table: 'client_site_patrol_config',
      proposed_payload: payload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      context_summary: typeof body.context_summary === 'string' ? body.context_summary : `Patrol route assignment: ${routeLabel}`,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !act) {
      return json({
        error: 'Could not create the patrol-route-assignment action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: act.id,
      patrol_route: routeLabel,
      note: `Proposed (pending approval): add the site to patrol route ${routeLabel}. ` + (parentActionId ? 'It waits for the site to be created first. ' : '') + 'Approve it in the bell to write the schedule.'
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
