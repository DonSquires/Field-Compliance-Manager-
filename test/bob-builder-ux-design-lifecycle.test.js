const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830070000_builder_ux_design_lifecycle.sql'),
  'utf8'
);

test('UX design lifecycle requires an approved specification and final design artifact', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_start_ux_design/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_complete_ux_design/);
  assert.match(migration, /IF auth\.role\(\) <> 'service_role'/);
  assert.match(migration, /_job\.status <> 'design_pending'/);
  assert.match(migration, /approval_type = 'specification_review'/);
  assert.match(migration, /artifact_type <> 'ui_design_plan'/);
  assert.match(migration, /status\s*=\s*'implementation_pending'/);
  assert.match(migration, /'step_started'/);
  assert.match(migration, /'step_completed'/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});