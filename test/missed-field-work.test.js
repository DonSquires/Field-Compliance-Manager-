const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, '..', relative), 'utf8');
const migration = read('supabase/migrations/20260920190000_missed_field_work_is_recorded.sql');
const rosterWords = read('apps/web/src/lib/rosterWords.ts');
const rosterPage = read('apps/web/src/pages/RosterOperationsPage.tsx');
const schedule = read('apps/web/src/pages/OfficerSchedulePage.tsx');
const notifications = read('apps/web/src/components/NotificationCenter.tsx');
const navigation = read('apps/web/src/lib/notificationNavigation.ts');

test('a shift nobody attended becomes a recorded fact with a human next step, not a silent on_track', () => {
  assert.match(migration, /'in_progress','completed','cancelled','missed'\]\)\);/);
  assert.match(migration, /'officer','superseded_by_next_shift','not_started'\]\)\);/);
  // during: late start told once to admins and to the officer; visits past arrive-by marked breached
  assert.match(migration, /p_dedup_key => 'shift_late_start:' \|\| r\.id::text\);/);
  assert.match(migration, /p_dedup_key => 'shift_late_start_officer:' \|\| r\.id::text\);/);
  assert.match(migration, /SET sla_status = 'breached', updated_at = p_now\s+FROM public\.shifts s/);
  // after: status missed, stops missed, audit row, critical notice for the last 24 h only
  assert.match(migration, /UPDATE public\.shifts SET status = 'missed', ended_reason = 'not_started', updated_at = p_now WHERE id = r\.id;/);
  assert.match(migration, /UPDATE public\.shift_stops SET status = 'missed', sla_status = 'breached', updated_at = p_now\s+WHERE shift_id = r\.id AND status IN \('pending', 'en_route'\);/);
  assert.match(migration, /'shift_missed', 'shifts', r\.id/);
  assert.match(migration, /IF r\.scheduled_end > p_now - interval '24 hours' THEN\s+PERFORM public\.enqueue_notification\(/);
  assert.match(migration, /set_config\('fcm\.silent_shift_notice', CASE WHEN r\.scheduled_end > p_now - interval '24 hours' THEN 'off' ELSE 'on' END, true\)/);
  // scheduled in-database, service identity only
  assert.match(migration, /cron\.schedule_in_database\('missed-field-work-sweep-every-5m', '\*\/5 \* \* \* \*', 'select public\.sweep_missed_field_work\(\);', 'postgres', NULL, TRUE\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.sweep_missed_field_work\(timestamptz, integer\) FROM PUBLIC, anon, authenticated;/);
});

test('the people who must act can see it: roster queue, officer notice, client delivery block', () => {
  assert.match(migration, /case when s\.status = 'missed' then 'missed'/);
  assert.match(migration, /if p_exception_type not in \('late_start', 'active_overrun', 'missed'\)/);
  assert.match(migration, /st\.status in \('skipped', 'cancelled', 'missed'\)\) as patrol_missed/);
  assert.match(migration, /when v_kind = 'missed' then 'You did not start the shift of '/);
  assert.match(rosterWords, /missed: 'Missed – nobody attended',/);
  assert.match(rosterPage, /missed: 'Shift missed – nobody attended' \}/);
  assert.match(schedule, /missed: 'Missed – you did not start this shift'/);
});

test("notifications reach the person wherever the work lives: a branch manager's home is the parent, the alerts are in the branch", () => {
  assert.doesNotMatch(notifications, /\.eq\('organization_id', profile\.organizationId\)/);
  assert.match(notifications, /organization:organization_id\(name\)/);
  assert.match(navigation, /if \(link === 'live-map' \|\| link === 'live_map'\) return \{ kind: 'admin_field_ops', area: 'live-map' \};/);
});
