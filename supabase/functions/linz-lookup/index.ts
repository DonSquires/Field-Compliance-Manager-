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
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
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
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const admin = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const snippet = (s)=>s.replace(/\s+/g, ' ').trim().slice(0, 400);
// Humans searching by name expect a Google-style results LIST to pick from, not
// one silent best guess (a wrong first result previously meant the LINZ lookup
// that followed was seeded from the wrong point, with no way to notice). Runs
// both Google APIs and keeps up to `max` hits from EACH, tagged by kind so the
// picker can show "address" vs "business/place" distinctly.
async function googlePlacesCandidates(q, max) {
  const candidates = [];
  if (!GOOGLE_API_TOKEN) return candidates;
  const NZ_BOUNDS = '-47.5,166.0|-34.0,179.0';
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json' + `?address=${encodeURIComponent(q)}` + `&components=country:NZ` + `&bounds=${encodeURIComponent(NZ_BOUNDS)}` + `&key=${GOOGLE_API_TOKEN}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    if (data.status === 'OK') {
      for (const hit of (data.results ?? []).slice(0, max)) {
        const loc = hit?.geometry?.location;
        if (loc && isFinite(Number(loc.lat)) && isFinite(Number(loc.lng))) {
          candidates.push({ label: hit.formatted_address ?? q, lat: Number(loc.lat), lng: Number(loc.lng), source: 'google_address', kind: 'address' });
        }
      }
    }
  } catch  {}
  try {
    const url = 'https://maps.googleapis.com/maps/api/place/textsearch/json' + `?query=${encodeURIComponent(`${q}, New Zealand`)}` + `&region=nz` + `&key=${GOOGLE_API_TOKEN}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const data = await res.json();
    if (data.status === 'OK' || data.status === 'ZERO_RESULTS') {
      for (const hit of (data.results ?? []).slice(0, max)) {
        const loc = hit?.geometry?.location;
        if (loc && isFinite(Number(loc.lat)) && isFinite(Number(loc.lng))) {
          const label = hit.name ? (hit.formatted_address ? `${hit.name} — ${hit.formatted_address}` : hit.name) : (hit.formatted_address ?? q);
          candidates.push({ label, lat: Number(loc.lat), lng: Number(loc.lng), source: 'google_place', kind: 'business' });
        }
      }
    }
  } catch  {}
  return candidates;
}
// Centroid of a GeoJSON Polygon/MultiPolygon outer ring -- good enough for a
// disambiguation-list marker point; not used as the accepted boundary itself.
function ringCentroid(geometry) {
  const ring = geometry?.type === 'Polygon' ? geometry.coordinates?.[0] : geometry?.type === 'MultiPolygon' ? geometry.coordinates?.[0]?.[0] : null;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of ring) { sumLng += lng; sumLat += lat; }
  return { lat: sumLat / ring.length, lng: sumLng / ring.length };
}
// Name search against every verified geo_source_registry agency (council
// reserves, parks, etc.) -- LINZ has no equivalent (legal parcels only), so
// this is genuinely new coverage, not a duplicate of the address candidates.
// A registry hit already carries real polygon geometry, so picking one of
// these can skip straight to accept/adjust instead of a second boundary lookup.
async function registryNameCandidates(q, max) {
  const candidates = [];
  if (!admin) return candidates;
  try {
    const { data: sources } = await admin.from('geo_source_registry').select('agency_id, base_url, layer_id, search_field').eq('status', 'verified').eq('source_class', 'arcgis_featureserver');
    for (const reg of sources ?? []) {
      if (!reg.base_url || !reg.search_field) continue;
      try {
        const where = `UPPER(${reg.search_field}) LIKE UPPER('%${q.replace(/'/g, "''")}%')`;
        const url = `${reg.base_url}/${reg.layer_id}/query?where=${encodeURIComponent(where)}&outFields=*&returnGeometry=true&outSR=4326&resultRecordCount=${max}&f=geojson`;
        const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
        if (!res.ok) continue;
        const data = await res.json();
        for (const feature of (data.features ?? []).slice(0, max)) {
          const props = feature.properties ?? {};
          const name = props[reg.search_field];
          const centroid = ringCentroid(feature.geometry);
          if (!name || !centroid) continue;
          candidates.push({ label: String(name), lat: centroid.lat, lng: centroid.lng, source: 'council_registry', kind: 'reserve', agency_id: reg.agency_id, boundary: feature.geometry ?? null });
        }
      } catch  {}
    }
  } catch  {}
  return candidates;
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
      if (!GOOGLE_API_TOKEN) return json({
        error: 'GOOGLE_API_TOKEN is not configured'
      }, 500);
      const max = Math.min(Number(body.max ?? 5) || 5, 20);
      // A human searching by name expects a Google-style results LIST to
      // disambiguate from -- council reserves (real boundary already in hand,
      // coverage LINZ has none of), then the authoritative LINZ address near
      // the best geocoded guess, then named businesses/places Google knows
      // but LINZ doesn't -- not one silently-picked point (the previous
      // design took only Google's results[0] before ever consulting LINZ).
      const [registryHits, placeHits] = await Promise.all([
        registryNameCandidates(q, max),
        googlePlacesCandidates(q, max)
      ]);
      const topGeocode = placeHits.find((c)=>c.source === 'google_address') ?? null;
      const businessHits = placeHits.filter((c)=>c.source === 'google_place');
      let linzHits = [];
      if (topGeocode) {
        const features = await vectorQuery(ADDRESS_LAYER, topGeocode.lng, topGeocode.lat, {
          maxResults: max,
          radius: 200,
          geometry: false
        });
        linzHits = features.map((f)=>{
          const props = f.properties ?? {};
          // Prefer the LINZ feature's own coords; fall back to the Google seed
          // point when the layer's coord fields are absent/renamed (avoids the
          // gd2000_* vs latitude/longitude mismatch silently returning null).
          const flat = typeof props.gd2000_ycoord === 'number' ? props.gd2000_ycoord : typeof props.latitude === 'number' ? props.latitude : topGeocode.lat;
          const flng = typeof props.gd2000_xcoord === 'number' ? props.gd2000_xcoord : typeof props.longitude === 'number' ? props.longitude : topGeocode.lng;
          return {
            label: addressLabel(props),
            address_id: props.address_id ?? props.id ?? null,
            lat: flat,
            lng: flng,
            source: 'linz_address',
            kind: 'address',
            properties: props
          };
        });
        // Rural / unaddressed places (foreshore FC areas, camping reserves) often
        // have NO LINZ address feature near the geocoded point. Google still gave
        // us a real formatted_address + point — return THAT rather than reporting
        // "no address found" and throwing a usable location away.
        if (linzHits.length === 0) {
          linzHits.push({
            label: topGeocode.label,
            address_id: null,
            lat: topGeocode.lat,
            lng: topGeocode.lng,
            source: 'google_address',
            kind: 'address',
            properties: {
              full_address: topGeocode.label
            }
          });
        }
      }
      // Merge and dedupe by label: reserves first (already-known boundary),
      // then named businesses/places (the distinctive answer to a name
      // search), then nearby LINZ addresses last -- addresses alone can fill
      // the whole cap with near-identical neighbours and crowd out the one
      // named result a person was actually searching for.
      const merged = [
        ...registryHits,
        ...businessHits,
        ...linzHits
      ];
      const seen = new Set();
      const candidates = [];
      for (const candidate of merged){
        const key = candidate.label.trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
        if (candidates.length >= max) break;
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
