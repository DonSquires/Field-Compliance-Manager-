const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830171000_builder_optional_code_review_recovery.sql'),
  'utf8'
);

test('independent AI review infrastructure retries once then becomes terminal', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.builder_abort_independent_code_review/);
  assert.match(migration, /_terminal := _step\.attempt_count >= 2/);
  assert.match(migration, /retryable = NOT _terminal/);
  assert.match(migration, /Independent AI review retry limit reached/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO service_role/);
});