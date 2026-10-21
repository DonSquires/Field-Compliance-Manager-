const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20261014100000_retire_legacy_builder_interfaces.sql'),
  'utf8',
);
const securityHandoff = fs.readFileSync(
  path.resolve(__dirname, '../builder-security-handoff.js'),
  'utf8',
);
const approvalsPage = fs.readFileSync(
  path.resolve(__dirname, '../apps/web/src/pages/ApprovalsActivityPage.tsx'),
  'utf8',
);
const workerExecutor = fs.readFileSync(
  path.resolve(__dirname, '../worker-executor.js'),
  'utf8',
);

test('legacy Builder interfaces retire only after their active replacements are wired', () => {
  assert.match(securityHandoff, /builder_claim_aggregate_security_review/);
  assert.doesNotMatch(securityHandoff, /builder_claim_security_review['"]/);
  assert.match(approvalsPage, /rpc\('get_approvals_activity'/);
  assert.doesNotMatch(approvalsPage, /get_builder_approvals_activity/);
  assert.match(workerExecutor, /--network=\$\{workerNetwork\(profile, env\)\}/);
  assert.match(workerExecutor, /const environment = options\.environment \|\| \{\}/);
  assert.doesNotMatch(workerExecutor, /builder_protected_variables/);

  assert.match(migration, /DROP FUNCTION IF EXISTS public\.builder_claim_security_review/);
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.get_builder_approvals_activity/);
  assert.match(migration, /DROP TABLE IF EXISTS public\.builder_protected_variables/);
  assert.doesNotMatch(migration, /DROP FUNCTION IF EXISTS public\.builder_claim_aggregate_security_review/);
  assert.doesNotMatch(migration, /DROP FUNCTION IF EXISTS public\.get_approvals_activity/);
});
