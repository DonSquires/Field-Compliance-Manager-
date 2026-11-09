const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261109150000_report_disclosure_rules.sql'), 'utf8');

const body = () => {
  const start = sql.indexOf('create or replace function public.build_agreement_activity_report_core(');
  assert.ok(start >= 0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
};

const seededRule = (code) => {
  const at = sql.indexOf(`('${code}',`);
  assert.ok(at >= 0, `${code} is seeded`);
  return sql.slice(at, sql.indexOf('\n\t(', at + 1));
};

test('the report core carries no withholding vocabulary or category literals', () => {
  const fn = body();
  for (const literal of ["'cardreview'", "'startshift'", "'travel', 'admin', 'administration'", "'Incidents and investigations'", "time '00:00'"]) {
    assert.ok(!fn.includes(literal), `${literal} is data, not code`);
  }
  assert.match(fn, /from public\.report_disclosure_rules r/);
  assert.match(fn, /from public\.report_activity_categories c/);
  assert.match(fn, /public\.report_rule_conditions_match\(r\.conditions, f\.facts\)/);
  assert.match(fn, /public\.report_rule_conditions_match\(r\.conditions, a\.facts \|\| jsonb_build_object\('category', a\.category\)\)/);
});

test('the most specific rule per code wins and inactive overrides switch a platform rule off', () => {
  const fn = body();
  assert.match(fn, /select distinct on \(r\.rule_code\) r\.\*/);
  assert.match(fn, /\(r\.client_organization_id is not null\) desc,\s*\(r\.provider_organization_id is not null\) desc/);
  assert.match(fn, /\) r\s*where r\.active/);
});

test('every withheld entry is still accounted for, whatever its reason', () => {
  const fn = body();
  assert.match(fn, /count\(\*\) filter \(where withheld_reason is not null\) from acts\) as withheld_total/);
  assert.match(fn, /'operationalWithheld', sc\.withheld_total/);
  assert.match(fn, /'withheldByReason'/);
  assert.match(fn, /and sc\.all_entries = t\.entries \+ sc\.withheld_total/);
  assert.match(fn, /then 'duplicate'/);
});

test('status-only inspections are withheld for every client unless something was found', () => {
  const rule = seededRule('withhold.routine_status_check');
  assert.match(rule, /'withhold', null, 'routine_check'/);
  assert.match(rule, /"field":"category","operator":"in","values":\["inspection"\]/);
  assert.match(rule, /"field":"photos","operator":"max","value":0/);
  assert.match(rule, /"field":"action","operator":"empty"/);
  assert.match(rule, /"field":"note","operator":"in","normalize":"letters","values":\["","open","closed"/);
  assert.match(sql, /insert into public\.report_disclosure_reasons[\s\S]*'routine_check'/);
});

test('the earlier owner rulings are reproduced as platform rules', () => {
  assert.match(seededRule('category.card_review_camera'), /'camera_activation'[\s\S]*"values":\["cardreview"\]/);
  assert.match(seededRule('category.patrol_log_desk_midnight'), /'administration'[\s\S]*"values":\["00:00"\]/);
  assert.match(seededRule('withhold.shift_marker'), /"startshift"/);
  assert.match(seededRule('withhold.routine_card'), /"field":"note_action","operator":"regex","normalize":"words"/);
});

test('rules are validated, scoped, readable by tenant admins only and documented for Bob', () => {
  assert.match(sql, /constraint report_disclosure_rules_conditions_valid check \(public\.report_rule_conditions_valid\(conditions\)\)/);
  assert.match(sql, /using \(provider_organization_id is null or public\.is_tenant_import_admin\(provider_organization_id\)\)/);
  assert.match(sql, /revoke all on table public\.report_disclosure_rules from public, anon, authenticated;/);
  assert.match(sql, /revoke all on function public\.build_agreement_activity_report_core\([^)]*\) from public, anon, authenticated, service_role;/);
  assert.match(sql, /insert into public\.bob_knowledge_cards[\s\S]*'report_disclosure\.rules'/);
});
