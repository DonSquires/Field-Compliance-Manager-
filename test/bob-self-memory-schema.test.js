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

// Found live (2026-09-27): bob_self_memory_memory_kind_check listed only the reflective kinds, so
// the Builder engineer's per-run `builder_note` was rejected on every insert for days, the error was
// swallowed, and Bob's own memory stayed at 0 rows. Every kind a writer in this repo uses must be in
// the live CHECK constraint (schema.sql is regenerated from the live catalog).
test('every memory_kind written by code is allowed by the live bob_self_memory CHECK constraint', () => {
  const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');
  const check = schema.match(/"bob_self_memory_memory_kind_check" CHECK \(memory_kind = ANY \(ARRAY\[([^\]]+)\]\)\)/);
  assert.ok(check, 'bob_self_memory_memory_kind_check must exist in schema.sql');
  const allowed = new Set([...check[1].matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]));

  const writers = {
    'builder-agentic-engineer.js': /memory_kind:\s*'([a-z_]+)'/g,
    'scripts/bob-release-lane.sh': /memory_kind:\s*"([a-z_]+)"/g,
    'supabase/functions/bob-self-memory-write/index.ts': /memory_type \?\? '([a-z_]+)'/g
  };
  for (const [file, pattern] of Object.entries(writers)) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
    const kinds = [...source.matchAll(pattern)].map((m) => m[1]);
    assert.ok(kinds.length > 0, `${file} should declare at least one memory_kind`);
    for (const kind of kinds) assert.ok(allowed.has(kind), `${file} writes memory_kind '${kind}' which the live CHECK constraint rejects`);
  }
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
