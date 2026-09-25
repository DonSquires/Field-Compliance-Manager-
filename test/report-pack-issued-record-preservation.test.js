const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260924050000_preserve_sent_monthly_report_packs.sql'),
  'utf8',
);

test('report-pack regeneration leaves sent records unchanged', () => {
  assert.match(
    migration,
    /on conflict \(service_agreement_id, template_code, period_start\)[\s\S]*where monthly_report_packs\.status <> 'sent'/i,
  );
  assert.doesNotMatch(
    migration,
    /status\s*=\s*case\s+when\s+monthly_report_packs\.status\s*=\s*'sent'/i,
  );
});

test('report-pack generation count reflects rows actually written', () => {
  assert.match(migration, /get diagnostics v_written = row_count/i);
  assert.match(migration, /v_count := v_count \+ v_written/i);
  assert.doesNotMatch(migration, /v_count := v_count \+ 1/i);
});