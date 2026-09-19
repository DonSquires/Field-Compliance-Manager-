const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260918130000_deputy_roster_import.sql'), 'utf8');

test('Deputy import keeps source evidence on slots and work units', () => {
  assert.match(migration, /alter table public\.roster_slots add column if not exists external_refs jsonb not null default '\{\}'::jsonb/);
  assert.match(migration, /alter table public\.roster_work_units add column if not exists external_refs jsonb not null default '\{\}'::jsonb/);
  for (const key of ['ems_minutes', 'ncr_minutes', 'purchase_order', 'req_ritm', 'area_export_code', 'pay_code', 'schedule_warning']) assert.match(migration, new RegExp(`'${key}'`));
});

test('the import never creates people and only creates internal work', () => {
  assert.doesNotMatch(migration, /insert into public\.user_profiles/);
  assert.doesNotMatch(migration, /insert into public\.staff_profiles/);
  assert.doesNotMatch(migration, /insert into public\.client_sites/);
  assert.doesNotMatch(migration, /insert into public\.patrol_routes/);
  assert.match(migration, /insert into public\.organization_workplaces\(organization_id, name, active, created_by\)/);
  assert.match(migration, /values \(p_operating_organization_id, v_item->>'deputy_name', 'internal'/);
  assert.match(migration, /raise exception 'Staff % does not belong to this branch'/);
  assert.match(migration, /raise exception 'Work unit % is not an active unit of this branch'/);
});

test('schedules become draft slots and leave becomes leave, both idempotent, timesheets only counted', () => {
  assert.match(migration, /insert into public\.roster_slots\(organization_id, work_unit_id, staff_id, scheduled_start, scheduled_end, status, client_request_id, notes, created_by, external_refs\)/);
  assert.match(migration, /'draft', \(v_item->>'key'\)::uuid/);
  assert.match(migration, /on conflict \(organization_id, client_request_id\) do nothing/);
  assert.match(migration, /if exists \(select 1 from public\.leave_requests where client_event_id = \(v_item->>'key'\)::uuid\)/);
  assert.match(migration, /\(v_item->>'leave_type'\) not in \('annual', 'sick', 'bereavement', 'parental', 'unpaid', 'other'\)/);
  assert.match(migration, /'timesheets_not_imported', coalesce\(\(p_manifest->>'timesheet_rows'\)::integer, 0\)/);
  assert.doesNotMatch(migration, /insert into public\.timesheets/);
});

test('the run is admin-only, replay-safe, batch-recorded and audited', () => {
  assert.match(migration, /public\.is_admin_for_org\(p_operating_organization_id\)/);
  assert.match(migration, /manifest_json->>'client_request_id' = p_client_request_id::text/);
  assert.match(migration, /'deputy_roster', 'applied'/);
  assert.match(migration, /'deputy_roster_import_applied', 'file_import_batches', v_batch\.id, v_receipt/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.apply_deputy_roster_import\(uuid, uuid, text, text, integer, jsonb, jsonb, jsonb, jsonb, jsonb\) FROM PUBLIC, anon;/);
});
