const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261106120300_report_service_delivery_summary.sql'), 'utf8');

test('listed CI place-workflow entrypoint runs service evidence database checks under BOB_TEST_POSTGRES', () => {
  const entrypoint = fs.readFileSync(path.join(__dirname, 'rm-simple-place-workflows.test.js'), 'utf8');
  const databaseTest = fs.readFileSync(path.join(__dirname, 'report-service-delivery-db.test.js'), 'utf8');
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'verify-pr.yml'), 'utf8');
  assert.match(entrypoint, /if \(process\.env\.BOB_TEST_POSTGRES === '1'\) require\('\.\/report-service-delivery-db\.test'\)/);
  assert.match(databaseTest, /skip: process\.env\.BOB_TEST_POSTGRES !== '1' && process\.env\.FCM_REPORT_DB_TEST !== '1'/);
  assert.match(workflow, /BOB_TEST_POSTGRES=1 node --test[^\n]*test\/rm-simple-place-workflows\.test\.js/);
});

test('service evidence is a count-only supplement, not private officer prose or invented financial cost', () => {
  assert.match(migration, /is_report_provider_custodian_for_org\(a.provider_organization_id\)/);
  assert.match(migration, /m.service_agreement_module_id/);
  assert.match(migration, /service_agreement_id <> a.id/);
  assert.match(migration, /distinct on \(coalesce\(r.client_event_id, r.id\)\)/);
  assert.match(migration, /recorded - represented/);
  assert.match(migration, /->'client'/);
  assert.doesNotMatch(migration, /\b(?:r\.(?:title|description|review_notes|follow_up_notes)|j\.(?:outcome_notes|briefing_notes)|d\.summary|act\.notes)\b/);
  assert.match(migration, /r\.report_type in \('incident', 'health_safety'\)/);
  assert.doesNotMatch(migration, /report_type[^\n]*'maintenance'/);
  assert.match(migration, /r\.reviewed_at is not null and r\.reviewed_by is not null/);
  assert.match(migration, /revoke all on function public\.report_service_delivery_summary.*authenticated/);
});

test('monthly PDF accepts only reconciled service counts and never renders arbitrary fields', async () => {
  const { monthlyActivityBlocks, serviceDeliveryRows } = await import('../supabase/functions/_shared/report-activity-sections.mjs');
  const counts = {
    reviewedReports: { recorded: 2, alreadyInActivity: 1, additional: 1 },
    completedDispatch: { recorded: 1, alreadyInActivity: 0, additional: 1 },
    completedStatic: { recorded: 1, alreadyInActivity: 0, additional: 1 },
  };
  const summary = { version: 1, counts, notes: 'PRIVATE', internal: { handoversReceived: 'PRIVATE' } };
  assert.equal(serviceDeliveryRows(summary).length, 3);
  assert.equal(serviceDeliveryRows({ version: 1, counts: {} }), null);
  assert.equal(serviceDeliveryRows({ version: 1, counts: { ...counts, completedStatic: { recorded: 3, alreadyInActivity: 0, additional: 1 } } }), null);
  const report = { version: 2, totals: {}, serviceDelivery: summary };
  const blocks = JSON.stringify(monthlyActivityBlocks({ activityReport: report }, { version: 2, lines: [] }));
  assert.match(blocks, /Officer Service Evidence/);
  assert.match(blocks, /Completed static attendances/);
  assert.match(blocks, /do not add these counts/);
  assert.doesNotMatch(blocks, /PRIVATE/);
});
