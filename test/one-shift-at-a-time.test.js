const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const readSource = (relativePath) => fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8').replace(/\r\n/g, '\n');
const migration = readSource('../supabase/migrations/20260919070000_one_shift_at_a_time.sql');
const schedulePage = readSource('../apps/web/src/pages/OfficerSchedulePage.tsx');
const mobileClock = readSource('../apps/mobile/src/components/OfficerShiftClockPanel.tsx');
const types = readSource('../src/types/database.ts');

test('an officer is on at most one shift: the structure forbids two, and the trigger stops the earlier one rather than blocking the next', () => {
  assert.match(migration, /create unique index if not exists shifts_one_in_progress_per_officer_idx\n\s+on public\.shifts \(officer_user_id\) where status = 'in_progress';/);
  assert.match(migration, /check \(ended_reason is null or ended_reason in \('officer', 'superseded_by_next_shift'\)\)/);
  assert.match(migration, /superseded_by_shift_id uuid references public\.shifts\(id\) on delete set null/);
  assert.match(migration, /create trigger shifts_one_at_a_time\n\s+before insert or update of status on public\.shifts/);
  // Only a transition INTO in_progress acts; an already-running shift being touched must not stop anything.
  assert.match(migration, /if new\.status <> 'in_progress' or \(tg_op = 'UPDATE' and old\.status = 'in_progress'\) then\n\s+return new;/);
  assert.match(migration, /where s\.officer_user_id = new\.officer_user_id and s\.status = 'in_progress' and s\.id <> new\.id\n\s+for update/);
  assert.match(migration, /set status = 'completed', actual_end = coalesce\(actual_end, v_at\), ended_reason = 'superseded_by_next_shift', superseded_by_shift_id = new\.id/);
  assert.match(migration, /update public\.roster_slots set status = 'completed' where linked_shift_id = v_other\.id and status in \('published', 'accepted'\);/);
  assert.doesNotMatch(migration, /raise exception 'Officer is already on a shift/);
});

test('what was left open on the stopped shift goes on record, not into the void', () => {
  assert.match(migration, /'officer_shift_superseded', 'shifts', v_other\.id, jsonb_build_object\(/);
  for (const key of ['superseded_by_shift_id', 'open_stop_count', 'open_required_task_count', 'open_dispatch_job_count', 'active_welfare_alert_count', 'debrief_submitted']) {
    assert.ok(migration.includes(`'${key}',`), key);
  }
  assert.match(migration, /'rule', 'one shift at a time'/);
  assert.match(migration, /revoke all on function public\.shifts_one_at_a_time\(\) from public, anon, authenticated, service_role;/);
});

test('start_officer_shift names the shift it stopped in its receipt, and the officer\'s own End shift is recorded as such', () => {
  assert.match(migration, /drop function if exists public\.start_officer_shift\(uuid, uuid, text, double precision, double precision, text\);/);
  assert.match(migration, /superseded_shift_id uuid, superseded_service_type text, superseded_started_at timestamp with time zone\)/);
  assert.match(migration, /where s\.officer_user_id = v_shift\.officer_user_id and s\.status = 'in_progress' and s\.id <> v_shift\.id\n\s+order by s\.actual_start desc nulls last\n\s+limit 1;/);
  assert.match(migration, /'superseded_shift_id', v_prev_id,/);
  assert.match(migration, /set status = 'completed', actual_end = coalesce\(actual_end, v_completed_at\), ended_reason = 'officer'/);
  assert.match(types, /superseded_service_type: string \| null\n\s+superseded_shift_id: string \| null\n\s+superseded_started_at: string \| null/);
  assert.match(types, /ended_reason: string \| null/);
});

test('the officer is told before the earlier shift is ended, and afterwards on the receipt and the card', () => {
  assert.match(schedulePage, /const stillOn = assigned\.find\(\(item\) => item\.status === 'in_progress' && item\.id !== shift\.id\) \?\? null;/);
  assert.match(schedulePage, /if \(stillOn \|\| position\.status === 'off_site' \|\| position\.status === 'no_gps'\) setStartAdvisory\(\{ shift, position, coords, reason: '', stillOn \}\);/);
  assert.match(schedulePage, /startAdvisory\.stillOn \? "You're still on another shift"/);
  assert.match(schedulePage, /You can only be on one shift at a time, so starting this one ends it now\./);
  assert.match(schedulePage, /startAdvisory\.stillOn \? 'End it and start this one' : 'Start anyway'/);
  assert.match(schedulePage, /Your earlier \$\{\(receipt\.superseded_service_type \?\? 'other'\)\.replaceAll\('_', ' '\)\} shift was ended at \$\{at\}; anything left open on it is on record\./);
  assert.match(schedulePage, /ended_reason === 'superseded_by_next_shift' \? ' · ended when your next shift started' : ''/);
  assert.match(mobileClock, /receipt\.superseded_shift_id \? ` Your earlier/);
});
