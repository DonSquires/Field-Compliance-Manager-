const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const schedule = read('supabase/migrations/20260920150000_zone_active_schedule_human_editable.sql');
const version = read('supabase/migrations/20260920160000_geography_carries_configuration_version.sql');
const reach = read('supabase/migrations/20260920170000_geography_follows_org_reach.sql');
const editor = read('apps/web/src/components/ZoneScheduleEditor.tsx');
const words = read('apps/web/src/lib/zoneSchedule.ts');
const zonePage = read('apps/web/src/pages/ZoneDetailPage.tsx');
const prefs = read('apps/web/src/lib/mapPreferences.ts');
const houseMap = read('apps/web/src/components/LocationHouseMap.tsx');

test('zone activation schedules are Monday-first, human-editable, version-checked and audited (owner ruling 2026-09-20)', () => {
  assert.match(schedule, /v_isodow\s+int := extract\(isodow from v_local\)::int;/);
  assert.doesNotMatch(schedule, /extract\(dow\b/i);
  // a legacy 0 still means Sunday, so nothing written under the old convention flips silently
  assert.match(schedule, /legacy 0 (is )?still (means )?Sunday/i);
  assert.match(schedule, /"public"\."manage_zone_active_schedule"\(\s*p_zone_id uuid,\s*p_expected_version integer,\s*p_days integer\[\] DEFAULT NULL,\s*p_start time DEFAULT NULL,\s*p_end time DEFAULT NULL,\s*p_months integer\[\] DEFAULT NULL\s*\)/);
  assert.match(schedule, /raise exception 'Active CRM administrator required for this zone'/);
  assert.match(schedule, /raise exception 'Zone configuration changed since it was opened; reload and try again'/);
  assert.match(schedule, /raise exception 'Days must be 1 \(Monday\) to 7 \(Sunday\)'/);
  assert.match(schedule, /raise exception 'Give both a start and an end time, or neither for any time of day'/);
  assert.match(schedule, /configuration_version = configuration_version \+ 1/);
  assert.match(schedule, /jsonb_build_object\('before', v_before, 'after', v_zone\.active_schedule, 'configuration_version', v_zone\.configuration_version\)/);
  assert.match(schedule, /REVOKE ALL ON FUNCTION "public"\."manage_zone_active_schedule"\(uuid, integer, integer\[\], time, time, integer\[\]\) FROM PUBLIC, "anon";/);
  // the page writes only through the RPC, with the version it was opened at
  assert.match(editor, /supabase\.rpc\('manage_zone_active_schedule', \{ p_zone_id: zone\.id, p_expected_version: zone\.configuration_version, \.\.\.zoneScheduleArgs\(draft\) \}\)/);
  assert.match(words, /export const ALWAYS_ACTIVE: ZoneSchedule = \{ days: \[1, 2, 3, 4, 5, 6, 7\], months: \[\], start: '', end: '' \};/);
  assert.match(zonePage, /<ZoneScheduleEditor/);
  assert.doesNotMatch(zonePage, /JSON\.stringify\(selected\.active_schedule\)/);
});

test('the Zones page can actually save: geography carries configuration_version and follows the org reach', () => {
  // the payload rows are to_jsonb(x), so the version travels as a selected column on both sites and zones
  for (const migration of [version, reach]) {
    assert.match(migration, /select distinct s\.id,[^\n]*,s\.configuration_version\s*\n\s+from public\.client_sites s/);
    assert.match(migration, /select distinct z\.id,[^\n]*,z\.configuration_version\s*\n\s+from public\.location_zones z/);
  }
  assert.match(reach, /v_reach := array\(select distinct d from unnest\(public\.get_descendant_organizations\(v_provider\) \|\| v_provider\) d\);/);
  assert.match(reach, /sa\.provider_organization_id=any\(v_reach\) and sa\.invitation_status='accepted' and sa\.agreement_type='operational'/);
});

test('maps come back the way they were left: one instance per surface, remembered base layer and viewport', () => {
  assert.match(prefs, /const BASE_LAYER_KEY = 'fcm\.map\.baseLayer';/);
  assert.match(prefs, /const VIEW_PREFIX = 'fcm\.map\.view:';/);
  assert.match(prefs, /map\.on\('baselayerchange', /);
  assert.match(prefs, /export function rememberViewport\(map: L\.Map, key: string\): void/);
  assert.match(prefs, /export function restoreViewportOr\(map: L\.Map, key: string, frame: \(\) => void\): boolean/);
  // the house map no longer tears the map down on every probe click; the overlay group is what re-renders
  assert.match(houseMap, /addLinzBaseLayers\(/);
  assert.match(houseMap, /rememberViewport\(/);
  assert.match(houseMap, /restoreViewportOr\(/);
  assert.doesNotMatch(houseMap, /\}, \[sites, zones, linzPreview, probePoint, resolution, house\.name\]\);/);
});

test('a human can adjust a live boundary without redrawing it: stage the current shape, insert and remove vertices', () => {
  assert.match(houseMap, /Adjust current boundary/);
  assert.match(houseMap, /is-midpoint/);
  assert.match(houseMap, /marker\.on\('contextmenu'/);
  assert.match(houseMap, /adjusted_from: 'current_boundary'/);
  assert.match(houseMap, /points && points\.length > 3 \? points\.filter/);
});
