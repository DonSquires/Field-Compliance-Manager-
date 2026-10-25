const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260920020000_alarm_signal_and_sla_clock_close.sql'), 'utf8');
const console = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/DispatchConsolePage.tsx'), 'utf8');
const ladder = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/lib/alarmResponse.ts'), 'utf8');

test('the alarm behind an alarm-response job is a record, one per job, written only through the governed RPC', () => {
  assert.match(migration, /create unique index if not exists alarm_events_one_per_dispatch_job on public\.alarm_events \(dispatch_job_id\) where dispatch_job_id is not null;/);
  assert.match(migration, /create or replace function public\.record_alarm_signal\(/);
  assert.match(migration, /if not found or not public\.is_admin_for_org\(v_job\.organization_id\) then raise exception 'Dispatch job not found or access denied'; end if;/);
  assert.match(migration, /raise exception 'The alarm received time cannot be in the future'/);
  assert.match(migration, /p_signal_type not in \('burglary', 'panic_duress', 'fire', 'medical', 'tamper', 'power_fail', 'unknown'\)/);
  assert.match(migration, /p_intake_channel not in \('phone', 'email', 'sms', 'radio', 'monitoring_portal', 'other'\)/);
  assert.match(migration, /on conflict \(dispatch_job_id\) where dispatch_job_id is not null do update/);
  assert.match(migration, /'alarm_signal_recorded', 'alarm_events'/);
  assert.match(migration, /revoke all on function public\.record_alarm_signal\(uuid, timestamptz, text, text, text, text, text, text, text\) from public, anon;/);
});

test('the response target counts from the alarm, and the SLA clock closes when the officer is on scene', () => {
  assert.match(migration, /set sla_respond_by = p_received_at \+ make_interval\(mins => j\.sla_minutes\)/);
  assert.match(migration, /set started_at = p_received_at, alarm_event_id = v_event\.id/);
  assert.match(migration, /create or replace function public\.tg_dispatch_job_close_sla_clock\(\) returns trigger/);
  assert.match(migration, /create trigger trg_dispatch_job_close_sla_clock after update of on_scene_at, status on public\.dispatch_jobs/);
  assert.match(migration, /when c\.target_minutes is null or ceil\(extract\(epoch from \(new\.on_scene_at - c\.started_at\)\) \/ 60\.0\) <= c\.target_minutes then 'met' else 'breached' end/);
  assert.match(migration, /set status = 'cancelled', updated_at = now\(\) where c\.dispatch_job_id = new\.id and c\.status = 'running'/);
  // clocks left running after arrival are corrected once
  assert.match(migration, /where j\.id = c\.dispatch_job_id and c\.status = 'running' and j\.on_scene_at is not null;/);
});

test('the dispatch console records the alarm through the RPC and never filters dispatch_jobs by a zone_id it does not have', () => {
  assert.match(console, /supabase\.rpc\('record_alarm_signal', \{/);
  assert.match(console, /p_received_at: new Date\(formAlarmReceivedAt\)\.toISOString\(\)/);
  assert.match(console, /Job created, but the alarm time was not recorded: \$\{alarmError\.message\}\. The response clock is counting from when the job was created\./);
  assert.doesNotMatch(console, /from\('dispatch_jobs'\)[\s\S]{0,400}\.in\('zone_id'/);
  assert.match(console, /\.eq\('service_agreement_id', selectedAgreement\.id\)/);
  // datetime-local defaults are local wall clock, never toISOString().slice
  assert.doesNotMatch(console, /new Date\(\)\.toISOString\(\)\.slice\(0, 16\)/);
  assert.match(console, /useState\(\(\) => localDateTimeValue\(new Date\(\)\)\)/);
  assert.match(console, /from\('alarm_events'\)\.select\('dispatch_job_id, received_at, signal_type, intake_channel, panel_id, zone_name, zone_number, account_number'\)\.in\('dispatch_job_id', alarmJobIds\)/);
  assert.match(console, /<h3>Response so far<\/h3>/);
  const createJobDependencies = console.match(/const handleCreateJob = useCallback\([\s\S]*?\}, \[([^\]]+)\]\);/);
  assert.ok(createJobDependencies, 'job creation must retain its callback dependencies');
  for (const dependency of ['formAlarmIntakeChannel', 'formAlarmSignalType', 'formAlarmReceivedAt']) {
    assert.ok(createJobDependencies[1].split(',').map(value => value.trim()).includes(dependency), `${dependency} must be a job-creation dependency`);
  }
});

test('the ladder speaks in minutes after the alarm and says when the clock is only counting from the job', () => {
  assert.match(ladder, /min after \$\{anchorLabel\}/);
  assert.match(ladder, /inside the \$\{job\.slaMinutes\} min target\./);
  assert.match(ladder, /min over the \$\{job\.slaMinutes\} min target\./);
  assert.match(ladder, /No alarm time is recorded, so the clock counts from when the job was created\./);
  assert.match(ladder, /Cancelled before anyone was on scene\./);
});

test('every ladder step is stamped when a job enters that status, whichever governed path moved it', () => {
  const stamps = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260920030000_dispatch_job_milestone_stamps.sql'), 'utf8');
  assert.match(stamps, /create trigger trg_dispatch_job_stamp_milestones before update of status on public\.dispatch_jobs/);
  assert.match(stamps, /if new\.status = 'dispatched' and new\.dispatched_at is null then new\.dispatched_at := now\(\); end if;/);
  assert.match(stamps, /if new\.status = 'on_scene' and new\.on_scene_at is null then new\.on_scene_at := now\(\); end if;/);
  assert.match(stamps, /if new\.status in \('acknowledged', 'en_route', 'on_scene', 'completed'\) and new\.dispatched_at is null then new\.dispatched_at := now\(\); end if;/);
});

test('the console only offers agreements the operating branch holds, and lets the dispatcher pick one', () => {
  assert.match(console, /const branchAgreements = useMemo\(\(\) => agreements\.filter\(\(agreement\) => agreement\.provider_organization_id === operatingBranchId\)/);
  assert.match(console, /if \(!selectedAgreement \|\| selectedAgreement\.provider_organization_id !== operatingBranchId\) selectAgreement\(branchAgreements\[0\]\.id\);/);
  assert.match(console, /<select id="dispatch-agreement" value=\{selectedAgreement\?\.id \?\? ''\} onChange=\{\(event\) => selectAgreement\(event\.target\.value \|\| null\)\}>/);
  assert.match(console, /This branch holds no service agreement yet/);
  assert.match(console, /disabled=\{saving \|\| !selectedAgreement \|\| selectedAgreement\.provider_organization_id !== operatingBranchId/);
});
