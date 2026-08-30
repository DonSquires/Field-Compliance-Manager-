const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830151000_builder_release_approval_evidence.sql'),
  'utf8'
);

test('release approval requires the complete verified artifact set', () => {
  for (const type of [
    'code_implementation', 'changed_file_manifest', 'build_logs', 'security_review',
    'release_notes', 'rollback_plan', 'deployment_manifest'
  ]) assert.match(migration, new RegExp(`'${type}'`));
  assert.match(migration, /artifact\.status = 'final'/);
  assert.match(migration, /CREATE TRIGGER builder_release_approval_evidence_gate/);
  assert.match(migration, /BEFORE INSERT OR UPDATE/);
});