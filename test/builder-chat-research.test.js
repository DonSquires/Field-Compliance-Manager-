'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { publicUrl, evidenceAnswer, runBuilderResearch } = require('../builder-chat-research');
const { processBuilderChatMessage } = require('../builder-chat-session');

const OWNER = 'owner-fixture';
const THREAD = { id: 'thread-fixture', created_by: OWNER };
const ENV = { OLLAMA_API_TOKEN: 'synthetic-secret-not-real', BOB_VIBE_ALLOW_OLLAMA_CLOUD: 'true' };
const CONTENT = 'Docker Compose uses a YAML file to configure application services.';
const SOURCE = { id: 'web-1', url: 'https://docs.docker.com/compose/', content: CONTENT, verified_publisher: true };
const answer = (source = SOURCE.id, quote = CONTENT) => ({
  summary: 'Compose is configured using YAML.',
  claims: [{ statement: 'Compose uses YAML configuration.', evidence: [{ source_id: source, quote }] }],
});
const message = (payload = {}) => ({
  id: 'message-fixture', created_by: OWNER, content: 'How does Docker Compose configure services?',
  payload: { research_mode: 'public_cloud', research_consent: { allowed: true, policy_version: 'builder_research_v1', actor_user_id: OWNER, raw_images_allowed: true }, research_urls: [SOURCE.url], ...payload },
});

function fixture({ models = ['kimi-k2.7-code'], vision = true, result = () => answer(), bytes, failedModel, searchResults } = {}) {
  const calls = [];
  const rows = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith('https://ollama.com/api/'));
    assert.equal(options.redirect, 'error');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, method: options.method });
    const endpoint = url.split('/').at(-1);
    if (endpoint === 'tags') { assert.equal(options.method, 'GET'); return Response.json({ models: models.map(name => ({ name })) }); }
    if (endpoint === 'show') return Response.json({ capabilities: vision ? ['completion', 'vision'] : ['completion'] });
    if (endpoint === 'web_fetch') return Response.json({ title: 'Compose documentation', content: CONTENT });
    if (endpoint === 'web_search') return Response.json({ results: searchResults || [{ url: SOURCE.url }] });
    if (body.model === failedModel) return new Response('', { status: 503 });
    return Response.json({ message: { content: JSON.stringify(result(body)) } });
  };
  return {
    calls, rows, fetchImpl,
    run: msg => runBuilderResearch({
      thread: THREAD, message: msg || message(), env: ENV, fetchImpl, post: async row => rows.push(row),
      supabase: { storage: { from: () => ({ download: async () => ({ data: new Blob([bytes || 'text']), error: null }) }) } },
    }),
  };
}

test('public research goes directly to verified cloud candidate without private history, source tools or metered providers', async () => {
  const f = fixture();
  const result = await f.run();
  assert.equal(result.model, 'kimi-k2.7-code');
  assert.equal(result.research.history_withheld, true);
  const chat = f.calls.find(call => call.url.endsWith('/chat'));
  assert.equal(chat.body.model, 'kimi-k2.7-code');
  assert.ok(!JSON.stringify(chat).includes('synthetic-secret-not-real'));
  assert.ok(!('tools' in chat.body));
  assert.equal(result.research.claims[0].verification, 'verified_primary_website');
  assert.equal(f.rows[0].payload.external_egress, true);
});

test('missing, string, mismatched actor and old-policy approval fail before any provider request', async () => {
  for (const consent of [null, { allowed: 'true' }, { allowed: true, actor_user_id: 'other', policy_version: 'builder_research_v1' }, { allowed: true, actor_user_id: OWNER, policy_version: 'old' }]) {
    const f = fixture();
    await assert.rejects(f.run(message({ research_consent: consent })), /explicit non-sensitive-content approval/);
    assert.equal(f.calls.length, 0);
  }
});

test('model availability and capability are checked, and failed candidates fall through without changing providers', async () => {
  const f = fixture({ models: ['kimi-k2.7-code', 'deepseek-v4.1-flash:1017', 'unapproved-model'], failedModel: 'kimi-k2.7-code' });
  const result = await f.run();
  assert.equal(result.model, 'deepseek-v4.1-flash:1017');
  assert.equal(result.research.failures.length, 1);
  assert.ok(!f.calls.some(call => call.body?.model === 'unapproved-model'));
});

