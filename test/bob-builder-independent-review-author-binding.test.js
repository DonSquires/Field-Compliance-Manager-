const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260830184000_builder_aggregate_review_author_binding.sql'),
  'utf8'
);

test('independent review binds identity to every exact reviewed patch author', () => {
  assert.match(migration, /cardinality\(_reviewed_patch_ids\) NOT BETWEEN 1 AND 2/);
  assert.match(migration, /artifact\.artifact_type = 'code_implementation'/);
  assert.match(migration, /reviewed_patch_id = ANY\(author_run\.output_artifact_ids\)/);
  assert.match(migration, /author_step\.builder_mode IN \('frontend_engineer', 'backend_engineer'\)/);
  assert.match(migration, /reviewer_run\.provider = author_run\.provider AND reviewer_run\.model_name = author_run\.model_name/);
  assert.match(migration, /different provider or model identity from every patch author/);
  assert.match(migration, /'reviewed_patch_ids', _reviewed_patch_ids/);
});