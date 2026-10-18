const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');
const read = (p) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const sql = read('supabase/migrations/20261019100000_safety_risk_review_lifecycle.sql');

test('task attestations and private safety reviews are RPC-only and tenant scoped', () => {
  for (const table of ['dynamic_risk_assessments', 'safety_reviews']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(sql, /REVOKE ALL ON public\.dynamic_risk_assessments, public\.safety_reviews FROM anon, authenticated/);
  assert.match(sql, /officer_id = auth\.uid\(\) OR public\.is_admin_for_org\(organization_id\)/);
  assert.match(sql, /p_understood IS DISTINCT FROM true/);
  assert.match(sql, /v_item\.controls IS DISTINCT FROM v_controls/);
  assert.match(sql, /v_shift\.officer_user_id IS DISTINCT FROM auth\.uid\(\)/);
});
test('review reminders use the existing queue and an installed daily schedule', () => {
  assert.match(sql, /pg_advisory_xact_lock\(hashtext\('sweep_place_hazard_reviews'\)\)/);
  assert.match(sql, /'hazard_due:' \|\| v_h\.id::text \|\| ':' \|\| v_h\.review_due::text/);
  assert.match(sql, /cron\.schedule_in_database\('place-hazard-review-daily'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.sweep_place_hazard_reviews\(uuid\) FROM PUBLIC, anon, authenticated/);
});
test('H&S reports open reviews and investigations reuse the established spine', () => {
  assert.match(sql, /NEW\.report_type <> 'health_safety'/);
  assert.match(sql, /ON CONFLICT \(field_report_id\) DO NOTHING/);
  assert.match(sql, /public\.link_investigation_entity\(p_investigation_id, 'field_report'/);
  assert.match(sql, /Linked hazard must belong to the same organisation and place/);
  assert.doesNotMatch(sql, /CREATE TABLE public\..*investigation/);
});
test('web and native officers can submit signed dynamic assessments, never directly mutate them', () => {
  for (const p of ['apps/web/src/components/DynamicRiskAssessment.tsx', 'apps/mobile/src/components/OfficerTaskRiskAssessments.tsx']) {
    const source = read(p);
    assert.match(source, /rpc\('submit_dynamic_risk_assessment'/);
    assert.match(source, /rpc\('get_shift_risk_assessments'/);
    assert.match(source, /p_understood: understood/);
    assert.doesNotMatch(source, /from\('dynamic_risk_assessments'\)/);
    assert.match(source, /STOP WORK/);
  }
});
