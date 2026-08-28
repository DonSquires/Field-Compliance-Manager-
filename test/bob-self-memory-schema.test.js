const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Real bug found live: bob-self-memory-write inserted into columns
// (content, memory_type, proposed_by: 'bob') that do not match the live
// bob_self_memory schema (memory_text NOT NULL, memory_kind, proposed_by uuid
// CHECK-constrained to Bob's fixed id, no context column at all). Every write
// failed with "Failed to write memory". These tests lock in the corrected
// column mapping without changing the external tool contract.
test('bob-self-memory-write inserts into the actual live schema columns', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-self-memory-write/index.ts'), 'utf8');

  assert.match(source, /memory_text:\s*memoryText/);
  assert.match(source, /memory_kind:\s*memoryType/);
  assert.match(source, /proposed_by:\s*'00000000-0000-0000-0000-00000000b0b0'/);
  assert.doesNotMatch(source, /content:\s*content,/);
  assert.doesNotMatch(source, /proposed_by:\s*'bob'/);
});

test('bob-self-memory-read queries and filters the actual live schema columns while preserving the external response contract', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/bob-self-memory-read/index.ts'), 'utf8');

  assert.match(source, /content:memory_text/);
  assert.match(source, /memory_type:memory_kind/);
  assert.match(source, /\.eq\('memory_kind', memoryType\)/);
  assert.match(source, /\.ilike\('memory_text', /);
  assert.doesNotMatch(source, /\.eq\('memory_type', memoryType\)/);
  assert.doesNotMatch(source, /\.ilike\('content', /);
});