test('raw images require checksum, scoped storage and an advertised vision capability', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const file = { id: 'image', file_name: 'synthetic.png', file_type: 'image/png', file_size_bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), storage_path: `desktop/${OWNER}/builder-chat/${THREAD.id}/image-synthetic.png` };
  const description = 'A synthetic blue square is visible.';
  const f = fixture({ bytes, result: () => ({ ...answer('attachment-1', 'A visible blue square'), image_observations: [{ source_id: 'attachment-1', description }] }) });
  const result = await f.run(message({ research_files: [file], research_urls: [] }));
  const chat = f.calls.find(call => call.url.endsWith('/chat'));
  assert.deepEqual(chat.body.messages[1].images, [bytes.toString('base64')]);
  assert.equal(result.research.raw_images_sent, 1);
  assert.equal(result.research.claims[0].verification, 'attachment_observation_not_external_validation');
  const noVision = fixture({ bytes, vision: false });
  await assert.rejects(noVision.run(message({ research_files: [file], research_urls: [] })), /required_capability_not_advertised/);
  assert.ok(!noVision.calls.some(call => call.url.endsWith('/chat')));
  for (const invalid of [{ ...file, sha256: 'a'.repeat(64) }, { ...file, storage_path: 'desktop/other/private.png' }]) {
    const bad = fixture({ bytes });
    await assert.rejects(bad.run(message({ research_files: [invalid] })), /checksum|scope/);
    assert.ok(!bad.calls.some(call => call.url.endsWith('/chat')));
  }
});

test('documents send only bounded extracted text and never raw bytes; unreadable documents fail explicitly', async () => {
  const bytes = Buffer.from('synthetic document bytes');
  const file = { id: 'doc', file_name: 'synthetic.pdf', file_type: 'application/pdf', file_size_bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), extracted_text: CONTENT,
    storage_path: `desktop/${OWNER}/builder-chat/${THREAD.id}/doc-synthetic.pdf` };
  const f = fixture({ bytes, result: () => answer('attachment-1') });
  const result = await f.run(message({ research_files: [file], research_urls: [] }));
  const chat = f.calls.find(call => call.url.endsWith('/chat'));
  assert.ok(!JSON.stringify(chat).includes(bytes.toString('base64')));
  assert.ok(JSON.stringify(chat).includes(CONTENT));
  assert.equal(result.research.raw_documents_sent, false);
  await assert.rejects(fixture({ bytes }).run(message({ research_files: [{ ...file, extracted_text: '' }] })), /no readable text/);
});

test('non-primary claims require three distinct publisher domains; quote inventions are rejected', () => {
  const sources = ['https://one.com/a', 'https://two.com/a', 'https://three.org/a'].map((url, index) => ({ id: String(index), url, content: CONTENT }));
  const claim = { statement: 'A corroborated statement.', evidence: sources.map(source => ({ source_id: source.id, quote: CONTENT })) };
  assert.equal(evidenceAnswer({ summary: 'Summary', claims: [claim] }, sources).claims[0].verification, 'three_distinct_publisher_domains');
  assert.equal(evidenceAnswer({ summary: 'Summary', claims: [{ ...claim, evidence: claim.evidence.slice(0, 2) }] }, sources).claims[0].verification, 'unverified_insufficient_corroboration');
  assert.throws(() => evidenceAnswer(answer('0', 'A completely invented quote.'), sources), /quote was not found/);
  const samePublisher = sources.map(source => ({ ...source, url: `https://${source.id}.one.com/a` }));
  assert.equal(evidenceAnswer({ summary: 'Summary', claims: [claim] }, samePublisher).claims[0].verification, 'unverified_insufficient_corroboration');
});

test('unsafe source URLs are rejected; unsafe search results are excluded with a receipt', async () => {
  for (const url of ['http://docs.docker.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://user:password@site.com/', 'https://site.com/?token=private', 'https://test.local/', 'https://site.com:8080/']) {
    assert.throws(() => publicUrl(url), /public HTTPS/);
  }
  const f = fixture({ searchResults: [{ url: 'https://127.0.0.1/' }, { url: SOURCE.url }] });
  const result = await f.run(message({ research_urls: [], web_search: true }));
  assert.equal(result.research.excluded_search_results, 1);
  assert.equal(f.calls.filter(call => call.url.endsWith('/web_fetch')).length, 1);
});

test('research dispatch never loads a checkout, repository tools or earlier chat', async () => {
  const f = fixture();
  const posted = [];
  const store = {
    thread: async () => THREAD, updateThread: async () => {}, complete: async () => {},
    post: async (_id, row) => posted.push(row),
    history: async () => { throw new Error('Private history must not be loaded'); },
  };
  const outcome = await processBuilderChatMessage({ store, message: message(), deps: {
    resolveHead: () => { throw new Error('Checkout must not be loaded'); },
    research: { env: ENV, fetchImpl: f.fetchImpl },
  } });
  assert.equal(outcome.error, undefined);
  assert.ok(!posted.some(row => row.kind === 'proposal'));
  assert.equal(posted.at(-1).payload.model, 'kimi-k2.7-code');
});
