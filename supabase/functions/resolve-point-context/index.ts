/**
 * resolve-point-context — resolve a GPS point to zone/site context or street
 * address for officer-facing report/job anchoring (#153).
 *
 * POST /functions/v1/resolve-point-context
 * Body: { lat: number, lng: number, organization_id: string }
 *
 * Returns: {
 *   in_zone: boolean,
 *   zone_id: string | null,
 *   zone_name: string | null,
 *   site_id: string | null,
 *   site_name: string | null,
 *   location_id: string | null,     // canonical house when a standalone Site matches
 *   site_match_kind: 'verified_boundary' | 'verified_onsite_radius' | null,
 *   rules_ref: string | null,       // jurisdiction_rule_set_id when in-zone
 *   address: string | null,         // reverse-geocoded street address (when not in zone)
 *   address_source: 'linz' | 'google' | null,
 *   gps_lat: number,
 *   gps_lng: number,
 * }
 *
 * Flow:
 *   1. PostGIS point-in-polygon: call resolve_context() RPC (migration 0090)
 *      for zone detection against location_zones.boundary.
 *   2. If no zone match, call resolve_verified_site_context() for active,
 *      valid, verified Site geometry in the caller-authorized client scope.
 *   3. If neither zone nor site contains the point, reverse-geocode:
 *      a. LINZ Vector Query (authoritative NZ address, nearest within 200m)
 *         — same pattern as linz-lookup edge function.
 *      b. Google Geocoding API reverse geocode (fallback).
 *
 * Auth: JWT required (any authenticated user — officers need this).
 * API keys (LINZ_API_KEY, GOOGLE_API_TOKEN) stay server-side only.
 *
 * Design: follows the same patterns as bob-resolve-address and linz-lookup.
 * Reuses the existing resolve_context() RPC rather than duplicating PostGIS
 * queries. Reverse geocoding reuses linz-lookup's vectorQuery + Google
 * patterns rather than duplicating them.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const LINZ_API_KEY = Deno.env.get('LINZ_API_KEY') ?? '';
const GOOGLE_API_TOKEN = Deno.env.get('GOOGLE_API_TOKEN') ?? '';
// LINZ NZ Addresses layer (same as linz-lookup)
const ADDRESS_LAYER = Deno.env.get('LINZ_ADDRESS_LAYER') ?? '123113';
const QUERY_URL = 'https://data.linz.govt.nz/services/query/v1/vector.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// ── LINZ reverse geocode: point → nearest address (same pattern as linz-lookup) ──
function addressLabel(props) {
  for (const key of [
    'full_address',
    'full_address_ascii',
    'address',
    'display_address'
  ]){
    const v = props[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  const parts = [
    'address_number',
    'road_name',
    'suburb_locality',
    'town_city'
  ].map((k)=>props[k]).filter((v)=>typeof v === 'string' && v.trim()).join(' ');
  return parts || '';
}
async function linzReverseGeocode(lat, lng) {
  if (!LINZ_API_KEY) return null;
  try {
    const url = [
      QUERY_URL,
      `?key=${LINZ_API_KEY}`,
      `&layer=${ADDRESS_LAYER}`,
      `&x=${lng}`,
      `&y=${lat}`,
      `&max_results=1`,
      `&radius=200`,
      `&geometry=false`,
      `&with_field_names=true`
    ].join('');
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const layers = data.vectorQuery?.layers ?? {};
    for (const l of Object.values(layers)){
      if (Array.isArray(l.features) && l.features.length > 0) {
        const props = l.features[0].properties ?? {};
        const label = addressLabel(props);
        if (label) return label;
      }
    }
    return null;
  } catch  {
    return null;
  }
}
// ── Google reverse geocode: point → formatted address ──
async function googleReverseGeocode(lat, lng) {
  if (!GOOGLE_API_TOKEN) return null;
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json' + `?latlng=${lat},${lng}` + '&result_type=street_address|route|premise' + `&key=${GOOGLE_API_TOKEN}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status === 'OK' && data.results?.[0]?.formatted_address) {
      return data.results[0].formatted_address;
    }
    return null;
  } catch  {
    return null;
  }
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    error: 'POST required'
  }, 405);
  try {
    // ── Auth: any authenticated user (officers need this) ──
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
    // ── Parse body ──
    const body = await req.json();
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const orgId = String(body.organization_id ?? '').trim();
    if (!isFinite(lat) || !isFinite(lng)) {
      return json({
        error: 'lat and lng are required numbers'
      }, 400);
    }
    if (!orgId) {
      return json({
        error: 'organization_id is required'
      }, 400);
    }
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile, error: profileError } = await admin.from('user_profiles').select('role, organization_id, authorized_organization_ids, deactivated_at').eq('id', caller.id).maybeSingle();
    if (profileError) return json({
      error: 'Organization access could not be verified'
    }, 503);
    if (!callerProfile || callerProfile.deactivated_at) return json({
      error: 'Active user profile required'
    }, 403);
    const authorizedOrganizations = Array.isArray(callerProfile.authorized_organization_ids) ? callerProfile.authorized_organization_ids.map(String) : [];
    const organizationAllowed = callerProfile.role === 'grand_master' || String(callerProfile.organization_id ?? '') === orgId || authorizedOrganizations.includes(orgId);
    if (!organizationAllowed) return json({
      error: 'Forbidden: organization is outside your authorized scope'
    }, 403);
    // Service-role client for PostGIS queries after caller scope is verified. resolve_context is SECURITY
    // DEFINER with GRANT to authenticated, so the caller's own JWT would
    // work too, but service role avoids RLS overhead on the name lookups.
    // ── Step 1: resolve_context() RPC — zone point-in-polygon ──
    // The RPC (migration 0090) does ST_Contains against location_zones.boundary
    // scoped to the org, returns zone + site + rules.
    const { data: ctxRows, error: ctxErr } = await admin.rpc('resolve_context', {
      p_lat: lat,
      p_lng: lng,
      p_org_id: orgId
    });
    if (ctxErr) return json({
      error: 'Geofence context could not be resolved'
    }, 503);
    const ctx = Array.isArray(ctxRows) ? ctxRows[0] : ctxRows;
    if (ctx && ctx.matched_zone_id) {
      // Point is inside a zone — resolve zone + site names
      let zoneName = null;
      let siteName = null;
      const { data: zoneRow } = await admin.from('location_zones').select('name').eq('id', ctx.matched_zone_id).maybeSingle();
      zoneName = zoneRow?.name ? String(zoneRow.name) : null;
      if (ctx.site_id) {
        const { data: siteRow } = await admin.from('client_sites').select('name').eq('id', ctx.site_id).maybeSingle();
        siteName = siteRow?.name ? String(siteRow.name) : null;
      }
      return json({
        in_zone: true,
        zone_id: ctx.matched_zone_id,
        zone_name: zoneName,
        site_id: ctx.site_id ?? null,
        site_name: siteName,
        rules_ref: ctx.effective_rules ? String(ctx.effective_rules?.jurisdiction_rule_set_id ?? '') || null : null,
        address: null,
        address_source: null,
        gps_lat: lat,
        gps_lng: lng
      });
    }
    // ── Step 2: verified standalone Site resolution ──
    // Sites may exist without a corresponding zone row (e.g. contracted
    // sites with a boundary but no module geofence). The resolve_context
    // RPC already handles zones with linked sites; this resolves standalone
    // Sites from valid verified PostGIS geometry and the configured on-site
    // radius. Raw browser/service centroids are not treated as map truth.
    //
    // SCOPING RULE (#153 fix): the caller passes the officer's provider org
    // id, but client_sites.client_organization_id belongs to CLIENT orgs.
    // Per docs/ORG_SERVICE_MODEL.md, sites belong to client orgs which are
    // related to the provider via:
    //   1. Ownership tree: client.parent_organization_id = provider branch
    //      (get_descendant_organizations covers this)
    //   2. Active service agreements: provider_organization_id = provider,
    //      client_organization_id = client
    // This matches how resolve_context (0090) scopes zones to the provider
    // org and then resolves the client_org from the zone's linked site.
    // We include sites from both descendant orgs AND service-agreement
    // client orgs to catch standalone sites that may not be in the
    // ownership tree (e.g. a client org linked only via a service agreement).
    try {
      // 2a: find client org ids via the ownership tree (descendants of the
      // provider org — includes client orgs parented under the provider).
      const { data: descendantRows, error: descendantsError } = await admin.rpc('get_descendant_organizations', {
        org_id: orgId
      });
      if (descendantsError) return json({
        error: 'Site organization scope could not be resolved'
      }, 503);
      const descendantIds = Array.isArray(descendantRows) ? descendantRows.map((r)=>String(r)) : [];
      // 2b: find client org ids via active service agreements where the
      // provider is the calling org (catches clients not in the ownership tree).
      const { data: agreementRows, error: agreementsError } = await admin.from('service_agreements').select('client_organization_id').eq('provider_organization_id', orgId);
      if (agreementsError) return json({
        error: 'Site agreement scope could not be resolved'
      }, 503);
      const agreementClientIds = Array.isArray(agreementRows) ? agreementRows.map((r)=>String(r.client_organization_id)) : [];
      // Union of both sets (deduplicated), plus the provider org itself
      // (in case it owns sites directly — unusual but defensive).
      const clientOrgIds = [
        ...new Set([
          orgId,
          ...descendantIds,
          ...agreementClientIds
        ])
      ];
      const { data: siteRows, error: siteContextError } = await admin.rpc('resolve_verified_site_context', {
        p_lat: lat,
        p_lng: lng,
        p_client_org_ids: clientOrgIds
      });
      if (siteContextError) return json({
        error: 'Verified Site context could not be resolved'
      }, 503);
      const site = Array.isArray(siteRows) ? siteRows[0] : siteRows;
      if (site) {
        return json({
          in_zone: false,
          zone_id: null,
          zone_name: null,
          site_id: String(site.site_id),
          site_name: String(site.site_name ?? ''),
          location_id: site.location_id ? String(site.location_id) : null,
          client_organization_id: site.client_organization_id ? String(site.client_organization_id) : null,
          site_match_kind: String(site.match_kind ?? 'verified_boundary'),
          rules_ref: null,
          address: null,
          address_source: null,
          gps_lat: lat,
          gps_lng: lng
        });
      }
    } catch  {
      return json({
        error: 'Verified Site context could not be resolved'
      }, 503);
    }
    // ── Step 3: reverse geocode — LINZ first, Google fallback ──
    let address = null;
    let addressSource = null;
    // 3a: LINZ — authoritative NZ address (nearest within 200m)
    const linzAddr = await linzReverseGeocode(lat, lng);
    if (linzAddr) {
      address = linzAddr;
      addressSource = 'linz';
    }
    // 3b: Google — fallback if LINZ has no nearby address
    if (!address) {
      const googleAddr = await googleReverseGeocode(lat, lng);
      if (googleAddr) {
        address = googleAddr;
        addressSource = 'google';
      }
    }
    return json({
      in_zone: false,
      zone_id: null,
      zone_name: null,
      site_id: null,
      site_name: null,
      rules_ref: null,
      address,
      address_source: addressSource,
      gps_lat: lat,
      gps_lng: lng
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[resolve-point-context] error:', msg);
    return json({
      error: msg
    }, 500);
  }
});
