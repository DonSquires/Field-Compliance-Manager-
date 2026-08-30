const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830050000_builder_product_analysis_lifecycle.sql'),
  'utf8'
);
const auditFix = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830051000_builder_product_analysis_start_audit_fix.sql'),
  'utf8'
);

test('Product Analyst lifecycle is service-only, evidence-backed, and approval-gated', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_start_product_analysis/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_complete_product_analysis/);
  assert.match(migration, /IF auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /builder_mode <> 'product_analyst'/);
  assert.match(migration, /artifact_type <> 'product_specification'/);
  assert.match(migration, /status = 'specification_ready'/);
  assert.match(migration, /public\.builder_request_approval/);
  assert.match(migration, /'step_started'/);
  assert.match(migration, /'step_completed'/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});

test('Product Analyst start audit preserves the pre-transition step status', () => {
  assert.match(auditFix, /_previous_step_status := _step\.status/);
  assert.match(auditFix, /'step_status', _previous_step_status/);
});