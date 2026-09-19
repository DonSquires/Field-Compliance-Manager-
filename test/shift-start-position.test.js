const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919050000_shift_start_position.sql'), 'utf8');
const schedulePage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerSchedulePage.tsx'), 'utf8');
const advisory = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/OfficerLocationAdvisory.tsx'), 'utf8');
const officerShell = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/shells/OfficerShell.tsx'), 'utf8');
const activeShift = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/hooks/useActiveShift.ts'), 'utf8');

test('the start position is evaluated against the shift places and is never a gate', () => {
  assert.match(migration, /create or replace function public\.evaluate_shift_start_position\(p_shift_id uuid, p_gps_lat double precision, p_gps_lng double precision\)/);
  assert.match(migration, /from public\.shift_stops st join public\.client_sites s on s\.id = st\.site_id/);
  assert.match(migration, /from public\.location_zones z/);
  assert.match(migration, /'shift_start_advisory_radius_m', null, 250\)/);
  assert.match(migration, /case when v_best\.inside then 'on_site' when v_best\.distance_m <= v_radius then 'near_site' else 'off_site' end/);
  assert.match(migration, /'status', 'no_gps'/);
  assert.match(migration, /'status', 'no_place'/);
  assert.doesNotMatch(migration, /raise exception 'Current position is outside/);
  assert.doesNotMatch(migration, /create temp table/i);
});

test('start_officer_shift keeps its guards, records the position and reason, and returns them', () => {
  assert.match(migration, /drop function if exists public\.start_officer_shift\(uuid, uuid, text, double precision, double precision\);/);
  assert.match(migration, /p_off_site_reason text default null\n\) returns table\(shift_id uuid, shift_status text, started_at timestamp with time zone, created boolean, position_status text, place_name text, distance_m numeric\)/);
  assert.match(migration, /raise exception 'Only the assigned officer or an administrator can start this shift'/);
  assert.match(migration, /if v_shift\.status not in \('scheduled', 'published', 'accepted'\) then/);
  assert.match(migration, /v_position := public\.evaluate_shift_start_position\(v_shift\.id, p_gps_lat, p_gps_lng\);/);
  assert.match(migration, /'start_position', v_position,\n\s+'off_site_reason', v_reason,/);
});

test('the schedule advises before an off-site or blind start and passes the reason through', () => {
  assert.match(schedulePage, /supabase\.rpc\('evaluate_shift_start_position', \{ p_shift_id: shift\.id, p_gps_lat: coords\.lat, p_gps_lng: coords\.lng \}\)/);
  assert.match(schedulePage, /if \(stillOn \|\| position\.status === 'off_site' \|\| position\.status === 'no_gps'\) setStartAdvisory\(/);
  assert.match(schedulePage, /p_off_site_reason: reason/);
  assert.match(schedulePage, /You can still start; the start is recorded as away from site and your supervisor can see that\./);
  assert.match(schedulePage, /Start anyway/);
});

test('the officer shell only warns about the geofence on a place-bound shift in progress, judged by the server', () => {
  assert.match(officerShell, /<OfficerLocationAdvisory shift=\{activeShift\} \/>/);
  assert.doesNotMatch(officerShell, /<PlaceContextBanner \/>/);
  assert.match(advisory, /const active = Boolean\(shift && shift\.status === 'in_progress'\);/);
  assert.match(advisory, /if \(!shift \|\| !active\) return null;/);
  assert.match(advisory, /supabase\.rpc\('evaluate_shift_start_position', \{ p_shift_id: shiftId, p_gps_lat: lat, p_gps_lng: lng \}\)/);
  assert.match(advisory, /const placeBound = position && !position\.route_shift && \(position\.place_count \?\? 0\) === 1;/);
  assert.match(advisory, /placeBound && position\.status === 'off_site'/);
  assert.match(advisory, /You have left \{place\}/);
  assert.doesNotMatch(advisory, /Outside the selected service geofence/);
});

test('the active shift is the officer own shift for today whichever branch rostered it', () => {
  assert.doesNotMatch(activeShift, /\.eq\('organization_id', organizationId\)/);
  assert.match(activeShift, /\.lte\('scheduled_start', todayEnd\.toISOString\(\)\)\n\s+\.gte\('scheduled_end', todayStart\.toISOString\(\)\)/);
  assert.match(activeShift, /\.in\('status', \['accepted', 'in_progress'\]\)/);
  assert.doesNotMatch(activeShift, /maybeSingle\(\)/);
});
