const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901021000_builder_job_policy_intent.sql'), 'utf8');
const allLanesMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261113100000_builder_jobs_require_both_implementation_lanes.sql'), 'utf8');
const controlRoom = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-builder-control-room/index.ts'), 'utf8');

test('Builder job policy intent is persisted, audited, and production-safe', () => {
  for (const column of ['requested_action', 'target_environment']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_create_job_v2/);
  assert.match(migration, /Production Builder jobs must prepare a release/);
  assert.match(migration, /Production Builder jobs require human code review/);
  assert.match(migration, /builder_job_policy_bound/);
  assert.match(migration, /'target_sha', _job\.target_sha/);
});

test('every newly created Builder job requires both implementation specialists regardless of legacy scope arguments', () => {
  assert.match(allLanesMigration, /_frontend_required boolean DEFAULT true/);
  assert.match(allLanesMigration, /_backend_required boolean DEFAULT false/);
  assert.doesNotMatch(allLanesMigration, /At least one implementation scope is required/);
  assert.match(allLanesMigration, /ARRAY\['specification_ready','approval_pending'\], true, true/);
  assert.match(allLanesMigration, /'ui_design', 2, 'ux_designer', 'pending'/);
  assert.match(allLanesMigration, /'frontend_implementation', 3, 'frontend_engineer', 'pending'/);
  assert.match(allLanesMigration, /'backend_implementation', 4, 'backend_engineer', 'pending'/);
  assert.match(allLanesMigration, /'test_suite', 5, 'qa_security_reviewer', 'pending', ARRAY\['frontend_implementation','backend_implementation'\]/);
  assert.match(allLanesMigration, /'frontend_required', true/);
  assert.match(allLanesMigration, /'backend_required', true/);
  assert.match(allLanesMigration, /GRANT EXECUTE ON FUNCTION public\.builder_create_job\([^;]+ TO service_role/);
  assert.match(controlRoom, /_frontend_required: true,/);
  assert.match(controlRoom, /_backend_required: true,/);
  const followupAction = controlRoom.slice(controlRoom.indexOf("if (action === 'create_followup')"), controlRoom.indexOf("if (action === 'drive')"));
  assert.match(followupAction, /_frontend_required: true,/);
  assert.match(followupAction, /_backend_required: true,/);
  assert.match(controlRoom, /\.eq\('frontend_required', true\)\s*\.eq\('backend_required', true\)/);
  assert.match(allLanesMigration, /CREATE OR REPLACE FUNCTION public\.builder_create_autopilot_child\(/);
  const childCreator = allLanesMigration.slice(allLanesMigration.indexOf('CREATE OR REPLACE FUNCTION public.builder_create_autopilot_child('));
  const dedupeLookup = childCreator.slice(childCreator.indexOf('SELECT * INTO _child FROM public.builder_jobs'), childCreator.indexOf('IF FOUND THEN RETURN _child; END IF;'));
  assert.match(dedupeLookup, /AND description = _child_description/);
  assert.doesNotMatch(dedupeLookup, /frontend_required|backend_required/);
  assert.match(childCreator, /_child_description, true, true,/);
  assert.match(childCreator, /GRANT EXECUTE ON FUNCTION public\.builder_create_autopilot_child\([^;]+ TO postgres,service_role/);
});