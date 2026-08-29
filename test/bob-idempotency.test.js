const assert = require('node:assert/strict');
const test = require('node:test');
const {
  computeArgsHash,
  buildIdempotencyKey
} = require('../supabase/functions/_shared/idempotency.js');

test('computeArgsHash produces deterministic hashes', () => {
  const args = { query: 'repo_search', org_id: 'org-123', limit: 50 };

  const hash1 = computeArgsHash(args);
  const hash2 = computeArgsHash(args);

  assert.equal(hash1, hash2, 'same args should produce same hash');
  assert.equal(hash1.length, 16);
});

test('computeArgsHash produces different hashes for different args', () => {
  const args1 = { query: 'search_term_1' };
  const args2 = { query: 'search_term_2' };

  const hash1 = computeArgsHash(args1);
  const hash2 = computeArgsHash(args2);

  assert.notEqual(hash1, hash2, 'different args should produce different hashes');
});

test('computeArgsHash handles arg order independence', () => {
  const args1 = { a: 1, b: 2, c: 3 };
  const args2 = { c: 3, b: 2, a: 1 }; // Different order

  const hash1 = computeArgsHash(args1);
  const hash2 = computeArgsHash(args2);

  assert.equal(hash1, hash2, 'arg order should not affect hash');
});

test('buildIdempotencyKey includes all components', () => {
  const key = buildIdempotencyKey('task-abc', 'step-5', 'repo_search', { query: 'auth' });

  assert.ok(key.includes('task-abc'));
  assert.ok(key.includes('step-5'));
  assert.ok(key.includes('repo_search'));
  assert.ok(key.includes('::'));
});

test('computeArgsHash handles empty or null args', () => {
  const hash1 = computeArgsHash(null);
  const hash2 = computeArgsHash(undefined);
  const hash3 = computeArgsHash({});

  assert.equal(hash1, 'empty');
  assert.equal(hash2, 'empty');
  // Empty object should still hash
  assert.ok(hash3);
});
