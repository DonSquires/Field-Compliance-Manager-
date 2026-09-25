const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.resolve(__dirname, '../scripts/configure-rm-monthly-reporting.mjs'),
  'utf8',
);

test('R&M reporting configuration is guarded, idempotent, and audit-backed', () => {
  assert.match(source, /EXPECTED_AGREEMENTS = 17/);
  assert.match(source, /SELECT id INTO STRICT v_provider/);
  assert.match(source, /SELECT id INTO STRICT v_actor/);
  assert.match(source, /ON CONFLICT \(organization_id, template_code\)/);
  assert.match(source, /rm_monthly_reporting_configured/);
  assert.match(source, /portal_if_client_login/);
});

test('R&M reporting configuration cannot generate or send a report pack', () => {
  assert.match(source, /generate_not_before', '\$\{GENERATE_NOT_BEFORE\}'/);
  assert.match(source, /Configuration must not generate report packs/);
  assert.doesNotMatch(source, /INSERT INTO public\.monthly_report_packs/i);
  assert.doesNotMatch(source, /send-report-pack/);
});
