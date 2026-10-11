const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261011205909_exclude_legacy_atlas_gaps.sql'),
  'utf8',
);

test('Atlas gap report includes only live capabilities', () => {
  assert.match(migration, /where c\.retirement_status = 'live'/);
  assert.doesNotMatch(migration, /retirement_status <> 'retired'/);
  assert.match(migration, /c\.present = true/);
});
