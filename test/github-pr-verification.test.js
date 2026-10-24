'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('GitHub PR and main verification is credential-free and does not duplicate the VPS production writer', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/verify-pr.yml'), 'utf8');
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.match(workflow, /push:\n\s+branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(workflow, /cancel-in-progress: true/);
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 3);
  assert.doesNotMatch(workflow, /secrets\.|pull_request_target|workflow_run:|continue-on-error|supabase (?:db push|migration|functions deploy)|\bssh\b/m);
  assert.match(workflow, /node --test --test-concurrency=4 test\/\*\.test\.js/);
  assert.match(workflow, /node scripts\/check-migration-versions\.js/);
  assert.match(workflow, /npm run lint/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm run test -- --maxWorkers=2/);
  assert.match(workflow, /E2E_OFFLINE: '1'/);
  assert.match(workflow, /HUMAN_TEST_LIVE: 'false'/);
  assert.match(workflow, /e2e\/human-test-runner\.spec\.ts e2e\/staff-profile-navigation\.spec\.ts/);
  assert.match(workflow, /npm run test:e2e:ci-smoke/);
  assert.match(workflow, /if: always\(\)/);
});
