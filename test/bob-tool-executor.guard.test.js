const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-tool-executor/index.ts'), 'utf8');

test('approved tool executor is authenticated, organization-bound, expiry-bound, and allowlisted', () => {
  assert.match(source, /caller\.auth\.getUser\(\)/);
  assert.match(source, /approval\.status !== 'approved'/);
  assert.match(source, /new Date\(approval\.expires_at\)\.getTime\(\) <= Date\.now\(\)/);
  assert.match(source, /organization_id/);
  assert.match(source, /const EXECUTABLE_TOOLS/);
  assert.match(source, /gitea_sync/);
  assert.match(source, /x-bob-sync-secret/);
  assert.doesNotMatch(source, /body\.endpoint_url|body\.url/);
});