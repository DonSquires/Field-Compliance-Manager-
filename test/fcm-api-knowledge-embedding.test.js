'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cardEmbeddingText, toVectorLiteral, embedText, backfillCardEmbeddings } = require('../services/fcm-api/src/bob/knowledgeEmbedding');

const config = { ollamaUrl: 'http://ollama:11434', model: 'nomic-embed-text', dimensions: 3, timeoutMs: 1000 };
const vector = [0.1, -0.2, 0.3];

function ollamaFetch(calls, embedding = vector) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ embeddings: [embedding] }) };
  };
}

function fakeSupabase({ pending, rows, updated = (id) => [{ id }], remaining = 0 }) {
  const writes = [];
  return {
    writes,
    rpc: async (name) => name === 'bob_cards_needing_embedding'
      ? { data: pending, error: null }
      : { data: remaining, error: null },
    from: () => {
      const query = { filters: {} };
      const builder = {
        select: () => (query.patch ? builder : builder),
        in: async () => ({ data: rows, error: null }),
        update: (patch) => { query.patch = patch; return builder; },
        eq: (column, value) => { query.filters[column] = value; return builder; },
        then: (resolve) => {
          writes.push({ patch: query.patch, filters: { ...query.filters } });
          return resolve({ data: updated(query.filters.id), error: null });
        },
      };
      return builder;
    },
  };
}

test('card embedding text matches the verified stored-vector shape with no task prefix', () => {
  assert.equal(cardEmbeddingText({ title: ' Pay rules ', content: 'Overtime after 40h.\n' }), 'Pay rules\n\nOvertime after 40h.');
  assert.equal(toVectorLiteral([1, -0.5, 2e-3]), '[1,-0.5,0.002]');
});

test('embedText calls Ollama /api/embed and rejects wrong dimensions or empty text', async () => {
  const calls = [];
  const result = await embedText('where is the roster?', { config, fetchImpl: ollamaFetch(calls) });
  assert.deepEqual(result, { embedding: vector, model: 'nomic-embed-text', dimensions: 3 });
  assert.deepEqual(calls[0], { url: 'http://ollama:11434/api/embed', body: { model: 'nomic-embed-text', input: 'where is the roster?' } });
  await assert.rejects(embedText('  ', { config, fetchImpl: ollamaFetch([]) }), /embed_text_required/);
  await assert.rejects(embedText('x', { config, fetchImpl: ollamaFetch([], [1, 2]) }), /embed_dimension_mismatch/);
});

test('backfill writes pgvector literals optimistically and never leaves embedded_at behind updated_at', async () => {
  const future = '2099-01-01T00:00:00+00:00';
  const supabase = fakeSupabase({
    pending: [{ id: 'a' }, { id: 'b' }],
    rows: [
      { id: 'a', title: 'A', content: 'alpha', updated_at: '2026-08-19T00:00:00+00:00' },
      { id: 'b', title: 'B', content: 'beta', updated_at: future },
    ],
  });
  const calls = [];
  const now = () => new Date('2026-10-21T00:00:00Z');
  const result = await backfillCardEmbeddings({ supabase, config, fetchImpl: ollamaFetch(calls), now });
  assert.equal(result.embedded, 2);
  assert.equal(result.remaining, 0);
  assert.equal(calls[0].body.input, 'A\n\nalpha');
  const [first, second] = supabase.writes;
  assert.equal(first.patch.embedding, '[0.1,-0.2,0.3]');
  assert.equal(first.patch.embedding_model, 'nomic-embed-text');
  assert.equal(first.patch.embedded_at, '2026-10-21T00:00:00.000Z');
  assert.deepEqual(first.filters, { id: 'a', updated_at: '2026-08-19T00:00:00+00:00' });
  assert.equal(second.patch.embedded_at, new Date(future).toISOString());
});

test('backfill leaves a card edited mid-run pending and reports per-card failures', async () => {
  const supabase = fakeSupabase({
    pending: [{ id: 'a' }, { id: 'b' }],
    rows: [
      { id: 'a', title: 'A', content: 'alpha', updated_at: '2026-08-19T00:00:00+00:00' },
      { id: 'b', title: 'B', content: 'beta', updated_at: '2026-08-19T00:00:00+00:00' },
    ],
    updated: () => [],
    remaining: 2,
  });
  let call = 0;
  const flaky = async () => {
    call += 1;
    if (call === 2) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ embeddings: [vector] }) };
  };
  const result = await backfillCardEmbeddings({ supabase, config, fetchImpl: flaky });
  assert.equal(result.embedded, 0);
  assert.equal(result.skipped_changed, 1);
  assert.deepEqual(result.failed, [{ id: 'b', error: 'embed_failed_http_500' }]);
  assert.equal(result.remaining, 2);
});
