const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const source = fs.readFileSync('scripts/bob-builder-e2e.mjs', 'utf8');

test('Builder human-test driver refuses arbitrary approvals and verifies publish receipts', () => {
  assert.match(source, /HUMAN_APPROVAL_TYPES = new Set\(\['specification_review', 'release_approval'\]\)/);
  assert.match(source, /Refusing to approve unexpected Builder gate/);
  assert.match(source, /requireOk\(out, step\.action\)/);
  assert.match(source, /workspace_head_sha/);
  assert.match(source, /workspace_published_head_sha/);
  assert.match(source, /workspace_pull_request_head_sha/);
  assert.match(source, /Builder SHA mismatch/);
});
