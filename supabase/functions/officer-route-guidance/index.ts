import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const API_URL = (Deno.env.get('API_URL') ?? '').replace(/\/+$/, '');
const API_TOKEN = Deno.env.get('API_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

type Geometry = { coordinates?: unknown } | null | undefined;
type PlaceRow = { gps_lat?: number | null; gps_lng?: number | null; center_point?: Geometry; boundary?: Geometry } | null | undefined;
const first = <T>(value: T | T[] | null | undefined): T | null => (Array.isArray(value) ? value[0] ?? null : value ?? null);
const isLatLng = (lat: unknown, lng: unknown): boolean => typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
// Average of every vertex in a Point/Polygon/MultiPolygon (PostGIS geometry arrives as GeoJSON).
function geometryCentre(geometry: Geometry): { lat: number; lng: number } | null {
  let lat = 0, lng = 0, count = 0;
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (node.length >= 2 && typeof node[0] === 'number' && typeof node[1] === 'number') { lng += node[0]; lat += node[1]; count += 1; return; }
    node.forEach(walk);
  };
  walk(geometry?.coordinates);
  return count && isLatLng(lat / count, lng / count) ? { lat: lat / count, lng: lng / count } : null;
}
// Site GPS → site centre → zone centre → middle of the zone boundary. Zone-only jobs (no site) still route.
function placePoint(site: PlaceRow, zone: PlaceRow): { lat: number; lng: number } | null {
  if (site && isLatLng(site.gps_lat, site.gps_lng)) return { lat: site.gps_lat as number, lng: site.gps_lng as number };
  return geometryCentre(site?.center_point) ?? geometryCentre(zone?.center_point) ?? geometryCentre(zone?.boundary);
}

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!API_URL || !API_TOKEN) return json({ error: 'Route guidance is not configured.' }, 503);
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: request.headers.get('Authorization') ?? '' } } });
  const { data: { user } } = await callerClient.auth.getUser();
  if (!user) return json({ error: 'Authentication required.' }, 401);
  const body = await request.json().catch(() => null);
  const jobId = typeof body?.dispatch_job_id === 'string' ? body.dispatch_job_id : '';
  const originLat = Number(body?.origin_lat), originLng = Number(body?.origin_lng);
  if (!jobId || !Number.isFinite(originLat) || !Number.isFinite(originLng)) return json({ error: 'Dispatch job and current location are required.' }, 400);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const [{ data: profile }, { data: job }] = await Promise.all([
    admin.from('user_profiles').select('role, organization_id').eq('id', user.id).maybeSingle(),
    admin.from('dispatch_jobs').select('id, organization_id, shift_id, assigned_officer_id, site:client_site_id(name, address, gps_lat, gps_lng, center_point), zone:zone_id(name, center_point, boundary)').eq('id', jobId).maybeSingle(),
  ]);
  if (!profile || !job || profile.organization_id !== job.organization_id) return json({ error: 'Dispatch job is not available.' }, 404);
  const isAdmin = ['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role);
  // Jobs reach an officer either through their shift or by direct assignment (assigned_officer_id, shift_id may be null).
  const directlyAssigned = job.assigned_officer_id === user.id;
  if (!isAdmin && !directlyAssigned) {
    const { data: shift } = job.shift_id
      ? await admin.from('shifts').select('id').eq('id', job.shift_id).eq('officer_user_id', user.id).maybeSingle()
      : { data: null };
    if (!shift) return json({ error: 'This job is not assigned to you.' }, 403);
  }
  if (body?.mode === 'plan') {
    const activeJobs = admin.from('dispatch_jobs').select('id, priority, sla_respond_by, expected_dwell_minutes, site:client_site_id(gps_lat, gps_lng, center_point), zone:zone_id(center_point, boundary)').eq('organization_id', job.organization_id).in('status', ['dispatched', 'acknowledged', 'en_route']);
    const [{ data: jobs }, { data: patrolStops }] = await Promise.all([
      job.shift_id ? activeJobs.eq('shift_id', job.shift_id) : activeJobs.eq('assigned_officer_id', job.assigned_officer_id ?? user.id),
      job.shift_id
        ? admin.from('shift_stops').select('id, sla_arrive_by, required_dwell_minutes, site:site_id(gps_lat, gps_lng, center_point), zone:zone_id(center_point, boundary)').eq('shift_id', job.shift_id).in('status', ['pending', 'en_route'])
        : Promise.resolve({ data: [] as never[] }),
    ]);
    const dispatchStops = (jobs ?? []).flatMap((assigned) => {
      const point = placePoint(first(assigned.site) as PlaceRow, first(assigned.zone) as PlaceRow);
      return point ? [{ id: assigned.id, kind: 'dispatch', priority: assigned.priority, sla_respond_by: assigned.sla_respond_by, lat: point.lat, lng: point.lng, dwell_seconds: Math.max(60, Number(assigned.expected_dwell_minutes ?? 5) * 60) }] : [];
    });
    const scheduledStops = (patrolStops ?? []).flatMap((stop) => {
      const point = placePoint(first(stop.site) as PlaceRow, first(stop.zone) as PlaceRow);
      return point ? [{ id: stop.id, kind: 'patrol_stop', priority: 'normal', sla_respond_by: stop.sla_arrive_by, lat: point.lat, lng: point.lng, dwell_seconds: Math.max(60, Number(stop.required_dwell_minutes) * 60) }] : [];
    });
    const stops = [...dispatchStops, ...scheduledStops];
    if (!stops.length) return json({ error: 'No routeable active work is assigned to you. The job has no site or zone position — use Open in Maps with the address.' }, 422);
    const planResponse = await fetch(`${API_URL}/api/navigation/plan`, { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_lat: originLat, origin_lng: originLng, stops }) });
    const plan = await planResponse.json().catch(() => null);
    if (!planResponse.ok) return json({ error: plan?.error ?? 'Route plan is unavailable.' }, 502);
    return json(plan);
  }
  const site = first(job.site) as (PlaceRow & { address?: string | null }) | null;
  const zone = first(job.zone) as (PlaceRow & { name?: string | null }) | null;
  const destination = placePoint(site, zone);
  if (!destination) return json({ error: 'This job has no site or zone position to route to. Use Open in Maps with the address.' }, 422);
  const destinationLat = destination.lat, destinationLng = destination.lng;
  const response = await fetch(`${API_URL}/api/navigation/route`, { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_lat: originLat, origin_lng: originLng, destination_lat: destinationLat, destination_lng: destinationLng }) });
  const route = await response.json().catch(() => null);
  if (!response.ok) return json({ error: route?.error ?? 'Route guidance is unavailable.' }, 502);
  return json({ ...route, destination_address: site?.address ?? zone?.name ?? null, destination_lat: destinationLat, destination_lng: destinationLng });
});