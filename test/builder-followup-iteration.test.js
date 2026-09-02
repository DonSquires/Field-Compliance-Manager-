const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901025000_builder_followup_iterations.sql'), 'utf8');

test('Builder follow-up iterations preserve immutable job evidence and reuse only a verified workspace head', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS parent_job_id uuid REFERENCES public\.builder_jobs/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_create_followup_job/);
  assert.match(migration, /_parent\.workspace_branch IS NULL OR _parent\.workspace_head_sha IS NULL/);
  assert.match(migration, /target_sha, workspace_branch, workspace_head_sha/);
  assert.match(migration, /Builder follow-up iteration created from a verified workspace commit/);
});