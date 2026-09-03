const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const migration = readFileSync(resolve(__dirname, '../supabase/migrations/20260903180000_timesheet_work_ledger.sql'), 'utf8');
const schema = readFileSync(resolve(__dirname, '../supabase/schema.sql'), 'utf8');

test('timesheet work ledger stores shift and dispatch job source entries', () => {
  assert.match(migration, /create table if not exists public\.timesheet_work_entries/);
  assert.match(migration, /source_type text not null/);
  assert.match(migration, /source_type in \('shift', 'dispatch_job'\)/);
  assert.match(migration, /work_status in \('completed', 'partial'\)/);
  assert.match(migration, /calculated_minutes integer/);
});

test('timesheet work RPC derives from completed and partial source timestamps', () => {
  assert.match(migration, /create or replace function public\.get_officer_timesheet_work/);
  assert.match(migration, /s\.actual_start/);
  assert.match(migration, /s\.actual_end/);
  assert.match(migration, /d\.completed_at/);
  assert.match(migration, /case when d\.status = 'completed'/);
});

test('timesheet submission stores derived hours and source snapshot', () => {
  assert.match(migration, /create or replace function public\.submit_officer_timesheet_from_work/);
  assert.match(migration, /work_derived_hours/);
  assert.match(migration, /adjustment_hours/);
  assert.match(migration, /timesheet_work_entries/);
  assert.match(migration, /timesheet_submitted_from_work/);
  assert.match(schema, /"work_derived_hours" numeric/);
  assert.match(schema, /"work_summary" "jsonb"/);
});
