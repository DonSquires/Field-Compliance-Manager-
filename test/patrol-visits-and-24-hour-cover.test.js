const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const spread = read('supabase/migrations/20260920130000_patrol_visits_spread_across_the_window.sql');
const overnight = read('supabase/migrations/20260920140000_patrol_windows_follow_the_shift_overnight.sql');
const rosterPage = read('apps/web/src/pages/RosterOperationsPage.tsx');
const stops = read('apps/web/src/components/OfficerPatrolStops.tsx');
const schedule = read('apps/web/src/pages/OfficerSchedulePage.tsx');
const crmPage = read('apps/web/src/pages/CRMPage.tsx');
const words = read('apps/web/src/lib/rosterWords.ts');

test('each contracted visit gets its own slice of the window the shift covers, and the officer is told the toolset', () => {
  assert.match(spread, /v_step := CASE WHEN v_visits > 1 THEN \(v_eff_close - v_eff_open\) \/ v_visits ELSE interval '0' END;/);
  assert.match(spread, /v_sla_open\s+:= v_eff_open \+ v_step \* \(v_visit - 1\);/);
  // a shift outside the contracted hours keeps the contract window so the breach is visible, not hidden
  assert.match(spread, /IF v_eff_close <= v_eff_open THEN[\s\S]*v_eff_open\s+:= v_window_open;/);
  // the generator is no longer executable by PUBLIC / anon
  assert.match(spread, /REVOKE ALL ON FUNCTION "public"\."generate_shift_stops"\(p_shift_id uuid, p_shift_date date\) FROM PUBLIC, "anon";/);
  assert.match(spread, /'modules', coalesce\(\(select jsonb_agg\(jsonb_build_object\('module_key', m\.module_key, 'is_required', m\.is_required, 'status', m\.status\)/);
  assert.match(stops, /export const stopToolset = /);
  assert.match(stops, /<span className="patrol-stop-toolset">\{stopToolset\(stop\)\}<\/span>/);
});

test('the roster is told about the contracted hours, and a shift outside them or too short for the visits', () => {
  assert.match(spread, /"preview_work_unit_coverage"\(p_work_unit_id uuid, p_shift_date date, p_scheduled_start timestamptz DEFAULT NULL, p_scheduled_end timestamptz DEFAULT NULL\)/);
  assert.match(spread, /'outside_window', v_outside_window,\s+'too_short_for_visits', v_too_short,/);
  assert.match(rosterPage, /p_scheduled_start: startDate\.toISOString\(\), p_scheduled_end: endDate && endDate > startDate \? endDate\.toISOString\(\) : null/);
  assert.match(rosterPage, /This shift is outside the contracted hours \(\$\{hours\}\) for this run\./);
  assert.match(rosterPage, /this shift is too short to fit them\./);
});

test('patrols are 24-hour, 7-day work by default; Monday starts the week; overnight windows follow the shift (owner ruling 2026-09-20)', () => {
  // server: no window = any time of day; the helper anchors last night's window for a shift that starts after midnight
  assert.match(overnight, /IF p_window_start IS NULL THEN\s+RETURN QUERY SELECT NULL::timestamptz, NULL::timestamptz;/);
  assert.match(overnight, /AND \(v_open - interval '1 day'\) < p_shift_end AND p_shift_start < \(v_close - interval '1 day'\) THEN\s+v_open := v_open - interval '1 day';/);
  assert.match(overnight, /FROM public\.patrol_window_bounds\(p_shift_date, v_config\.window_start, v_config\.window_end, v_shift\.scheduled_start, v_shift\.scheduled_end\) b;/);
  assert.match(overnight, /from public\.patrol_window_bounds\(p_shift_date, v_cfg\.window_start, v_cfg\.window_end, p_scheduled_start, p_scheduled_end\) b;/);
  assert.match(overnight, /-- Any time of day: the visits are spread across the shift\./);
  // ISO weekdays everywhere the schema decides a day
  assert.match(overnight, /extract\(isodow FROM p_shift_date\)/);
  assert.doesNotMatch(overnight, /extract\(dow\b/i);
  // words: Monday-first, every day / any time by default
  assert.match(words, /const ISO_DAY_SHORT = \['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'\];/);
  assert.match(words, /if \(set\.length === 0 \|\| set\.length === 7\) return 'every day';/);
  assert.match(words, /start \? `\$\{start\.slice\(0, 5\)\}\\u2013\$\{end \? end\.slice\(0, 5\) : 'end of shift'\}` : 'any time of day \(24-hour\)'/);
  assert.match(crmPage, /activeDays: \[1,2,3,4,5,6,7\]/);
  assert.match(crmPage, /Days run Monday to Sunday\. Leave both window times empty when the work can be required at any time of day \(24-hour cover\)/);
  assert.match(crmPage, /\{contractedDaysWords\(schedule\.active_days\)\} · \{contractedHoursWords\(schedule\.window_start, schedule\.window_end\)\}/);
  assert.doesNotMatch(crmPage, /schedule\.active_days\.join\(', '\)/);
});

test("the officer's schedule headlines the work unit and only calls an accepted shift confirmed", () => {
  assert.match(schedule, /const nextShiftHeading = !nextShift \|\| nextShift\.status === 'accepted' \? 'Your next confirmed shift' : nextShift\.status === 'published' \? 'Your next shift · waiting for your answer' : 'Your next shift';/);
  assert.match(schedule, /<strong>\{unit\?\.name \?\? shift\.service_type\.replaceAll\('_', ' '\)\}<\/strong>/);
});
