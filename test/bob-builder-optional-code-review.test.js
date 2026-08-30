const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830170000_builder_optional_code_review.sql'),
  'utf8'
);

test('code review policy supports none, human, and independent AI', () => {
  assert.match(migration, /code_review_mode text NOT NULL DEFAULT 'none'/);
  assert.match(migration, /'none'.*'human'.*'independent_ai'/s);
  assert.match(migration, /code_review_status text NOT NULL DEFAULT 'not_required'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_set_code_review_policy/);
  assert.match(migration, /public\.can_approve_action\(_uid, _job\.organization_id\)/);
  assert.match(migration, /_job\.status <> 'intake'/);
});

test('optional review lifecycle supports skip, human approval, and independent AI', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_start_code_review/);
  assert.match(migration, /code_review_mode = 'none'/);
  assert.match(migration, /approval_type.*implementation_review/s);
  assert.match(migration, /code_review_mode = 'independent_ai'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_complete_independent_code_review/);
  assert.match(migration, /reviewer_run\.model_name = author_run\.model_name/);
  assert.match(migration, /artifact_type = 'code_review'/);
  assert.match(migration, /verdict NOT IN \('passed', 'blocked'\)/);
});

test('release preparation enforces configured review policy', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_enforce_release_review_policy/);
  assert.match(migration, /code_review_mode IN \('human', 'independent_ai'\)/);
  assert.match(migration, /code_review_status <> 'passed'/);
  assert.match(migration, /CREATE TRIGGER builder_release_review_policy_gate/);
});