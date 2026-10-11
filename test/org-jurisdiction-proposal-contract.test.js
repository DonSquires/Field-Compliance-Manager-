const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const source = readFileSync(
  path.resolve(__dirname, '../supabase/functions/bob-propose-org-jurisdiction/index.ts'),
  'utf8',
);

test('organization jurisdiction producer validates scope and canonical authority names', () => {
  assert.match(source, /user_can_operate_organization/);
  assert.match(source, /validate_ta_names/);
  assert.match(source, /action_type:\s*'set_org_jurisdiction'/);
  assert.match(source, /status:\s*'pending'/);
  assert.match(source, /triggered_by:\s*user\.id/);
  assert.doesNotMatch(source, /\.from\('organizations'\)\s*\.update/);
});

test('organization jurisdiction producer is idempotent for an active proposal', () => {
  assert.match(source, /set_org_jurisdiction:\$\{organizationId\}/);
  assert.match(source, /insertError\?\.code === '23505'/);
  assert.match(source, /\.in\('status', \['pending', 'approved', 'applying'\]\)/);
});
