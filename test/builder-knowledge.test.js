'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKnowledgeTool } = require('../builder-knowledge');
const { createBuilderChatTools, builderChatNativeTools } = require('../builder-chat-session');

const CARD = { id: 'card-one', key: 'discovery', title: 'Grounded discovery', content: 'Read actual owning source before planning a change.', source: 'migration:fixture', updated_at: '2026-10-25T00:00:00Z' };
function database(results) {
  const calls = [];
  const builder = () => {
    const methods = ['select', 'is', 'eq', 'in', 'limit', 'or', 'order', 'abortSignal'];
    const query = Object.fromEntries(methods.map(method => [method, (...args) => { calls.push([method, ...args]); return query; }]));
    query.then = (resolve, reject) => Promise.resolve(results.shift()).then(resolve, reject);
    return query;
  };
  return {
    calls,
    from(table) { calls.push(['from', table]); return builder(); },
    rpc(name, args) { calls.push(['rpc', name, args]); return builder(); },
  };
}

test('vector retrieval uses platform scope and rechecks active provenance before returning cards', async () => {
  const db = database([{ data: [{ id: CARD.id, similarity: 0.88 }] }, { data: [CARD] }]);
  const tool = createKnowledgeTool({ supabase: db, embed: async () => ({ embedding: Array(768).fill(0.1) }), now: () => 'observed' });
  const result = await tool({ query: 'grounded discovery', limit: 2 });
  assert.equal(result.retrieval.path, 'vector');
  assert.equal(result.retrieval.degradation, null);
  assert.equal(result.retrieval.scope, 'active_platform_canonical_only');
  assert.equal(result.cards[0].source, CARD.source);
  assert.equal(result.cards[0].updated_at, CARD.updated_at);
  assert.match(result.cards[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.cards[0].similarity, 0.88);
  const rpc = db.calls.find(call => call[0] === 'rpc');
  assert.equal(rpc[2].scope_org_id, null);
  assert.equal(rpc[2].query_embedding, `[${Array(768).fill(0.1).join(',')}]`);
  assert.ok(db.calls.some(call => call[0] === 'is' && call[1] === 'organization_id' && call[2] === null));
  assert.ok(db.calls.some(call => call[0] === 'eq' && call[1] === 'is_active' && call[2] === true));
  assert.ok(db.calls.filter(call => call[0] === 'abortSignal').every(call => call[1] instanceof AbortSignal));
});

test('keyword fallback is explicit, bounded, scoped, ranked and does not accept raw filter injection', async () => {
  const db = database([{ data: [CARD, { ...CARD, id: 'less', title: 'Unrelated', key: 'other', content: 'discovery' }] }]);
  const result = await createKnowledgeTool({ supabase: db, embed: async () => { throw new Error('secret endpoint'); } })({ query: 'discovery),(organization_id.eq.other)', limit: 2 });
  assert.equal(result.retrieval.path, 'keyword');
  assert.equal(result.retrieval.degradation, 'private_embedding_or_vector_read_failed');
  assert.equal(result.cards[0].id, CARD.id);
  const rpc = db.calls.find(call => call[0] === 'rpc');
  assert.equal(rpc?.[1], 'bob_search_platform_knowledge');
  assert.ok(rpc[2].p_terms.every(term => /^[a-z0-9_]{3,}$/.test(term)));
  assert.equal(rpc[2].p_limit, 2);
  assert.equal(result.retrieval.candidate_cap, 2);
  assert.equal(db.calls.some(call => call[0] === 'or'), false);
  assert.doesNotMatch(JSON.stringify(result), /secret endpoint/);
});

test('keyword retrieval ranks in the database before limiting, not after an alphabetical subset', async () => {
  const db = database([{ data: [{ ...CARD, key: 'agent_skill_mattpocock_code_review' }] }]);
  const result = await createKnowledgeTool({ supabase: db })({ query: 'code review', limit: 1 });
  assert.equal(result.cards[0].key, 'agent_skill_mattpocock_code_review');
  assert.deepEqual(db.calls.find(call => call[0] === 'rpc'), ['rpc', 'bob_search_platform_knowledge', { p_terms: ['code', 'review'], p_limit: 1 }]);
});

test('truncation preserves full-content hashes and limits total returned bodies', async () => {
  const cards = Array.from({ length: 6 }, (_, i) => ({ ...CARD, id: String(i), content: 'discovery '.repeat(1000) }));
  const result = await createKnowledgeTool({ supabase: database([{ data: cards }]) })({ query: 'discovery', limit: 6 });
  assert.ok(result.cards.reduce((sum, card) => sum + card.content.length, 0) <= 8000);
  assert.ok(result.cards.every(card => card.truncated));
  assert.equal(result.cards[0].sha256, result.cards[5].sha256);
});

test('invalid scope/arguments cannot read records and database failure is not an empty-success fallback', async () => {
  const tool = createKnowledgeTool({ supabase: { from: () => assert.fail('must not read invalid requests') } });
  for (const args of [{ query: 'x' }, { query: 'valid', limit: 7 }, { query: 'valid', limit: '3' }, { query: 'valid', organization_id: 'tenant' }]) {
    assert.equal((await tool(args)).code, 'INVALID_INPUT');
  }
  assert.equal((await createKnowledgeTool({})({ query: 'discovery' })).code, 'KNOWLEDGE_UNAVAILABLE');
  const failed = await createKnowledgeTool({ supabase: database([{ error: { message: 'sensitive' } }]) })({ query: 'discovery' });
  assert.equal(failed.code, 'KNOWLEDGE_READ_FAILED');
  assert.equal(failed.cards, undefined);
});

test('Builder chat exposes injected retrieval with the same schema in native and JSON tools', async () => {
  const retrieveKnowledge = async () => ({ cards: [CARD] });
  const tools = createBuilderChatTools({ retrieveKnowledge });
  assert.equal(tools.retrieve_knowledge, retrieveKnowledge);
  const definition = builderChatNativeTools(tools).find(entry => entry.function.name === 'retrieve_knowledge').function;
  assert.deepEqual(definition.parameters.required, ['query']);
  assert.equal(definition.parameters.additionalProperties, false);
  assert.equal(createBuilderChatTools({}).retrieve_knowledge, undefined);
});

test('shared Builder and Vibe author tools retrieve platform skills with provenance', async () => {
  const { createTools, DEFAULT_LIMITS } = require('../builder-agentic-engineer');
  const { vibeNativeTools } = require('../builder-vibe-session');
  const db = database([{ data: [{ ...CARD, key: 'skill_humanizer', title: 'Humanizer writing guidance' }] }]);
  const tools = createTools({
    workspacePath: __dirname, repoRoot: __dirname, lane: 'backend',
    supabase: db, limits: DEFAULT_LIMITS, log: () => {},
  });
  assert.equal(typeof tools.retrieve_knowledge, 'function');
  const result = await tools.retrieve_knowledge({ query: 'humanizer' });
  assert.equal(result.cards[0].key, 'skill_humanizer');
  assert.equal(result.retrieval.scope, 'active_platform_canonical_only');
  const definition = vibeNativeTools(tools).find(entry => entry.function.name === 'retrieve_knowledge');
  assert.deepEqual(definition.function.parameters.required, ['query']);
  assert.equal(definition.function.parameters.additionalProperties, false);
});
