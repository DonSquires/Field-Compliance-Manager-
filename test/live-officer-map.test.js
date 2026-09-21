const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const migration = read('supabase/migrations/20260920180000_breadcrumbs_follow_the_shift.sql');
const liveMap = read('apps/web/src/pages/LiveMapPage.tsx');
const dispatch = read('apps/web/src/pages/DispatchConsolePage.tsx');
const pinStatus = read('apps/web/src/lib/officerPinStatus.ts');

test("an officer's breadcrumb belongs to the shift's branch, carries the detected zone, and is idempotent", () => {
  // any shift of the authenticated officer, not only one at the home organisation
  assert.match(migration, /SELECT s\.\* INTO v_shift FROM public\.shifts s WHERE s\.id = p_shift_id AND s\.officer_user_id = v_user_id;/);
  assert.match(migration, /v_org_id := coalesce\(v_shift\.organization_id, v_home_org\);/);
  // zone detection never blocks the write
  assert.match(migration, /SELECT r\.matched_zone_id INTO v_zone_id FROM public\.resolve_context\(p_gps_lat, p_gps_lng, v_org_id, NULL, p_recorded_at\) r LIMIT 1;\s+EXCEPTION WHEN OTHERS THEN v_zone_id := NULL;/);
  assert.match(migration, /WHERE g\.officer_id = v_user_id AND g\.client_event_id = p_client_event_id/);
});

test('the live picture is one governed read for the operating branch and its branches', () => {
  assert.match(migration, /"get_live_officer_positions"\(p_organization_id uuid, p_since_minutes integer DEFAULT 240, p_zone_ids uuid\[\] DEFAULT NULL\)/);
  assert.match(migration, /IF NOT \(public\.is_admin_for_org\(p_organization_id\) OR public\.user_can_operate_organization\(p_organization_id\)\) THEN\s+RAISE EXCEPTION 'Not authorised to view live positions for this organisation';/);
  assert.match(migration, /v_reach := array\(SELECT DISTINCT d FROM unnest\(public\.get_descendant_organizations\(p_organization_id\) \|\| p_organization_id\) d\);/);
  // the zone filter uses the detected zone or the shift's zone (never a column that does not exist)
  assert.match(migration, /OR l\.detected_zone_id = ANY\(p_zone_ids\) OR os\.zone_id = ANY\(p_zone_ids\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION "public"\."get_live_officer_positions"\(uuid, integer, uuid\[\]\) FROM PUBLIC, "anon";/);
  // the page reads through it, scoped to the branch the dispatcher is working in
  assert.match(liveMap, /const branchId = operatingOrganizationId \?\? profile\?\.organizationId \?\? null;/);
  assert.match(liveMap, /supabase\.rpc\('get_live_officer_positions', \{ p_organization_id: branchId, p_since_minutes: 240, p_zone_ids: zoneIds \}\)/);
  assert.doesNotMatch(liveMap, /from\('officer_gps_log'\)|from\('welfare_alerts'\)|from\('officer_welfare_settings'\)/);
});

test('live surfaces refresh themselves and keep their map view', () => {
  assert.match(liveMap, /window\.setInterval\(\(\) => void loadPositions\(\), 30_000\)/);
  assert.match(liveMap, /document\.addEventListener\('visibilitychange', onVisible\)/);
  assert.match(liveMap, /const viewKey = `live-map:\$\{branchId \?\? 'none'\}`;/);
  assert.match(liveMap, /addLinzBaseLayers\(map, \{ collapsed: true \}\)/);
  assert.match(dispatch, /window\.setInterval\(\(\) => void loadPhaseA\(true\), 30_000\)/);
  assert.match(dispatch, /if \(!background\) setLoading\(true\);/);
});

test('the welfare clock starts at shift start before the first check-in, and never off shift', () => {
  assert.match(pinStatus, /const since = lastCheckinAt \?\? shiftStartedAt;/);
  assert.match(pinStatus, /if \(!Number\.isFinite\(elapsedMinutes\) \|\| elapsedMinutes < 0\) return null;/);
});
