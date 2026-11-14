const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901025000_builder_followup_iterations.sql'), 'utf8');
const allLanesMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261113100000_builder_jobs_require_both_implementation_lanes.sql'), 'utf8');

test('Builder follow-up iterations preserve immutable job evidence and reuse only a verified workspace head', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS parent_job_id uuid REFERENCES public\.builder_jobs/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_create_followup_job/);
  assert.match(migration, /_parent\.workspace_branch IS NULL OR _parent\.workspace_head_sha IS NULL/);
  assert.match(migration, /target_sha, workspace_branch, workspace_head_sha/);
  assert.match(migration, /Builder follow-up iteration created from a verified workspace commit/);
});

test('new Builder follow-ups always start both implementation specialists regardless of legacy scope arguments', () => {
  const replacement = allLanesMigration.slice(allLanesMigration.indexOf('CREATE OR REPLACE FUNCTION public.builder_create_followup_job'));
  assert.match(replacement, /_frontend_required boolean DEFAULT true/);
  assert.match(replacement, /_backend_required boolean DEFAULT false/);
  assert.match(replacement, /approval_pending'\], true, true/);
  assert.match(replacement, /'ui_design', 2, 'ux_designer', 'pending'/);
  assert.match(replacement, /'frontend_implementation', 3, 'frontend_engineer', 'pending'/);
  assert.match(replacement, /'backend_implementation', 4, 'backend_engineer', 'pending'/);
  assert.match(replacement, /'frontend_required', true, 'backend_required', true/);
  assert.match(replacement, /GRANT EXECUTE ON FUNCTION public\.builder_create_followup_job\([^;]+ TO service_role/);
});