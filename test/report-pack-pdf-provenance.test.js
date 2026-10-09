const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.resolve(__dirname, '../supabase/functions/generate-report-pack-pdf/index.ts'),
  'utf8',
);

test('report-pack PDFs expose source snapshot provenance and scope', () => {
  assert.match(source, /Report pack ID: \$\{packId\}/);
  assert.match(source, /Source snapshot generated:/);
  assert.match(source, /Renderer: \$\{rendererVersion\}/);
  assert.match(source, /governed FCM report-pack snapshot/);
  assert.match(source, /generated_at/);
});

test('monthly PDFs render agreement-scoped activity sections without provider-wide totals', () => {
  assert.match(source, /'fcm-report-pack-pdf-lib-a4-v5'/);
  assert.match(source, /Patrol and Activity Summary/);
  assert.match(source, /Site Coverage/);
  assert.match(source, /Service Level Performance/);
  assert.match(source, /patrolVisits/);
  assert.match(source, /cameraActivations/);
  assert.match(source, /vehicleObservations/);
  assert.match(source, /patrolTravelKm/);
  const monthlyRenderer = source.slice(source.indexOf('const drawMonthlySections'), source.indexOf("draw('Field Compliance Manager'"));
  assert.doesNotMatch(monthlyRenderer, /incidentsTotal|breachAlerts|checkpointVisits/);
});
