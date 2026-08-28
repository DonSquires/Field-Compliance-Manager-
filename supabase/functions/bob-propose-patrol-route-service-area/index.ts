/**
 * bob-propose-patrol-route-service-area — governed producer for "give this
 * patrol route its service-area geofence" (#19 Tier-2 geofence).
 *
 * POST /functions/v1/bob-propose-patrol-route-service-area
 * Body: {
 *   patrol_route_id,          // REQUIRED. The EXACT route id — this producer
 *                              // never resolves a route by name/code (see
 *                              // bob_identity_resolution_across_orgs).
 *   district_names,           // REQUIRED string[]. NZTA Territorial Authority
 *                              // district name(s), e.g. ["Nelson City"].
 *   despatch_zone_code?,      // default: the route's own route_code.
 *   name?,                    // default: "<route name> service area".
 *   module_key?,              // default: 'general_patrol'.
 *   reasoning?,
 * }
 *
 * WHY patrol_route_id is required and never resolved by name here:
 *   Two different organisations can legitimately run a same-named/coded route
 *   (e.g. two "587 Nelson Patrol" routes under different orgs). Resolving a
 *   route from a caller-typed label is exactly the trap
 *   bob_identity_resolution_across_orgs (0136) teaches Bob to avoid: if this
 *   producer is ever wired into a conversational flow, the caller (Bob) MUST
 *   resolve the exact route id himself (e.g. via list_routes filtered to the
 *   intended organisation, asking the human if more than one org has a match)
 *   BEFORE calling this endpoint. This endpoint only accepts an id, so the
 *   ambiguity cannot reach this far.
 *
 * Emits ONE pending `create_patrol_route_service_area` bob_agentic_actions row.
 * Nothing is written to location_zones/patrol_route_zones here — the human
 * approves in the bell, then bob-proposal-execute performs the governed insert.
 *
 * Governance mirrors bob-propose-patrol-route-assignment: JWT;
 * admin/master/grand_master; Bob is the proposer (BOB_SYSTEM_USER_ID); the
 * human is proposed_payload.triggered_by.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { validateTaNames } from '../_shared/ta-validation.ts';
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
    const { data: callerProfile } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids').eq('id', caller.id).single();
    if (!callerProfile || !CAN_PROPOSE.includes(callerProfile.role)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const patrolRouteId = typeof body.patrol_route_id === 'string' ? body.patrol_route_id.trim() : '';
    const districtNames = Array.isArray(body.district_names) ? body.district_names.map((d)=>String(d).trim()).filter(Boolean) : [];
    if (!patrolRouteId) {
      return json({
        error: 'patrol_route_id is required — the EXACT route id. Resolve it first (e.g. list_routes scoped to the intended organisation); do not pass a name or code.'
      }, 400);
    }
    if (districtNames.length === 0) {
      return json({
        error: 'district_names is required (a non-empty array of NZTA Territorial Authority names, e.g. ["Nelson City"])'
      }, 400);
    }
    // Phase 2 (epic #226): Validate TA names at PROPOSE time against the
    // canonical_ta_names table / live NZTA data. This makes 'New Zealand' /
    // 'Nelsen City' structurally impossible to even propose (stress tests
    // 9.1/9.2). The executor retains its own validation as defence-in-depth.
    //
    // First try the DB table (canonical_ta_names via validate_ta_names RPC),
    // then fall back to the live NZTA fetch if the table is empty.
    const proposalAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    try {
      const { data: dbValidation } = await proposalAdmin.rpc('validate_ta_names', {
        p_names: districtNames
      });
      const results = dbValidation ?? [];
      const invalid = results.filter((r)=>!r.valid);
      if (invalid.length > 0) {
        const first = invalid[0];
        const suggestStr = (first.suggestions ?? []).map((s)=>`'${s}'`).join(', ');
        return json({
          error: `'${first.name}' is not a valid NZ Territorial Authority name.${suggestStr ? ` Did you mean: ${suggestStr}?` : ''} Fix the district name and try again.`,
          invalid_names: invalid.map((r)=>({
              name: r.name,
              suggestions: r.suggestions
            }))
        }, 422);
      }
    } catch (dbErr) {
      // DB validation unavailable -- fall back to live NZTA validation
      console.warn('[propose-service-area] DB validate_ta_names failed, falling back to live NZTA:', dbErr instanceof Error ? dbErr.message : String(dbErr));
      const liveErr = await validateTaNames(districtNames);
      if (liveErr) {
        return json({
          error: liveErr
        }, 422);
      }
    }
    // ── Resolve the org FROM THE ROUTE ITSELF (never from a name/label) ──
    const { data: route } = await admin.from('patrol_routes').select('id, name, route_code, organization_id').eq('id', patrolRouteId).maybeSingle();
    if (!route) return json({
      error: `patrol_route_id ${patrolRouteId} does not exist`
    }, 422);
    const orgId = String(route.organization_id);
    // ── Authorise the caller against the ROUTE'S org (flat + grand_master;
    // mirrors bob-propose-patrol-route-assignment) ──
    const authorizedOrgs = callerProfile.authorized_organization_ids ?? [];
    const allowed = orgId === callerProfile.organization_id || authorizedOrgs.includes(orgId) || callerProfile.role === 'grand_master';
    if (!allowed) {
      return json({
        error: `Not authorised for the organisation that owns this patrol route (${orgId})`
      }, 403);
    }
    const payload = {
      patrol_route_id: patrolRouteId,
      district_names: districtNames,
      triggered_by: caller.id
    };
    if (typeof body.despatch_zone_code === 'string' && body.despatch_zone_code.trim()) payload.despatch_zone_code = body.despatch_zone_code.trim();
    if (typeof body.name === 'string' && body.name.trim()) payload.name = body.name.trim();
    if (typeof body.module_key === 'string' && body.module_key.trim()) payload.module_key = body.module_key.trim();
    const routeLabel = route.route_code ? `[${route.route_code}] ${route.name}` : String(route.name);
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes giving patrol route ${routeLabel} its service-area geofence from: ${districtNames.join(', ')}.`;
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    // conversation_id stamped for conversation-scoped reads (same as site-risk fix).
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const { data: act, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: orgId,
      user_id: BOB_SYSTEM_USER_ID,
      action_type: 'create_patrol_route_service_area',
      context_table: 'location_zones',
      proposed_payload: payload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: typeof body.conversation_id === 'string' ? body.conversation_id : null,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !act) {
      return json({
        error: 'Could not create the service-area action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: act.id,
      patrol_route: routeLabel,
      note: `Proposed (pending approval): give route ${routeLabel} a service-area geofence from ${districtNames.join(', ')}. Approve it in the bell to write the zone.`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
