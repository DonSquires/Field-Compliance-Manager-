const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261108130000_manage_shift_record.sql'),
  'utf8',
);

const functionBody = (sql, header) => {
  const start = sql.indexOf(header);
  assert.notEqual(start, -1, `missing function: ${header}`);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  return sql.slice(open, close);
};

const squash = (text) => text.replace(/\s+/g, ' ').trim();

const body = squash(functionBody(migration, 'CREATE OR REPLACE FUNCTION public.manage_shift_record('));

test('requires an authenticated administrator for the shift organization', () => {
  assert.match(body, /if v_actor is null then raise exception 'Authentication required'/);
  assert.match(body, /if not public\.is_admin_for_org\(v_shift\.organization_id\) then/);
  assert.match(body, /'Roster administrator access required'/);
});

test('uses optimistic locking to avoid overwriting concurrent edits', () => {
  assert.match(body, /if p_expected_updated_at is not null and v_shift\.updated_at <> p_expected_updated_at then/);
  assert.match(body, /'Shift was updated by another session; please reload and try again'/);
});

test('requires a reason before applying any correction', () => {
  assert.match(body, /if v_reason is null then/);
  assert.match(body, /'A reason for the edit is required'/);
});

test('updates editable shift fields and appends an audit note', () => {
  assert.match(body, /scheduled_start = coalesce\(p_scheduled_start, scheduled_start\)/);
  assert.match(body, /scheduled_end = coalesce\(p_scheduled_end, scheduled_end\)/);
  assert.match(body, /actual_start = coalesce\(p_actual_start, actual_start\)/);
  assert.match(body, /actual_end = coalesce\(p_actual_end, actual_end\)/);
  assert.match(body, /service_type = coalesce\(nullif\(trim\(p_service_type\), ''\), service_type\)/);
  assert.match(body, /status = coalesce\(nullif\(trim\(p_status\), ''\), status\)/);
  assert.match(body, /notes = coalesce\(notes, ''\) \|\| E'\\n\['/);
  assert.match(body, /updated_at = v_now/);
});

test('writes an audit log entry for the correction', () => {
  assert.match(body, /insert into public\.audit_log/);
  assert.match(body, /'shift_record_corrected'/);
  assert.match(body, /'shifts', v_shift\.id/);
});

test('grants execute only to authenticated and service_role', () => {
  assert.match(migration, /revoke all on function public\.manage_shift_record\(/i);
  assert.match(migration, /grant execute on function public\.manage_shift_record\(/i);
  assert.match(migration, /to authenticated;/i);
  assert.match(migration, /to service_role;/i);
});
