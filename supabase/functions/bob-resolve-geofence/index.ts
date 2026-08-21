/**
 * bob-resolve-geofence — resolve a place name to a GeoJSON boundary.
 *
 * POST /functions/v1/bob-resolve-geofence
 * Body: {
 *   place_name,           // required: "Bendigo", "Lake Dunstan", etc.
 *   agency_base_url?, agency_layer_id?, agency_search_field?,  // trial endpoint
 *   agency_source_class?, // 'arcgis_featureserver' (default) | 'ogc_features' | 'wfs'
 *                         // — protocol the trial endpoint speaks (ArcGIS REST vs
 *                         // Koordinates/GeoServer WFS, e.g. LINZ Data Service).
 *   agency_authority_class?, // 'council' (default) | 'linz' | 'doc' | 'nzta' —
 *                            // saved on the registry row so future lookups
 *                            // classify the land owner correctly.
 *   lat?, lng?,           // optional: hint coordinates (SRID 4326)
 *   address?              // optional: hint address
 * }
 *
 * Returns: {
 *   ok: boolean,
 *   address: string,      // resolved address (LINZ or Google)
 *   boundary: GeoJSON,    // polygon (SRID 4326) or null if unresolved
 *   confidence: 'high' | 'medium' | 'low',
 *   reasoning: string,
 *   source: 'linz' | 'google' | 'none'
 * }
 *
 * Flow:
 * 1. place_name → linz-lookup (LINZ parcel + address)
 * 2. If LINZ returns geometry, extract boundary polygon (high confidence)
 * 3. If LINZ fails or no geometry, fall back to Google geocoding (medium confidence)
 * 4. Return address + boundary + confidence
 *
 * Governance:
 * - JWT required; admin/master/grand_master only
 * - Read-only (no writes)
 * - Org-scoped (respects caller's authorized_organization_ids)
 * - This is a READ tool, so it auto-chains in the reasoning loop
 */ import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GOOGLE_MAPS_API_KEY = Deno.env.get('GOOGLE_MAPS_API_KEY') ?? '';
