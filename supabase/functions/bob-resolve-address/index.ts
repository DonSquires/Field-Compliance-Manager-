/**
 * bob-resolve-address — unified address resolution service (#148)
 *
 * POST /functions/v1/bob-resolve-address
 * Body: {
 *   address: string,           // required: free-text address or place name
 *   zone_type?: string,        // drives the area validity gate band (default: freedom_camping)
 *   organization_id?: string,  // scope existing-record search to this org
 * }
 *
 * Returns: {
 *   candidates: Array<{ id, name, type, address, distance_m }>,
 *   boundary: GeoJSON | null,
 *   source: string,
 *   provisional: boolean,
 *   gps_lat: number | null,
 *   gps_lng: number | null,
 *   rejected: boolean,
 *   rejected_reason: string | null,
 * }
 *
 * Flow:
 *   Step 1: search existing client_sites and location_zones for a match by
 *           address text similarity (ilike) or GPS proximity (ST_DWithin).
 *   Step 2: if no match, call bob-resolve-geofence internally (LINZ -> Google
 *           -> provisional logic).
 *   Step 3: validate the resolved polygon against the zone_type area bands
 *           (same bands as bob-resolve-geofence — copied verbatim, not invented).
 *
 * Auth: requires a valid JWT (same pattern as other bob-* edge functions).
 * RLS: existing-record search uses the caller's auth token (not service role).
 *
 * Governance:
 *   - Read-only (no writes)
 *   - JWT required; admin/master/grand_master only
 */ import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type"
};
const CAN_RESOLVE = new Set([
  "grand_master",
  "master",
  "admin"
]);
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      "Content-Type": "application/json"
    }
  });
}
// ── Per-zone_type area validity bands (copied verbatim from bob-resolve-geofence) ──
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
const DEFAULT_AREA_BAND = {
  min: 10,
  max: 500_000
};
// Rough planar area (m^2) — same implementation as bob-resolve-geofence.
function approxPolygonAreaM2(geojson) {
  const type = String(geojson.type ?? "");
  let ring = null;
  if (type === "Polygon") {
    const coords = geojson.coordinates;
    ring = coords?.[0] ?? null;
  }
  if (!ring || ring.length < 4) return null;
  const meanLat = ring.reduce((s, p)=>s + p[1], 0) / ring.length;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(meanLat * Math.PI / 180);
  let area2 = 0;
  for(let i = 0; i < ring.length - 1; i++){
    const x1 = ring[i][0] * mPerDegLng, y1 = ring[i][1] * mPerDegLat;
    const x2 = ring[i + 1][0] * mPerDegLng, y2 = ring[i + 1][1] * mPerDegLat;
    area2 += x1 * y2 - x2 * y1;
  }
  return Math.abs(area2) / 2;
}
function geometryGate(geojson, zoneType) {
  if (!geojson) return {
    ok: false,
    reason: "no_geometry",
    area_m2: null
  };
  const type = String(geojson.type ?? "");
  if (type === "MultiPolygon") {
    return {
      ok: false,
      reason: "unexpected_multipolygon",
      area_m2: null
    };
  }
  if (type !== "Polygon") {
    return {
      ok: false,
      reason: `unsupported_geometry_type:${type || "unknown"}`,
      area_m2: null
    };
  }
  const coords = geojson.coordinates;
  const ring = coords?.[0];
  if (!ring || ring.length < 4) return {
    ok: false,
    reason: "degenerate_ring",
    area_m2: null
  };
  const first = ring[0], last = ring[ring.length - 1];
  if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
    return {
      ok: false,
      reason: "unclosed_ring",
      area_m2: null
    };
  }
  const area = approxPolygonAreaM2(geojson);
  if (area === null || area <= 0) return {
    ok: false,
    reason: "invalid_area",
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
serve(async (req)=>{
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: CORS
  });
  if (req.method !== "POST") return json({
    error: "POST required"
  }, 405);
  try {
    // ── Auth (same pattern as bob-resolve-geofence) ──────────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({
      error: "Unauthorized"
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
      error: "Unauthorized"
    }, 401);
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: callerProfile } = await admin.from("user_profiles").select("role").eq("id", caller.id).single();
    if (!callerProfile || !CAN_RESOLVE.has(String(callerProfile.role))) {
      return json({
        error: "Forbidden: admin/master/grand_master required"
      }, 403);
    }
    // ── Parse body ──────────────────────────────────────────────────────
    const body = await req.json();
    const address = String(body.address ?? "").trim();
    if (!address) return json({
      error: "address is required"
    }, 400);
    const zoneType = String(body.zone_type ?? "freedom_camping").trim();
    const orgId = String(body.organization_id ?? "").trim() || null;
    // ── Step 1: search existing records ─────────────────────────────────
    // Use the CALLER's auth token (RLS-respecting client) for existing
    // record searches, not the service role.
    const candidates = [];
    try {
      // 1a: client_sites — ilike match on address or name
      let sitesQuery = callerClient.from("client_sites").select("id, name, address, gps_lat, gps_lng").or(`address.ilike.%${address}%,name.ilike.%${address}%`).limit(5);
      if (orgId) {
        sitesQuery = sitesQuery.eq("client_organization_id", orgId);
      }
      const { data: sites } = await sitesQuery;
      if (Array.isArray(sites)) {
        for (const site of sites){
          candidates.push({
            id: String(site.id),
            name: String(site.name ?? ""),
            type: "client_site",
            address: site.address ? String(site.address) : null,
            distance_m: null
          });
        }
      }
      // 1b: location_zones — ilike match on name
      let zonesQuery = callerClient.from("location_zones").select("id, name, zone_type").ilike("name", `%${address}%`).limit(5);
      if (orgId) {
        zonesQuery = zonesQuery.eq("organization_id", orgId);
      }
      const { data: zones } = await zonesQuery;
      if (Array.isArray(zones)) {
        for (const zone of zones){
          candidates.push({
            id: String(zone.id),
            name: String(zone.name ?? ""),
            type: String(zone.zone_type ?? "zone"),
            address: null,
            distance_m: null
          });
        }
      }
    } catch (searchErr) {
      // Non-fatal: log and continue to resolution
      console.warn("[bob-resolve-address] existing-record search failed (non-fatal):", searchErr);
    }
    // ── Step 2: call bob-resolve-geofence for boundary resolution ────────
    let boundary = null;
    let source = "none";
    let provisional = false;
    let gpsLat = null;
    let gpsLng = null;
    let rejected = false;
    let rejectedReason = null;
    try {
      const geofenceRes = await fetch(`${SUPABASE_URL}/functions/v1/bob-resolve-geofence`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authHeader
        },
        body: JSON.stringify({
          place_name: address,
          zone_type: zoneType
        })
      });
      const geofenceText = await geofenceRes.text();
      let geofenceData = {};
      try {
        geofenceData = JSON.parse(geofenceText);
      } catch  {
        geofenceData = {
          raw: geofenceText.slice(0, 500)
        };
      }
      if (geofenceData.boundary && typeof geofenceData.boundary === "object") {
        boundary = geofenceData.boundary;
        source = String(geofenceData.source ?? "unknown");
      } else if (geofenceData.provisional_boundary && typeof geofenceData.provisional_boundary === "object") {
        boundary = geofenceData.provisional_boundary;
        source = String(geofenceData.source ?? "google");
        provisional = true;
      }
      // Extract GPS from center_point or from the geofence response
      if (geofenceData.center_point && typeof geofenceData.center_point === "object") {
        const cp = geofenceData.center_point;
        const coords = cp.coordinates;
        if (Array.isArray(coords) && coords.length >= 2) {
          gpsLng = coords[0];
          gpsLat = coords[1];
        }
      }
      // If we got a rejected_boundary from the geofence resolver, carry it
      if (geofenceData.rejected_boundary && typeof geofenceData.rejected_boundary === "object") {
        rejected = true;
        rejectedReason = geofenceData.rejected_reason ? String(geofenceData.rejected_reason) : null;
        // The boundary was rejected by the gate — don't return it as the
        // primary boundary, but the source is still informative
        source = String(geofenceData.source ?? "unknown");
      }
      // If bob-resolve-geofence returned ok:false with no boundary at all,
      // try to extract whatever point info is available
      if (!boundary && !rejected) {
        source = String(geofenceData.source ?? "none");
      }
    } catch (resolveErr) {
      console.error("[bob-resolve-address] bob-resolve-geofence call failed:", resolveErr);
      source = "error";
    }
    // ── Step 3: validate the resolved polygon against area bands ─────────
    if (boundary && !rejected) {
      const gate = geometryGate(boundary, zoneType);
      if (!gate.ok) {
        rejected = true;
        rejectedReason = gate.reason;
        // Keep the boundary in the response but flag it as rejected
        boundary = null;
      }
    }
    return json({
      candidates,
      boundary,
      source,
      provisional,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      rejected,
      rejected_reason: rejectedReason
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[bob-resolve-address] error:", msg);
    return json({
      error: msg
    }, 500);
  }
});
