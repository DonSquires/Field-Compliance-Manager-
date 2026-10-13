const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20261014090000_cycle_safe_atlas_fk_reach.sql'),
  'utf8',
);

test('Atlas FK reach is cycle-safe, deduplicated, and excludes weak references', () => {
  assert.match(migration, /edge\.edge_kind = 'fk_references'/);
  assert.doesNotMatch(migration, /edge_kind\s+in\s*\([^)]*references/i);
  assert.match(migration, /NOT \(neighbour\.entity_type \|\| ':' \|\| neighbour\.entity_name\) = ANY\(walk\.path\)/);
  assert.match(migration, /SELECT DISTINCT ON \(walk\.entity_type, walk\.entity_name\)/);
  assert.match(migration, /ORDER BY walk\.entity_type, walk\.entity_name, walk\.depth/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.bob_atlas_fk_reach\(text, text, integer\)/);
  assert.match(migration, /TO postgres, service_role/);
});
