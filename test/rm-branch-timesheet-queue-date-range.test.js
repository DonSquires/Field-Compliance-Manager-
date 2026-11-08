const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase', 'migrations', '20261108130100_branch_timesheet_queue_date_range.sql'),
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

const body = squash(functionBody(migration, 'CREATE OR REPLACE FUNCTION public.get_branch_timesheet_queue('));

test('retains the original single-parameter signature for backward compatibility', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_branch_timesheet_queue\(\s*p_operating_organization_id uuid,/);
});

test('adds optional date range parameters with null defaults', () => {
  assert.match(migration, /p_from timestamp with time zone DEFAULT NULL/);
  assert.match(migration, /p_to timestamp with time zone DEFAULT NULL/);
});

test('filters by period range when a range is supplied', () => {
  assert.match(body, /and \(p_from is null or t\.period_end >= p_from::date\)/);
  assert.match(body, /and \(p_to is null or t\.period_start <= p_to::date\)/);
});

test('preserves branch authority scoping and returns the queue', () => {
  assert.match(body, /public\.user_can_operate_organization\(p_operating_organization_id\)/);
  assert.match(body, /public\.user_can_exercise_branch_authority\(/);
  assert.match(body, /return query select/);
  assert.match(body, /order by t\.period_start desc;/);
});

test('grants execute only to authenticated and service_role', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_branch_timesheet_queue\(/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_branch_timesheet_queue\(/i);
  assert.match(migration, /TO authenticated;/i);
  assert.match(migration, /TO service_role;/i);
});
