const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260919080000_timesheet_work_follows_the_officer.sql'), 'utf8').replace(/\r\n/g, '\n');
const page = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/OfficerTimesheetPage.tsx'), 'utf8').replace(/\r\n/g, '\n');

const between = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
const readWork = between(migration, 'create or replace function public.get_officer_timesheet_work', 'create or replace function public.submit_officer_timesheet_from_work');
const submit = migration.slice(migration.indexOf('create or replace function public.submit_officer_timesheet_from_work'));

test('timesheet work is the officer\'s completed shifts from every branch, not only the home organisation', () => {
  assert.match(readWork, /from public\.shifts s\n\s+where s\.officer_user_id = v_user_id\n\s+and s\.status = 'completed' and s\.actual_start is not null and s\.actual_end is not null/);
  assert.doesNotMatch(readWork, /s\.organization_id = v_org_id/);
  assert.doesNotMatch(readWork, /d\.organization_id = v_org_id/);
  assert.match(readWork, /'organization_id', w\.organization_id/);
  assert.match(readWork, /'ended_reason', w\.ended_reason/);
  // the return shape the web and mobile clients already consume is unchanged
  assert.match(readWork, /returns table\(source_type text, source_id uuid, work_status text, started_at timestamp with time zone, ended_at timestamp with time zone, calculated_minutes integer, label text, metadata jsonb\)/);
});

test('unpaid breaks recorded on the shift come off the worked minutes; paid rest breaks do not', () => {
  assert.match(readWork, /case when not b\.is_paid then greatest\(0, extract\(epoch from \(least\(b\.ended_at, w\.w_end\) - greatest\(b\.started_at, w\.w_start\)\)\) \/ 60\) end/);
  assert.match(readWork, /where b\.ended_at is not null/);
  assert.match(readWork, /greatest\(0, floor\(extract\(epoch from \(ended_at - started_at\)\) \/ 60\) - deduct_minutes\)::integer as minutes/);
  assert.match(readWork, /'unpaid_break_minutes', coalesce\(bt\.unpaid_minutes, 0\), 'paid_break_minutes', coalesce\(bt\.paid_minutes, 0\)/);
});

test('rostered hours on the submitted timesheet follow the officer too, so branch work is not all overtime', () => {
  assert.match(submit, /into v_scheduled from public\.shifts s where s\.officer_user_id = v_user_id and s\.scheduled_start::date between p_period_start and p_period_end/);
  assert.doesNotMatch(submit, /s\.organization_id = v_staff\.organization_id and s\.officer_user_id/);
  // the timesheet itself still belongs to the employer (home organisation)
  assert.match(submit, /values \(v_staff\.organization_id, v_staff\.id, p_period_start, p_period_end, round\(v_scheduled, 2\), v_actual/);
  assert.match(submit, /for v_work in select \* from public\.get_officer_timesheet_work\(p_period_start, p_period_end\) loop/);
});

test('the officer timesheet page speaks plainly, defaults to this week and shows where the hours came from', () => {
  assert.match(page, /export const thisWeekSoFar = \(now = new Date\(\)\) =>/);
  assert.match(page, /monday\.setDate\(now\.getDate\(\) - \(\(now\.getDay\(\) \+ 6\) % 7\)\);/);
  assert.match(page, /useState\(\{ \.\.\.thisWeekSoFar\(\), adjustmentHours: '0', notes: '' \}\)/);
  assert.match(page, /void loadOfficerTimesheetWork\(form\.periodStart, form\.periodEnd\)/);
  assert.match(page, /Worked time: \$\{hoursAndMinutes\(workedMinutes\)\} across \$\{plural\(shiftCount, 'shift'\)\}/);
  assert.match(page, /min unpaid break taken off/);
  assert.match(page, /ended when your next shift started/);
  assert.match(page, /submitted: 'Waiting for review',\n\s+branch_checked: 'Checked by your branch',\n\s+approved: 'Approved',\n\s+rejected: 'Sent back to you',/);
  assert.match(page, /rejectedForPeriod \? 'Send corrected timesheet' : 'Send for approval'/);
  assert.match(page, /Your hours come from your shifts, not from what you type here\./);
  assert.match(page, /disabled=\{submitting \|\| !previewReady \|\| listUnavailable \|\| refreshingList \|\| Boolean\(alreadyCovering && !rejectedForPeriod\)\}/);
  // guarded paths kept
  assert.match(page, /if \(!profile\?\.id \|\| !profile\.organizationId\) \{/);
  assert.match(page, /\.from\('staff_profiles'\)[\s\S]*?\.eq\('organization_id', profile\.organizationId\)[\s\S]*?\.or\(`user_id\.eq\.\$\{profile\.id\},id\.eq\.\$\{profile\.id\}`\)/);
  assert.match(page, /\.from\('timesheets'\)[\s\S]*?\.eq\('organization_id', profile\.organizationId\)[\s\S]*?\.in\('staff_id', staffIds\)/);
  assert.match(page, /submitOfficerTimesheetFromWork\(eventIdRef\.current/);
});
