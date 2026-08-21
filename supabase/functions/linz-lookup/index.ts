/**
 * linz-lookup — LINZ Data Service proxy for address autocomplete + boundary suggest
 *
 * POST /functions/v1/linz-lookup
 * Body (one of):
 *   { action: 'address_autocomplete', q: string, max?: number }
 *   { action: 'boundary_for_point', lat: number, lng: number, kind?: 'parcel' | 'building' }
 *
 * Why this exists:
 *   - Address autocomplete resolves a free-text address to the AUTHORITATIVE
 *     LINZ address (canonical string + point). The canonical address is used as
 *     client_sites.address_match_key so every visit/job/observation from every
 *     module de-duplicates to ONE site row (officer-safety history; geofence
 *     architecture §3).
 *   - boundary_for_point returns the legal parcel polygon (NZ Primary Parcels)
 *     or the tighter building footprint (NZ Building Outlines) to PRE-FILL the
 *     site boundary draw editor — the admin confirms/adjusts. Same Koordinates
 *     Vector Query pattern proven for jurisdiction in bob-proposal-execute (!413).
 *
 * Security:
 *   - LINZ_API_KEY lives in edge-function secrets only; never sent to the browser.
 *   - JWT-verified caller (any authenticated app user). Read-only proxy; no writes.
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
const LINZ_API_KEY = Deno.env.get('LINZ_API_KEY') ?? '';
// Google is the SECONDARY geo provider (policy #19): used to seed the LINZ
// point lookup from free text. OpenStreetMap / Nominatim is REMOVED from the
// geo path. LINZ remains the authoritative address + parcel source.
const GOOGLE_API_TOKEN = Deno.env.get('GOOGLE_API_TOKEN') ?? '';
// Verified live layer ids (from each layer's Services tab). Env-overridable so a
// future LINZ republish under a new id is a config change, not a code change.
const ADDRESS_LAYER = Deno.env.get('LINZ_ADDRESS_LAYER') ?? '123113'; // NZ Addresses
const PARCEL_LAYER = Deno.env.get('LINZ_PARCEL_LAYER') ?? '50772'; // NZ Primary Parcels
const BUILDING_LAYER = Deno.env.get('LINZ_BUILDING_LAYER') ?? '101292'; // NZ Building Outlines
const ROADS_LAYER = Deno.env.get('LINZ_ROADS_LAYER') ?? '123110'; // NZ Addresses: Roads (centreline names)
const QUERY_URL = 'https://data.linz.govt.nz/services/query/v1/vector.json';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const snippet = (s)=>s.replace(/\s+/g, ' ').trim().slice(0, 400);
async function googleGeocode(q) {
  if (!GOOGLE_API_TOKEN) return null;
  // NZ viewport bias so ambiguous names resolve within New Zealand.
  const NZ_BOUNDS = '-47.5,166.0|-34.0,179.0'; // SW|NE (lat,lng)
  // Stage 1: Geocoding API. Capture formatted_address (the real street address
  // Google returns, e.g. "1390 Tarras-Cromwell Road, Bendigo 9383") so callers
  // get an address even when LINZ has no feature at the point.
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json' + `?address=${encodeURIComponent(q)}` + `&components=country:NZ` + `&bounds=${encodeURIComponent(NZ_BOUNDS)}` + `&key=${GOOGLE_API_TOKEN}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });
    const data = await res.json();
    const hit = data.results?.[0];
    const loc = hit?.geometry?.location;
    if (data.status === 'OK' && loc && isFinite(Number(loc.lat)) && isFinite(Number(loc.lng))) {
      return {
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        address: hit?.formatted_address ?? null
      };
    }
  } catch  {}
  // Stage 2: Places Text Search (name-only / partial input). formatted_address
  // here is the place's address/vicinity.
  try {
    const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json' + `?query=${encodeURIComponent(`${q}, New Zealand`)}` + `&region=nz` + `&key=${GOOGLE_API_TOKEN}`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });
    const data = await res.json();
    const hit = data.results?.[0];
    const loc = hit?.geometry?.location;
    if ((data.status === 'OK' || data.status === 'ZERO_RESULTS') && loc && isFinite(Number(loc.lat)) && isFinite(Number(loc.lng))) {
      const addr = hit?.formatted_address ?? hit?.name ?? null;
      return {
        lat: Number(loc.lat),
        lng: Number(loc.lng),
        address: addr
      };
    }
  } catch  {}
  return null;
}
// Run a Koordinates Vector Query against one LINZ layer at a point.
async function vectorQuery(layer, lng, lat, opts = {}) {
  const url = [
    QUERY_URL,
    `?key=${LINZ_API_KEY}`,
    `&layer=${layer}`,
    `&x=${lng}`,
    `&y=${lat}`,
    `&max_results=${opts.maxResults ?? 1}`,
    `&radius=${opts.radius ?? 0}`,
    `&geometry=${opts.geometry ? 'true' : 'false'}`,
    `&with_field_names=true`
  ].join('');
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip'
    }
  });
  if (!res.ok) {
    const body = snippet(await res.text().catch(()=>''));
    throw new Error(`LINZ Vector Query failed (${res.status}) layer ${layer}: ${body}`);
  }
  const data = await res.json();
  const layers = data.vectorQuery?.layers ?? {};
  for (const l of Object.values(layers)){
    if (Array.isArray(l.features)) return l.features;
  }
  return [];
}
// Best-effort extraction of a human-readable address string from LINZ address
// properties (field names vary by edition; with_field_names=true returns them).
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
  // Fallback: join the common components if present.
  const parts = [
    'address_number',
    'road_name',
    'suburb_locality',
    'town_city'
  ].map((k)=>props[k]).filter((v)=>typeof v === 'string' && v.trim()).join(' ');
  return parts || 'Unknown address';
}
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
  if (!LINZ_API_KEY) return json({
    error: 'LINZ_API_KEY is not configured'
  }, 500);
  try {
    const body = await req.json();
    const action = String(body.action ?? '');
    // ── address_autocomplete: free-text -> canonical LINZ address candidates ──
    // The Vector Query API is point-based, so we first geocode the free text to a
    // point (LINZ has no text-search query param), then return the nearest
    // canonical addresses. For a typed address this resolves the authoritative
    // record + point used as the de-dup match key.
    if (action === 'address_autocomplete') {
      const q = String(body.q ?? '').trim();
      if (!q) return json({
        error: 'q is required'
      }, 400);
      // Forward-geocode the free text to a point using GOOGLE (policy #19;
      // OSM/Nominatim removed). LINZ's Vector Query needs a point; this only
      // SEEDS the lookup, then the authoritative LINZ address is what we
      // return/store. Handles both full addresses (Geocoding API) and
      // name-only / partial input (Places Text Search).
      if (!GOOGLE_API_TOKEN) return json({
        error: 'GOOGLE_API_TOKEN is not configured'
      }, 500);
      const hit = await googleGeocode(q);
      if (!hit) return json({
        candidates: []
      });
      const { lat, lng, address: googleAddress } = hit;
      const max = Math.min(Number(body.max ?? 5) || 5, 20);
      const features = await vectorQuery(ADDRESS_LAYER, lng, lat, {
        maxResults: max,
        radius: 200,
        geometry: false
      });
      const candidates = features.map((f)=>{
        const props = f.properties ?? {};
        // Prefer the LINZ feature's own coords; fall back to the Google seed
        // point when the layer's coord fields are absent/renamed (avoids the
        // gd2000_* vs latitude/longitude mismatch silently returning null).
        const flat = typeof props.gd2000_ycoord === 'number' ? props.gd2000_ycoord : typeof props.latitude === 'number' ? props.latitude : lat;
        const flng = typeof props.gd2000_xcoord === 'number' ? props.gd2000_xcoord : typeof props.longitude === 'number' ? props.longitude : lng;
        return {
          label: addressLabel(props),
          address_id: props.address_id ?? props.id ?? null,
          lat: flat,
          lng: flng,
          source: 'linz_address',
          properties: props
        };
      });
      // Rural / unaddressed places (foreshore FC areas, camping reserves) often
      // have NO LINZ address feature near the geocoded point. Google still gave
      // us a real formatted_address + point — return THAT rather than reporting
      // "no address found" and throwing a usable location away.
      if (candidates.length === 0) {
        candidates.push({
          label: googleAddress ?? q,
          address_id: null,
          lat,
          lng,
          source: 'google_address',
          properties: googleAddress ? {
            full_address: googleAddress
          } : {}
        });
      }
      return json({
        candidates
      });
    }
    // ── boundary_for_point: point -> parcel or building polygon (GeoJSON) ──
    if (action === 'boundary_for_point') {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json({
        error: 'lat and lng are required numbers'
      }, 400);
      const kind = body.kind === 'building' ? 'building' : 'parcel';
      const layer = kind === 'building' ? BUILDING_LAYER : PARCEL_LAYER;
      const features = await vectorQuery(layer, lng, lat, {
        maxResults: 1,
        radius: 0,
        geometry: true
      });
      const feature = features[0];
      if (!feature?.geometry) {
        return json({
          kind,
          geometry: null,
          note: `No ${kind} polygon found at this point.`
        });
      }
      return json({
        kind,
        geometry: feature.geometry,
        properties: feature.properties ?? {}
      });
    }
    // ── boundary_for_point_escalating: point -> polygon, trying HARDER before
    // giving up ── an ENGINE Bob calls as one tool step, rather than hand-rolled
    // retry logic in the caller. Owner-directed method (2026-07-12): an exact
    // point-only lookup (radius=0) misses real parcels when the geocoded point
    // (from a business-name search or an imprecise address) lands a few metres
    // outside the parcel polygon — common, not an edge case. This tries, IN
    // ORDER, until one succeeds:
    //   1. LINZ PARCEL boundary, exact point (radius 0) — today's default.
    //   2. LINZ PARCEL boundary, expanding radius (25m, 50m, 100m) — the
    //      "logical variance" step: compensates for geocode-point drift
    //      without guessing a different address.
    //   3. LINZ BUILDING OUTLINE, same expanding radii — a second, tighter
    //      LINZ dataset distinct from the parcel layer, tried before giving up.
    // Returns which method succeeded (or none) so the caller/Bob can reason
    // over HOW confident the result is, and so the human-facing message can
    // say plainly whether this is an exact match or a nearby-radius match.
    if (action === 'boundary_for_point_escalating') {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json({
        error: 'lat and lng are required numbers'
      }, 400);
      const radii = Array.isArray(body.radii_m) && body.radii_m.every((r)=>typeof r === 'number') ? body.radii_m : [
        0,
        25,
        50,
        100
      ];
      const attempts = [];
      for (const layerKind of [
        'parcel',
        'building'
      ]){
        const layer = layerKind === 'building' ? BUILDING_LAYER : PARCEL_LAYER;
        for (const radius of radii){
          const features = await vectorQuery(layer, lng, lat, {
            maxResults: 1,
            radius,
            geometry: true
          });
          const feature = features[0];
          attempts.push({
            layer: layerKind,
            radius_m: radius,
            found: !!feature?.geometry
          });
          if (feature?.geometry) {
            return json({
              kind: layerKind,
              geometry: feature.geometry,
              properties: feature.properties ?? {},
              matched_via: {
                layer: layerKind,
                radius_m: radius,
                exact: radius === 0
              },
              attempts
            });
          }
        }
      }
      return json({
        kind: null,
        geometry: null,
        matched_via: null,
        attempts,
        note: 'No parcel or building polygon found at this point after trying both LINZ layers at increasing search radii.'
      });
    }
    // ── reverse_geocode: lat/lng -> canonical LINZ address (Q-A2) ──
    // Used by canonicalSiteEntry.ts reverseLinzLookup() when a manual GPS pin
    // is entered. Google reverse-geocodes the point to get a street address,
    // then we look up the nearest LINZ canonical address at that point.
    // Policy #19: LINZ primary, Google secondary. If LINZ has an address
    // feature near the point, that is the canonical result. If not, the
    // Google reverse-geocode address is returned as a fallback.
    if (action === 'reverse_geocode') {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json({
        error: 'lat and lng are required numbers'
      }, 400);
      const max = Math.min(Number(body.max ?? 3) || 3, 10);
      // Step 1: Try LINZ address layer directly at the point (no Google needed).
      // This is the fastest path and honours LINZ-primary (#19).
      const linzFeatures = await vectorQuery(ADDRESS_LAYER, lng, lat, {
        maxResults: max,
        radius: 200,
        geometry: false
      });
      if (linzFeatures.length > 0) {
        const candidates = linzFeatures.map((f)=>{
          const props = f.properties ?? {};
          const flat = typeof props.gd2000_ycoord === 'number' ? props.gd2000_ycoord : typeof props.latitude === 'number' ? props.latitude : lat;
          const flng = typeof props.gd2000_xcoord === 'number' ? props.gd2000_xcoord : typeof props.longitude === 'number' ? props.longitude : lng;
          return {
            label: addressLabel(props),
            address_id: props.address_id ?? props.id ?? null,
            lat: flat,
            lng: flng,
            source: 'linz_address',
            properties: props
          };
        });
        return json({
          candidates
        });
      }
      // Step 2: Google reverse geocode to get a street address, then try LINZ
      // at the Google-returned point (handles slight coordinate drift).
      if (GOOGLE_API_TOKEN) {
        try {
          const url = 'https://maps.googleapis.com/maps/api/geocode/json' + `?latlng=${lat},${lng}` + `&result_type=street_address|route|premise` + `&key=${GOOGLE_API_TOKEN}`;
          const res = await fetch(url, {
            headers: {
              'Accept': 'application/json'
            }
          });
          const data = await res.json();
          if (data.status === 'OK' && data.results?.length) {
            const hit = data.results[0];
            const googleAddr = hit?.formatted_address ?? null;
            const glat = Number(hit?.geometry?.location?.lat ?? lat);
            const glng = Number(hit?.geometry?.location?.lng ?? lng);
            // Try LINZ at the Google-refined point
            const linzAtGoogle = await vectorQuery(ADDRESS_LAYER, glng, glat, {
              maxResults: max,
              radius: 200,
              geometry: false
            });
            if (linzAtGoogle.length > 0) {
              const candidates = linzAtGoogle.map((f)=>{
                const props = f.properties ?? {};
                const flat = typeof props.gd2000_ycoord === 'number' ? props.gd2000_ycoord : typeof props.latitude === 'number' ? props.latitude : glat;
                const flng2 = typeof props.gd2000_xcoord === 'number' ? props.gd2000_xcoord : typeof props.longitude === 'number' ? props.longitude : glng;
                return {
                  label: addressLabel(props),
                  address_id: props.address_id ?? props.id ?? null,
                  lat: flat,
                  lng: flng2,
                  source: 'linz_address',
                  properties: props
                };
              });
              return json({
                candidates
              });
            }
            // No LINZ feature -- return Google address as secondary fallback (#19)
            if (googleAddr) {
              return json({
                candidates: [
                  {
                    label: googleAddr,
                    address_id: null,
                    lat: glat,
                    lng: glng,
                    source: 'google_reverse',
                    properties: {
                      full_address: googleAddr
                    }
                  }
                ]
              });
            }
          }
        } catch  {}
      }
      // No address found at this point
      return json({
        candidates: []
      });
    }
    // ── road_for_point: point -> nearest named road (label/context only) ──
    // Centreline NAME lookup, NOT routing. Navigation/ETAs use OSRM + solver.
    if (action === 'road_for_point') {
      const lat = Number(body.lat);
      const lng = Number(body.lng);
      if (!isFinite(lat) || !isFinite(lng)) return json({
        error: 'lat and lng are required numbers'
      }, 400);
      // Small radius: nearest road within ~100m, sorted by distance.
      const features = await vectorQuery(ROADS_LAYER, lng, lat, {
        maxResults: 1,
        radius: 100,
        geometry: false
      });
      const props = features[0]?.properties ?? null;
      if (!props) return json({
        road_name: null,
        note: 'No named road found near this point.'
      });
      let roadName = null;
      for (const key of [
        'full_road_name',
        'road_name',
        'name',
        'road_name_label'
      ]){
        const v = props[key];
        if (typeof v === 'string' && v.trim()) {
          roadName = v.trim();
          break;
        }
      }
      return json({
        road_name: roadName,
        properties: props
      });
    }
    return json({
      error: `Unknown action '${action}'`
    }, 400);
  } catch (err) {
    return json({
      error: err instanceof Error ? err.message : 'Internal error'
    }, 500);
  }
});
