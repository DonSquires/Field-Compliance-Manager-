const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261016104659_retire_get_my_pending_proposals.sql'),
  'utf8',
);
const approvalsPage = fs.readFileSync(
  path.join(root, 'apps/web/src/pages/ApprovalsActivityPage.tsx'),
  'utf8',
);

test('the full-lifecycle approvals activity API remains the single approval queue', () => {
  assert.match(approvalsPage, /rpc\('get_approvals_activity'/);
  assert.doesNotMatch(approvalsPage, /get_my_pending_proposals/);
});

test('the superseded bell-era proposal API is retired', () => {
  assert.match(
    migration,
    /DROP FUNCTION IF EXISTS public\.get_my_pending_proposals\(integer\)/,
  );
  assert.equal(
    fs.existsSync(
      path.join(root, 'supabase/schemas/public/functions/get_my_pending_proposals.sql'),
    ),
    false,
  );
});
