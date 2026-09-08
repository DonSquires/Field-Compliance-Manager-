const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Atlas exposes an expectation evaluator through its protected query API', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');
  const atlas = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-query-atlas/index.ts'), 'utf8');

  assert.match(schema, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"public"\."bob_atlas_expectation_report"/);
  assert.match(schema, /must_reach/);
  assert.match(schema, /must_not_reach/);
  assert.match(schema, /must_pass_through/);
  assert.match(schema, /expectation_status/);
  assert.match(atlas, /action === 'expectation_report'/);
  assert.match(atlas, /bob_atlas_expectation_report/);
});