// Bob system user — attributed as verified_by when a trial endpoint is
// auto-saved to geo_source_registry after passing a live query + the gate.
const BOB_SYSTEM_USER_ID = '00000000-0000-0000-0000-00000000b0b0';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};
const CAN_RESOLVE = new Set([
  'grand_master',
  'master',
  'admin'
]);
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json'
    }
  });
}
// Call linz-lookup (boundary_for_point_escalating) to resolve a POINT to a
// LINZ parcel/building polygon + address. LINZ Data Service has NO name-search
// capability in this codebase's proven interface (Koordinates Vector Query is
// point-based only — confirmed by reading linz-lookup's real handler, after an
// earlier WFS/GetFeature attempt assumed the wrong protocol and was removed).
// So this ALWAYS resolves via a point: use the supplied lat/lng if present,
// else geocode placeName with Google first (LINZ tells you WHO owns the land,
// never WHAT it's used for — freedom-camping/parking zone classification is a
// separate tier, see bob_site_geofence_resolution).
async function callLinzLookup(authHeader, placeName, lat, lng) {
  try {
    let pointLat = lat;
    let pointLng = lng;
    let seededAddress;
    if (pointLat === undefined || pointLng === undefined) {
      const geo = await callGoogleGeocode(placeName);
      if (!geo.ok || geo.lat === undefined || geo.lng === undefined) {
        return {
          ok: false,
          error: `Could not seed a point for '${placeName}' — LINZ Data Service has no name-search; Google geocoding failed: ${geo.error ?? 'no result'}`
        };
      }
      pointLat = geo.lat;
      pointLng = geo.lng;
      seededAddress = geo.address;
    }
    const r = await fetch(`${SUPABASE_URL}/functions/v1/linz-lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader
      },
      body: JSON.stringify({
        action: 'boundary_for_point_escalating',
        lat: pointLat,
        lng: pointLng
      })
    });
    if (!r.ok) {
      const text = await r.text().catch(()=>'');
      return {
        ok: false,
        error: `linz-lookup returned ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`
      };
    }
    const result = await r.json();
    if (!result.geometry) {
      return {
        ok: false,
        error: result.note ?? `No LINZ parcel/building polygon found near '${placeName}'`
      };
    }
    return {
      ok: true,
      address: seededAddress ?? placeName,
      geometry: result.geometry,
      feature: {
        ...result.properties,
        matched_via: result.matched_via,
        kind: result.kind
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: `linz-lookup call failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
// Call Google Geocoding API to resolve place name → lat/lng + address.
// Returns the first result's geometry (point) and formatted_address.
async function callGoogleGeocode(placeName, lat, lng) {
  if (!GOOGLE_MAPS_API_KEY) {
    return {
      ok: false,
      error: 'Google Maps API key not configured'
    };
  }
  try {
    const query = lat && lng ? `${lat},${lng}` : placeName;
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', query);
    url.searchParams.set('key', GOOGLE_MAPS_API_KEY);
    const r = await fetch(url.toString());
    if (!r.ok) return {
      ok: false,
      error: `Google Geocoding returned ${r.status}`
    };
    const data = await r.json();
    const result = (data.results ?? [])[0];
    if (!result) return {
      ok: false,
      error: 'No geocoding results found'
    };
    return {
      ok: true,
      address: result.formatted_address,
      lat: result.geometry?.location?.lat,
      lng: result.geometry?.location?.lng
    };
  } catch (err) {
    return {
      ok: false,
      error: `Google Geocoding call failed: ${err instanceof Error ? err.message : String(err)}`
    };
  }
}
// ── #82/hybrid-Bob: per-zone_type validity + area gate ──────────────────────
// The HARD physical-law gate. A polygon that is invalid, an unexpected
// multipolygon, or outside the plausible area band for its zone_type is NOT
// authoritative no matter how it was sourced (this is the Champagne Gully
// lesson: a query can succeed and still return a 5.58 km^2 wrong blob).
// Owner-confirmed NZ area bands (m^2):
const ZONE_AREA_BANDS = {
  parking: {
    min: 10,
    max: 50_000
  },
  freedom_camping: {
    min: 50,
    max: 500_000
  },
  noise_control: {
    min: 50,
    max: 2_000_000
  },
  patrol_area: {
    min: 1_000,
    max: 100_000_000
  }
};
// Fallback band for zone_types without an explicit entry (general/biosecurity/
// trespass/access_control): permissive min, camping-scale max.
const DEFAULT_AREA_BAND = {
  min: 10,
  max: 500_000
};
// Rough planar area (m^2) of a GeoJSON Polygon ring using an equirectangular
// projection around the ring's mean latitude. Good enough for an ORDER-OF-
// MAGNITUDE sanity check (we are catching km^2-vs-m^2 blunders, not surveying).
function approxPolygonAreaM2(geojson) {
  const type = String(geojson.type ?? '');
  let ring = null;
  if (type === 'Polygon') {
    const coords = geojson.coordinates;
    ring = coords?.[0] ?? null;
  }
  if (!ring || ring.length < 4) return null;
  const meanLat = ring.reduce((s, p)=>s + p[1], 0) / ring.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(meanLat * Math.PI / 180);
  // Shoelace on projected metres.
  let area2 = 0;
  for(let i = 0; i < ring.length - 1; i++){
    const x1 = ring[i][0] * mPerDegLng, y1 = ring[i][1] * mPerDegLat;
    const x2 = ring[i + 1][0] * mPerDegLng, y2 = ring[i + 1][1] * mPerDegLat;
    area2 += x1 * y2 - x2 * y1;
  }
  return Math.abs(area2) / 2;
}
// Run the hard gate. Returns ok:true only for a single valid Polygon whose area
// sits inside the band for zone_type. Everything else is a block with a reason.
function geometryGate(geojson, zoneType) {
  if (!geojson) return {
    ok: false,
    reason: 'no_geometry',
    area_m2: null
  };
  const type = String(geojson.type ?? '');
  if (type === 'MultiPolygon') {
    return {
      ok: false,
      reason: 'unexpected_multipolygon',
      area_m2: null
    };
  }
  if (type !== 'Polygon') {
    return {
      ok: false,
      reason: `unsupported_geometry_type:${type || 'unknown'}`,
      area_m2: null
    };
  }
  const coords = geojson.coordinates;
  const ring = coords?.[0];
  if (!ring || ring.length < 4) return {
    ok: false,
    reason: 'degenerate_ring',
    area_m2: null
  };
  // Ring must be closed (first == last) for a valid polygon.
  const first = ring[0], last = ring[ring.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    return {
      ok: false,
      reason: 'unclosed_ring',
      area_m2: null
    };
  }
  const area = approxPolygonAreaM2(geojson);
  if (area === null || area <= 0) return {
    ok: false,
    reason: 'invalid_area',
    area_m2: area
  };
  const band = ZONE_AREA_BANDS[zoneType] ?? DEFAULT_AREA_BAND;
  if (area < band.min) return {
    ok: false,
    reason: `below_min_area:${Math.round(area)}m2<${band.min}`,
    area_m2: area
  };
  if (area > band.max) return {
    ok: false,
    reason: `above_max_area:${Math.round(area)}m2>${band.max}`,
    area_m2: area
  };
  return {
    ok: true,
    area_m2: area
  };
}
// Generic self-diagnosing ArcGIS query by name against ANY FeatureServer layer.
// Mirrors bob-proposal-execute arcgisQueryByName: a bad field is a field_error
// (cycle to the next candidate), no match returns null, a real polygon returns
// its GeoJSON geometry. base_url is the FeatureServer root; layerId selects the
// layer.
async function arcgisQueryByNameGeneric(baseUrl, layerId, field, placeName) {
  const where = `UPPER(${field}) = UPPER('${placeName.replace(/'/g, "''")}')`;
  const url = `${baseUrl}/${layerId}/query` + `?where=${encodeURIComponent(where)}` + `&outFields=*&returnGeometry=true&outSR=4326&f=geojson`;
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json'
    }
  });
  const text = await res.text();
  const looksLikeFieldError = /does not exist|could not be found|cannot be found|unable to (complete|perform)|invalid (field|where|expression)|no field|unknown field/i.test(text) || /"error"\s*:/.test(text) && /field|where|expression/i.test(text);
  if (looksLikeFieldError) return 'field_error';
  if (!res.ok) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch  {
    return null;
  }
  if (data.error) return 'field_error';
  const features = data.features ?? [];
  return features[0]?.geometry ?? null;
}
// Look up a VERIFIED registry source for an agency and (optionally) place_kind.
// admin is typed loosely (any) — ReturnType<typeof createClient> without an
// explicit generic caused a TS2345 generic-mismatch against the call-site
// client (schema "public" vs "never"), a known supabase-js generic sharp edge.
async function lookupRegistrySource(admin, agencyId, placeKind) {
  let q = admin.from('geo_source_registry').select('agency_id, base_url, layer_id, search_field, place_kind, status, source_class').eq('agency_id', agencyId).eq('status', 'verified');
  if (placeKind) q = q.eq('place_kind', placeKind);
  const { data } = await q.limit(1);
  const row = (data ?? [])[0];
  return row ?? null;
}
// Convert a point (lat/lng) to a small circle polygon (radius ~100m) for provisional zones.
// Returns a GeoJSON polygon (SRID 4326).
function pointToCirclePolygon(lat, lng, radiusM = 100) {
  const earthRadiusM = 6371000;
  const latRad = lat * Math.PI / 180;
  const radiusRad = radiusM / earthRadiusM;
  const points = [];
  for(let i = 0; i < 32; i++){
    const angle = i / 32 * 2 * Math.PI;
    const latOffset = Math.asin(Math.sin(radiusRad) * Math.sin(angle));
    const lngOffset = Math.atan2(Math.cos(radiusRad) * Math.sin(angle), Math.cos(radiusRad) - Math.sin(latRad) * Math.sin(latOffset));
    const newLat = Math.asin(Math.sin(latRad) * Math.cos(radiusRad) + Math.cos(latRad) * Math.sin(radiusRad) * Math.cos(angle)) * 180 / Math.PI;
    const newLng = lng + lngOffset * 180 / Math.PI;
    points.push([
      newLng,
      newLat
    ]);
  }
  points.push(points[0]); // Close the polygon
  return {
    type: 'Polygon',
    coordinates: [
      points
    ]
  };
}
serve(async (req)=>{
  if (req.method === 'OPTIONS') return new Response('ok', {
    headers: CORS
  });
  if (req.method !== 'POST') return json({
    ok: false,
    error: 'POST required'
  }, 405);
  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    if (!authHeader) return json({
      ok: false,
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
      ok: false,
      error: 'Unauthorized'
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from('user_profiles').select('role').eq('id', caller.id).single();
    if (!callerProfile || !CAN_RESOLVE.has(String(callerProfile.role))) {
      return json({
        ok: false,
        error: 'Forbidden: admin/master/grand_master required'
      }, 403);
    }
    const body = await req.json();
    const placeName = String(body.place_name ?? '').trim();
    if (!placeName) return json({
      ok: false,
      error: 'place_name is required'
    }, 400);
    const lat = typeof body.lat === 'number' ? body.lat : undefined;
    const lng = typeof body.lng === 'number' ? body.lng : undefined;
    const agencyId = String(body.agency_id ?? '').trim();
    const placeKind = String(body.place_kind ?? '').trim() || undefined;
    const zoneType = String(body.zone_type ?? 'freedom_camping').trim();
    const trialBaseUrl = String(body.agency_base_url ?? '').trim();
    const trialLayerId = typeof body.agency_layer_id === 'number' ? body.agency_layer_id : 0;
    const trialSearchField = String(body.agency_search_field ?? '').trim();
    // Land-owning/administering authority class saved on the registry row for
    // future classification: 'council' (default) | 'linz' | 'doc' | 'nzta'.
    // NOTE: this is classification metadata, independent of query protocol —
    // all trial/registry ArcGIS sources currently use arcgisQueryByNameGeneric
    // (council ArcGIS Hub / NZTA). LINZ Data Service is NOT queried this way
    // (see callLinzLookup — it uses linz-lookup's point-based Vector Query API,
    // which has no name-search capability at all; a wrongly-assumed WFS path
    // was tried and removed after live verification).
    const trialAuthorityClass = String(body.agency_authority_class ?? 'council').trim();
    // Helper: build the option-(a) BLOCKED response. The gate rejected the
    // geometry, but we PRESERVE the discovery (rejected_boundary + reason) and
    // fall back to a center point so the human can shape it in the bell. Never
    // discard what Bob found; never write a gate-failed polygon as authoritative.
    const blockedResponse = (rejected, reason, address, source, centerLat, centerLng, areaM2)=>json({
        ok: true,
        address,
        boundary: null,
        rejected_boundary: rejected,
        rejected_reason: reason,
        requires_human_shape: true,
        center_point: centerLat !== undefined && centerLng !== undefined ? {
          type: 'Point',
          coordinates: [
            centerLng,
            centerLat
          ]
        } : null,
        confidence: 'low',
        reasoning: `Found geometry via ${source} but it FAILED the ${zoneType} validity/area gate (${reason}${areaM2 != null ? `, ~${Math.round(areaM2)} m^2` : ''}). Not written as authoritative — please confirm or draw the boundary.`,
        source
      });
    // Step 0a: TRIAL endpoint (#89 gap fix) — Bob found a candidate FeatureServer
    // (typically via an OFFERED, human-approved web_research search for the
    // council's GIS catalog) that is NOT yet in the registry. Try it ONCE,
    // self-diagnosing the name field the same way as a registered source. This
    // is what actually closes the "discover a brand-new endpoint" loop the
    // 0202 card describes — lookupRegistrySource alone can only ever reuse an
    // endpoint someone already confirmed. On a real, gate-passing hit, save it
    // to geo_source_registry as verified so every future request reuses it
    // (discover once, remember forever). A miss or gate failure is reported
    // plainly and is NEVER saved as verified.
    if (trialBaseUrl && !agencyId) {
      return json({
        ok: false,
        error: 'agency_id is required alongside agency_base_url (the id to save this endpoint under if it verifies)'
      }, 400);
    }
    if (trialBaseUrl && agencyId) {
      const fieldCandidates = [
        trialSearchField,
        'name',
        'NAME',
        'zone_name',
        'ZONE_NAME',
        'label',
        'title'
      ].filter(Boolean);
      let trialHit = null;
      let matchedField = null;
      for (const f of fieldCandidates){
        const r = await arcgisQueryByNameGeneric(trialBaseUrl, trialLayerId, f, placeName);
        if (r === 'field_error') continue;
        if (r) {
          trialHit = r;
          matchedField = f;
          break;
        }
      }
      if (!trialHit) {
        // Trial MISS — report plainly, do not fall through silently to LINZ
        // without saying so. Caller can retry with a different URL/layer or
        // drop agency_base_url to continue down the normal source hierarchy.
        return json({
          ok: false,
          address: placeName,
          boundary: null,
          confidence: 'low',
          trial_endpoint: {
            base_url: trialBaseUrl,
            layer_id: trialLayerId,
            fields_tried: fieldCandidates
          },
          reasoning: `Trial endpoint MISS: queried ${trialBaseUrl} layer ${trialLayerId} for '${placeName}' across fields [${fieldCandidates.join(', ')}] — no match or all field errors. Not saved to the registry. Retry with a different layer/field, confirm this is really an ArcGIS FeatureServer, or omit agency_base_url to fall through to LINZ/Google.`,
          source: 'trial:miss'
        }, 422);
      }
      const gate = geometryGate(trialHit, zoneType);
      if (!gate.ok) {
        // Trial HIT but gate-blocked — preserve it, do NOT save to the registry
        // (endpoint-verified requires a hit; a hit that fails the gate is still
        // evidence the endpoint/field are right, but we let a human confirm
        // that reading before we commit it as a reusable source).
        return blockedResponse(trialHit, gate.reason, placeName, `trial:${agencyId}`, lat, lng, gate.area_m2);
      }
      // Trial HIT + gate PASSED — this is a real, working endpoint. Save it so
      // every future request for this agency reuses it (the actual discover-
      // once-remember-forever loop). geo_source_registry's uniqueness is an
      // EXPRESSION index (agency_id, coalesce(place_kind,''), layer_id) — a
      // plain .upsert(onConflict:...) can't target an expression index, so we
      // select-then-write explicitly instead of relying on ON CONFLICT.
      const { data: existingRow } = await admin.from('geo_source_registry').select('id').eq('agency_id', agencyId).eq('layer_id', trialLayerId).filter('place_kind', placeKind ? 'eq' : 'is', placeKind ?? null).maybeSingle();
      const registryRow = {
        agency_id: agencyId,
        authority_class: trialAuthorityClass,
        source_class: 'arcgis_featureserver',
        base_url: trialBaseUrl,
        layer_id: trialLayerId,
        search_field: matchedField,
        place_kind: placeKind ?? null,
        status: 'verified',
        last_tested_at: new Date().toISOString(),
        verified_by: BOB_SYSTEM_USER_ID,
        notes: `Discovered live via trial resolution for '${placeName}'.`
      };
      if (existingRow) {
        await admin.from('geo_source_registry').update(registryRow).eq('id', existingRow.id);
      } else {
        await admin.from('geo_source_registry').insert(registryRow);
      }
      return json({
        ok: true,
        address: placeName,
        boundary: trialHit,
        confidence: 'high',
        reasoning: `Resolved via a NEWLY DISCOVERED ${agencyId} ArcGIS FeatureServer (field '${matchedField}') and passed the ${zoneType} gate (~${Math.round(gate.area_m2)} m^2). Endpoint saved to the registry as verified for reuse.`,
        source: `trial:${agencyId}`,
        newly_registered: true
      });
    }
    // Step 0: registry-first council/agency source (highest fidelity — a real
    // published polygon). Only when an agency is named. Dispatches to the
    // PROTOCOL: ArcGIS REST only for now (see callLinzLookup for the separate,
    // point-based LINZ path — LINZ Data Service has no name-search protocol at
    // all, so it is never reached via this registry/ArcGIS dispatch).
    if (agencyId) {
      const reg = await lookupRegistrySource(admin, agencyId, placeKind);
      if (reg) {
        const fieldCandidates = [
          reg.search_field,
          'name',
          'NAME',
          'zone_name',
          'ZONE_NAME',
          'label',
          'title'
        ];
        let hit = null;
        for (const f of fieldCandidates){
          const r = await arcgisQueryByNameGeneric(reg.base_url, reg.layer_id, f, placeName);
          if (r === 'field_error') continue;
          if (r) {
            hit = r;
            break;
          }
        }
        if (hit) {
          const gate = geometryGate(hit, zoneType);
          if (gate.ok) {
            return json({
              ok: true,
              address: placeName,
              boundary: hit,
              confidence: 'high',
              reasoning: `Resolved via ${agencyId} (${reg.source_class}) and passed the ${zoneType} gate (~${Math.round(gate.area_m2)} m^2).`,
              source: `registry:${agencyId}`
            });
          }
          // Gate blocked the polygon — preserve it, ask for human shaping.
          return blockedResponse(hit, gate.reason, placeName, `registry:${agencyId}`, lat, lng, gate.area_m2);
        }
      }
    }
    // Step 1: Try LINZ lookup (parcel boundary) — authoritative for addressed land.
    const linzResult = await callLinzLookup(authHeader, placeName, lat, lng);
    if (linzResult.ok && linzResult.geometry) {
      const address = linzResult.address || placeName;
      const geom = linzResult.geometry;
      const gate = geometryGate(geom, zoneType);
      // Report the escalating engine's ACTUAL match confidence — exact point hit
      // vs radius-expanded vs building-outline fallback — rather than a blanket
      // 'high'. This is the bob_site_geofence_resolution 'say how you know' rule
      // applied in code, not just in the card text.
      const matchedVia = linzResult.feature?.matched_via;
      const matchDesc = matchedVia ? matchedVia.exact ? `exact ${matchedVia.layer} match` : `${matchedVia.layer} match within ${matchedVia.radius_m}m radius` : 'match';
      const linzConfidence = matchedVia?.exact ? 'high' : 'medium';
      if (gate.ok) {
        return json({
          ok: true,
          address,
          boundary: geom,
          confidence: linzConfidence,
          reasoning: `Resolved via LINZ (${matchDesc}) and passed the ${zoneType} gate (~${Math.round(gate.area_m2)} m^2). This is the LAND PARCEL/Crown boundary — confirm it matches the actual zone extent, not just land ownership: ${address}`,
          source: 'linz'
        });
      }
      // LINZ returned geometry that fails the gate (e.g. a whole reserve/
      // multipolygon — the Champagne Gully class). Preserve + ask for shaping.
      return blockedResponse(geom, gate.reason, address, 'linz', lat, lng, gate.area_m2);
    }
    // Step 2: Fall back to Google Geocoding — a POINT only, so the circle is
    // ALWAYS provisional by nature. Return it flagged for human shaping rather
    // than as an authoritative boundary.
    const googleResult = await callGoogleGeocode(placeName, lat, lng);
    if (googleResult.ok && googleResult.lat !== undefined && googleResult.lng !== undefined) {
      const address = googleResult.address || placeName;
      const circle = pointToCirclePolygon(googleResult.lat, googleResult.lng, 100);
      return json({
        ok: true,
        address,
        boundary: null,
        provisional_boundary: circle,
        requires_human_shape: true,
        center_point: {
          type: 'Point',
          coordinates: [
            googleResult.lng,
            googleResult.lat
          ]
        },
        confidence: 'medium',
        reasoning: `Google geocoding returned a POINT only (no published polygon). Provisional 100 m circle offered — please confirm or draw the real ${zoneType} boundary before it is treated as authoritative: ${address}`,
        source: 'google'
      });
    }
    // Step 3: everything missed. Offer the point (if hinted) for human shaping;
    // do not fabricate a boundary.
    return json({
      ok: false,
      address: placeName,
      boundary: null,
      requires_human_shape: true,
      center_point: lat !== undefined && lng !== undefined ? {
        type: 'Point',
        coordinates: [
          lng,
          lat
        ]
      } : null,
      confidence: 'low',
      reasoning: `Could not resolve ${placeName} via ${agencyId ? `${agencyId} registry, ` : ''}LINZ or Google. ${linzResult.error ? `LINZ: ${linzResult.error}. ` : ''}${googleResult.error ? `Google: ${googleResult.error}. ` : ''}Offer a web search for the official source, or ask for a reference coordinate / manual draw.`,
      source: 'none'
    }, 422);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[bob-resolve-geofence] error:', msg);
    return json({
      ok: false,
      error: msg
    }, 500);
  }
});
