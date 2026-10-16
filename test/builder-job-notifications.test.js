const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261016070000_builder_job_notifications.sql'),
  'utf8',
);

test('Builder terminal outcomes notify the requester once through the governed notification RPC', () => {
  assert.match(migration, /'builder_job'::text/);
  assert.match(migration, /CREATE TRIGGER builder_job_terminal_notification\s+AFTER UPDATE ON public\.builder_jobs/i);
  assert.match(migration, /COALESCE\(NEW\.autopilot_requested_by, NEW\.created_by\)/);
  assert.match(migration, /public\.enqueue_notification\([\s\S]*?p_category => 'builder_job'/);
  assert.match(migration, /p_link_page => 'builder'/);
  assert.match(migration, /builder_job_terminal:/);
});

test('slow-job alerts use the 45-minute default, include all progress receipts, and never cancel the job', () => {
  assert.match(migration, /p_after_minutes integer DEFAULT 45/);
  assert.match(migration, /FROM public\.builder_job_steps s/);
  assert.match(migration, /FROM public\.builder_model_runs m/);
  assert.match(migration, /FROM public\.builder_worker_runs w/);
  assert.match(migration, /COALESCE\(j\.autopilot_requested_by, j\.created_by\) IS NOT NULL/);
  assert.match(migration, /'awaiting_human'/);
  assert.doesNotMatch(migration, /'approval_pending'|'release_ready'/);
  assert.match(migration, /This is a warning only; the job has not been cancelled\./);
  assert.match(migration, /builder_job_slow:/);
  assert.match(migration, /'builder-slow-job-notifications-every-5m',\s+'\*\/5 \* \* \* \*'/);
});
