const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const matrix = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913142000_module_event_place_matrix.sql'), 'utf8');

test('module event place matrix is read-only and classifies place anchor dominance', () => {
  assert.match(matrix, /public\.module_event_place_matrix/);
  assert.match(matrix, /dominant_anchor_kind/);
  assert.match(matrix, /checkpoint_event_count/);
  assert.match(matrix, /site_event_count/);
  assert.match(matrix, /zone_event_count/);
  assert.match(matrix, /unresolved_event_count/);
  assert.match(matrix, /WITH \(security_invoker = true\)/);
});
