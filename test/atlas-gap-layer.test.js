const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Atlas exposes a first-class gap report contract', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');
  const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260908000000_atlas_gap_layer.sql'), 'utf8');
  const atlas = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-query-atlas/index.ts'), 'utf8');

  assert.match(schema, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"public"\."bob_atlas_gap_report"/);
  assert.match(migration, /create or replace function public\.bob_atlas_gap_report/i);
  assert.match(migration, /grant execute on function public\.bob_atlas_gap_report\(integer, integer\) to service_role/i);
  assert.match(schema, /RETURNS\s+TABLE\s*\(/);
  assert.match(schema, /gap_kind/i);
  assert.match(schema, /p_include_columns/);
  assert.match(schema, /c\.entity_type <> 'column'/);
  assert.match(schema, /p_include_unknown_exercise/);
  assert.match(atlas, /if \(action === 'gap_report'\)/);
  assert.match(atlas, /bob_atlas_gap_report|admin\.rpc\('bob_atlas_gap_report'/);
  assert.match(atlas, /p_include_columns: body\.include_columns === true/);
  assert.match(atlas, /p_include_unknown_exercise: body\.include_unknown_exercise === true/);
});
