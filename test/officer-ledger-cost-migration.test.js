const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', file), 'utf8');
const ledger = read('20261106120400_officer_records_report_ledger.sql');
const cost = read('20261106120500_cost_of_service_summary.sql');
const code = (sql) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

test('officer ledger projectors are internal security-definer functions', () => {
  for (const fn of [
    'officer_report_inherit_shift_place()',
    'project_officer_field_report_to_ledger(uuid)',
    'project_dispatch_job_to_ledger(uuid)',
    'tg_project_officer_field_report_to_ledger()',
    'tg_project_dispatch_job_to_ledger()',
  ]) {
    assert.ok(ledger.includes(`revoke all on function public.${fn} from public, anon, authenticated, service_role;`), fn);
    assert.ok(!new RegExp(`grant execute on function public\\.${fn.replace(/[()]/g, '\\$&')}`).test(ledger), fn);
  }
  assert.equal((ledger.match(/security definer\s+set search_path = ''/g) || []).length, 5);
});

test('officer ledger projection is idempotent, reviewed-only and privacy-safe', () => {
  const body = code(ledger);
  assert.equal((body.match(/on conflict \(organization_id, event_type, external_ref\) where external_ref is not null do nothing/g) || []).length, 2);
  assert.match(body, /r\.report_type = 'maintenance'/);
  assert.match(body, /'client_site_hazard'/);
  assert.match(body, /reviewed_by/);
  assert.doesNotMatch(body, /briefing_notes/);
  assert.doesNotMatch(body, /persons_involved|latitude|longitude/);
  assert.doesNotMatch(body, /'title'\s*,/);
});

test('cost of service summary fails closed and is authenticated-only', () => {
  assert.match(cost, /if auth\.uid\(\) is null then/);
  assert.match(cost, /public\.is_admin_for_org\(p_organization_id\) is not true/);
  assert.match(cost, /security definer\s+set search_path = ''/);
  assert.match(cost, /revoke all on function public\.get_cost_of_service_summary\(uuid, date, date\) from public, anon, authenticated, service_role;/);
  assert.match(cost, /grant execute on function public\.get_cost_of_service_summary\(uuid, date, date\) to authenticated;/);
  assert.doesNotMatch(code(cost), /officer_user_id'\s*,|'officerId'|'staffId'/);
});
