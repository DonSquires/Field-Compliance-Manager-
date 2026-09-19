const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919060000_end_shift.sql'), 'utf8');
const dialog = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/EndShiftDialog.tsx'), 'utf8');
const schedulePage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerSchedulePage.tsx'), 'utf8');
const homePage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerHomePage.tsx'), 'utf8');
const debriefPage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerDebriefPage.tsx'), 'utf8');
const types = fs.readFileSync(path.resolve(__dirname, '../src/types/database.ts'), 'utf8');

test('get_shift_end_readiness tells the officer, in plain words, what is still open before a shift can end', () => {
  assert.match(migration, /create or replace function public\.get_shift_end_readiness\(p_shift_id uuid\)/);
  assert.match(migration, /\nstable\n/);
  assert.doesNotMatch(migration, /create temp table/i);
  assert.match(migration, /raise exception 'Only the assigned officer or an administrator can review this shift'/);
  // text || text[] parses as an array literal in plpgsql; blockers must be appended one at a time
  assert.match(migration, /v_blockers := array_append\(v_blockers, format\('%s %s still open'/);
  assert.match(migration, /v_blockers := array_append\(v_blockers, 'The debrief has not been recorded'\)/);
  assert.doesNotMatch(migration, /v_blockers := v_blockers \|\|/);
  assert.match(migration, /'can_end', v_shift\.status = 'in_progress' and v_open_stop_count = 0 and v_open_modules = 0 and v_open_jobs = 0 and v_alerts = 0 and v_debrief,/);
  assert.match(migration, /'can_end_after_debrief', v_shift\.status = 'in_progress' and v_open_stop_count = 0 and v_open_modules = 0 and v_open_jobs = 0 and v_alerts = 0/);
  assert.match(migration, /grant execute on function public\.get_shift_end_readiness\(uuid\) to postgres, authenticated, service_role;/);
});

test('complete_officer_shift keeps every rule, records the end position, and replaces the old two-argument overload', () => {
  assert.match(migration, /drop function if exists public\.complete_officer_shift\(uuid, text\);/);
  assert.match(migration, /returns table\(shift_id uuid, shift_status text, completed_at timestamp with time zone\)/);
  for (const rule of [
    'Shift does not belong to the authenticated officer',
    'Only an in-progress shift can be completed',
    'Submit the shift debrief before completing the shift',
    'Complete or skip every shift stop',
    'Complete or cancel every dispatch job',
    'Resolve active welfare alerts before completing the shift',
  ]) assert.ok(migration.includes(rule), rule);
  assert.match(migration, /'end_position', v_position/);
  assert.match(migration, /grant execute on function public\.complete_officer_shift\(uuid, text, double precision, double precision\) to postgres, authenticated, service_role;/);
  assert.match(types, /complete_officer_shift: \{\n\s+Args: \{ p_expected_status: string; p_gps_lat\?: number \| null; p_gps_lng\?: number \| null; p_shift_id: string \}/);
  assert.match(types, /get_shift_end_readiness: \{\n\s+Args: \{ p_shift_id: string \}\n\s+Returns: Json/);
});

test('the End shift dialog reads readiness, takes the missing debrief, then ends with the position', () => {
  assert.match(dialog, /supabase\.rpc\('get_shift_end_readiness', \{ p_shift_id: shiftId \}\)/);
  assert.match(dialog, /if \(needsDebrief\) \{[\s\S]*supabase\.rpc\('submit_shift_debrief'/);
  assert.match(dialog, /supabase\.rpc\('complete_officer_shift', \{ p_shift_id: shiftId, p_expected_status: shiftStatus, p_gps_lat: coords\.lat, p_gps_lng: coords\.lng \}\)/);
  assert.match(dialog, /readiness\.can_end \|\| \(readiness\.can_end_after_debrief && debriefReady\)/);
  assert.match(dialog, /summary\.trim\(\)\.length >= 10/);
  assert.match(dialog, /Everything below needs a tick before the shift can end\./);
  assert.match(dialog, /needsDebrief \? 'Record debrief and end shift' : 'End shift'/);
  assert.match(dialog, /<button type="button" onClick=\{onClose\}>Not yet<\/button>/);
});

test('End shift is offered on the in-progress card of the schedule and on the home page, and the debrief page says End, not Complete', () => {
  assert.match(schedulePage, /className="officer-end-shift-button" onClick=\{\(\) => setEndingShift\(shift\)\}>End shift<\/button>/);
  assert.match(schedulePage, /<EndShiftDialog shiftId=\{endingShift\.id\}/);
  assert.match(homePage, /shift\.status === 'in_progress' && <button type="button" className="officer-end-shift" onClick=\{\(\) => setEndingShift\(true\)\}>End shift<\/button>/);
  assert.match(homePage, /\{endingShift && shift && <EndShiftDialog shiftId=\{shift\.id\}/);
  assert.match(homePage, /onNavigate\('timesheet'\)\}>Open timesheet<\/button>/);
  assert.match(debriefPage, /<CheckCircle2 size=\{16\} \/>End shift<\/>/);
  assert.match(debriefPage, /Ending the shift checks that every stop, required task, dispatch job and welfare alert is closed\./);
  assert.doesNotMatch(debriefPage, /Complete shift/);
  assert.match(debriefPage, /Debrief recorded\. End the shift when all field work is finished\./);
});
