import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const API_URL = (Deno.env.get('API_URL') ?? '').replace(/\/+$/, '');
const API_TOKEN = Deno.env.get('API_TOKEN') ?? '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

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
    admin.from('dispatch_jobs').select('id, organization_id, shift_id, site:client_site_id(address, gps_lat, gps_lng, center_point)').eq('id', jobId).maybeSingle(),
  ]);
  if (!profile || !job || profile.organization_id !== job.organization_id) return json({ error: 'Dispatch job is not available.' }, 404);
  const isAdmin = ['grand_master', 'master', 'admin', 'admin_officer'].includes(profile.role);
  if (!isAdmin) {
    const { data: shift } = await admin.from('shifts').select('id').eq('id', job.shift_id).eq('officer_user_id', user.id).maybeSingle();
    if (!shift) return json({ error: 'This job is not assigned to you.' }, 403);
  }
  if (body?.mode === 'plan') {
    const [{ data: jobs }, { data: patrolStops }] = await Promise.all([
      admin.from('dispatch_jobs').select('id, priority, sla_respond_by, expected_dwell_minutes, site:client_site_id(gps_lat, gps_lng, center_point)').eq('shift_id', job.shift_id).in('status', ['dispatched', 'acknowledged', 'en_route']),
      admin.from('shift_stops').select('id, sla_arrive_by, required_dwell_minutes, site:site_id(gps_lat, gps_lng, center_point)').eq('shift_id', job.shift_id).in('status', ['pending', 'en_route']),
    ]);
    const dispatchStops = (jobs ?? []).flatMap((assigned) => {
      const assignedSite = Array.isArray(assigned.site) ? assigned.site[0] : assigned.site;
      const point = assignedSite?.center_point?.coordinates;
      const lat = Number(assignedSite?.gps_lat ?? point?.[1]), lng = Number(assignedSite?.gps_lng ?? point?.[0]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? [{ id: assigned.id, kind: 'dispatch', priority: assigned.priority, sla_respond_by: assigned.sla_respond_by, lat, lng, dwell_seconds: Math.max(60, Number(assigned.expected_dwell_minutes ?? 5) * 60) }] : [];
    });
    const scheduledStops = (patrolStops ?? []).flatMap((stop) => {
      const site = Array.isArray(stop.site) ? stop.site[0] : stop.site;
      const point = site?.center_point?.coordinates;
      const lat = Number(site?.gps_lat ?? point?.[1]), lng = Number(site?.gps_lng ?? point?.[0]);
      return Number.isFinite(lat) && Number.isFinite(lng) ? [{ id: stop.id, kind: 'patrol_stop', priority: 'normal', sla_respond_by: stop.sla_arrive_by, lat, lng, dwell_seconds: Math.max(60, Number(stop.required_dwell_minutes) * 60) }] : [];
    });
    const stops = [...dispatchStops, ...scheduledStops];
    if (!stops.length) return json({ error: 'No routeable active work is assigned to this shift.' }, 422);
    const planResponse = await fetch(`${API_URL}/api/navigation/plan`, { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_lat: originLat, origin_lng: originLng, stops }) });
    const plan = await planResponse.json().catch(() => null);
    if (!planResponse.ok) return json({ error: plan?.error ?? 'Route plan is unavailable.' }, 502);
    return json(plan);
  }
  const site = Array.isArray(job.site) ? job.site[0] : job.site;
  const point = site?.center_point?.coordinates;
  const destinationLat = Number(site?.gps_lat ?? point?.[1]), destinationLng = Number(site?.gps_lng ?? point?.[0]);
  if (!Number.isFinite(destinationLat) || !Number.isFinite(destinationLng)) return json({ error: 'This location has no routeable coordinates.' }, 422);
  const response = await fetch(`${API_URL}/api/navigation/route`, { method: 'POST', headers: { Authorization: `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ origin_lat: originLat, origin_lng: originLng, destination_lat: destinationLat, destination_lng: destinationLng }) });
  const route = await response.json().catch(() => null);
  if (!response.ok) return json({ error: route?.error ?? 'Route guidance is unavailable.' }, 502);
  return json({ ...route, destination_address: site?.address ?? null, destination_lat: destinationLat, destination_lng: destinationLng });
});