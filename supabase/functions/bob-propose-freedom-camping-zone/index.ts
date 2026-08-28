/**
 * bob-propose-freedom-camping-zone — governed producer for an FC enforcement zone.
 *
 * POST /functions/v1/bob-propose-freedom-camping-zone
 * Body: {
 *   organization_id,                    // zone owner (client branch, e.g. LINZ-Otago)
 *   site_id?,                           // optional link to a client site
 *   zone: {
 *     name,                             // required
 *     boundary?,                        // GeoJSON polygon, SRID 4326 (BOB-RESOLVED, preferred)
 *     gps_lat?, gps_lng?, provisional_radius_m?,
 *     nightly_limit_consecutive?, nightly_limit_monthly?, scv_required?,
 *     allowed_vehicle_types?, max_nights_per_year?,
 *     no_camping_start_time?, no_camping_end_time?,
 *     restricted_from_date?, restricted_to_date?,
 *     bylaw_clause?, bylaw_source_url?, despatch_zone_code?,
 *     address?, suburb?, postcode?,
 *     legal?
 *   },
 *   reasoning?
 * }
 *
 * Files ONE pending create_freedom_camping_zone action; the executor performs
 * the real writes on approve. Bob is the PROPOSER; a human approves in the bell.
 *
 * Identity discipline (bob_identity_resolution_across_orgs card): the owning org
 * is taken as an EXPLICIT id and authorised against the caller's ownership tree
 * (is_master_for_org) — never resolved by name. Geometry is BOB'S resolved
 * decision (LINZ->Google), supplied in zone.boundary; the producer never
 * auto-resolves geometry (that would let a helper do Bob's reasoning).
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveEffectiveRole, CAN_PROPOSE } from '../_shared/auth.ts';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
// Pillar C (#138): CAN_PROPOSE, OWNER_EMAILS, resolveEffectiveRole imported
// from _shared/auth.ts (single source of truth). Eliminates the inline
// duplication that caused #125 (permission-envelope mismatch).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Zone fields forwarded verbatim to the executor payload.
const ZONE_FIELDS = [
  'name',
  'boundary',
  'gps_lat',
  'gps_lng',
  'provisional_radius_m',
  'nightly_limit_consecutive',
  'nightly_limit_monthly',
  'scv_required',
  'allowed_vehicle_types',
  'max_nights_per_year',
  'no_camping_start_time',
  'no_camping_end_time',
  'restricted_from_date',
  'restricted_to_date',
  'bylaw_clause',
  'bylaw_source_url',
  'despatch_zone_code',
  'address',
  'suburb',
  'postcode',
  'legal'
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
    // Owner elevation: Pillar C (#138) — resolveEffectiveRole from _shared/auth.ts.
    // If the caller is a platform owner, treat as grand_master regardless of the
    // stored role — consistent with the conductor's own elevation (#125).
    const callerEmail = (caller.email ?? '').toLowerCase().trim();
    const effectiveRole = resolveEffectiveRole(callerEmail, callerProfile?.role ?? '');
    if (!callerProfile || !CAN_PROPOSE.has(effectiveRole)) {
      return json({
        error: 'Forbidden: insufficient role'
      }, 403);
    }
    const body = await req.json();
    const zone = body.zone ?? {};
    const zoneName = typeof zone.name === 'string' ? zone.name.trim() : '';
    if (!zoneName) return json({
      error: 'zone.name is required'
    }, 400);
    // Owning org: EXPLICIT id only (identity discipline — never a name here).
    const targetOrgId = (body.organization_id ?? '').trim();
    if (!targetOrgId) return json({
      error: 'organization_id is required (the zone-owning client org id)'
    }, 400);
    if (!UUID_RE.test(targetOrgId)) return json({
      error: 'organization_id must be an explicit org id (UUID), not a name'
    }, 400);
    // Authorise the caller for that org: own home org, mirrored operates-at list,
    // grand_master, or master-of-tree (is_master_for_org keys off auth.uid(), so
    // call it on the JWT client, not the service-role admin client).
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
    // Confirm the org exists.
    const { data: org } = await admin.from('organizations').select('id').eq('id', targetOrgId).maybeSingle();
    if (!org) return json({
      error: `organization_id ${targetOrgId} does not exist`
    }, 422);
    // Optional site link — explicit id; the executor re-checks org membership.
    const siteId = (body.site_id ?? '').trim();
    if (siteId && !UUID_RE.test(siteId)) return json({
      error: 'site_id must be a UUID'
    }, 400);
    // Build the executor payload from the zone fields Bob resolved.
    const zonePayload = {
      organization_id: targetOrgId,
      triggered_by: caller.id
    };
    if (siteId) zonePayload.site_id = siteId;
    for (const k of ZONE_FIELDS){
      if (zone[k] !== undefined && zone[k] !== null) zonePayload[k] = zone[k];
    }
    // Surface the REAL area (m^2) plainly, at PROPOSE time -- before any
    // human approves in the bell. A geofence is a domain-blind boundary
    // (this app's trigger shape for whatever rules attach to it later); this
    // is NOT an area gate. The point is visibility: a human judging whether
    // this shape makes sense for the named place needs the actual number,
    // not a pass/fail verdict from a hardcoded zone_type band. Best-effort --
    // never blocks filing the proposal if the calc fails for any reason.
    let areaM2 = null;
    if (zonePayload.boundary) {
      const { data: areaResult } = await admin.rpc('geometry_area_m2', {
        p_geojson: zonePayload.boundary
      });
      if (typeof areaResult === 'number' && isFinite(areaResult)) areaM2 = areaResult;
    }
    const areaLabel = areaM2 !== null ? ` (~${Math.round(areaM2).toLocaleString()} m^2)` : '';
    const reasoning = typeof body.reasoning === 'string' && body.reasoning.trim() ? body.reasoning.trim() : `Bob proposes a freedom-camping zone '${zoneName}'${areaLabel} with a resolved geofence + compliance limits. Review the shape against the named place before approving -- there is no automatic area check.`;
    const conversationId = typeof body.conversation_id === 'string' && body.conversation_id.trim() ? body.conversation_id.trim() : null;
    const contextSummary = typeof body.context_summary === 'string' && body.context_summary.trim() ? body.context_summary.trim() : `Freedom-camping zone: ${zoneName}${areaLabel}`;
    // Ledger: organization_id = CALLER'S home org (the bell/approval queue the
    // requesting user sees); user_id = the requesting user (not BOB_SYSTEM_USER_ID
    // — the action must appear in the REQUESTING USER'S bell, not a system queue).
    // The zone-ownership target lives in proposed_payload.organization_id.
    // Pillar E (#273): forward the conductor-computed idempotency key so the
    // DB partial unique index (Layer 3, migration 0267) can deduplicate.
    const idempotencyKey = typeof body._idempotency_key === 'string' && body._idempotency_key ? body._idempotency_key : null;
    const queueOrgId = String(callerProfile.organization_id);
    const { data: action, error: insErr } = await admin.from('bob_agentic_actions').insert({
      organization_id: queueOrgId,
      user_id: caller.id,
      action_type: 'create_freedom_camping_zone',
      context_table: 'location_zones',
      proposed_payload: zonePayload,
      status: 'pending',
      bob_reasoning: reasoning,
      confidence_score: null,
      conversation_id: conversationId,
      context_summary: contextSummary,
      idempotency_key: idempotencyKey
    }).select('id').single();
    if (insErr || !action) {
      return json({
        error: 'Could not create the FC-zone action',
        details: insErr?.message
      }, 500);
    }
    return json({
      success: true,
      action_id: action.id,
      note: `Proposed (pending approval): freedom-camping zone '${zoneName}'. Approve it in the bell (with a reason).`
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Internal error';
    return json({
      error: 'Server error',
      details: msg
    }, 500);
  }
});
