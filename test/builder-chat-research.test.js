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

function fixture({ models = ['kimi-k2.7-code'], vision = true, result = () => answer(), bytes, failedModel, searchResults, doneReason = 'stop' } = {}) {
  const calls = [];
  const rows = [];
  const fetchImpl = async (url, options) => {
    assert.ok(url.startsWith('https://ollama.com/api/'));
    assert.equal(options.redirect, 'error');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body, method: options.method });
    const endpoint = url.split('/').at(-1);
    if (endpoint === 'tags') { assert.equal(options.method, 'GET'); return Response.json({ models: models.map(name => ({ name })) }); }
    if (endpoint === 'show') return Response.json({ capabilities: vision ? ['completion', 'tools', 'vision'] : ['completion', 'tools'] });
    if (endpoint === 'web_fetch') return Response.json({ title: 'Compose documentation', content: CONTENT });
    if (endpoint === 'web_search') return Response.json({ results: searchResults || [{ url: SOURCE.url }] });
    if (body.model === failedModel) return new Response('', { status: 503 });
    const response = result(body);
    return Response.json({ message: { content: typeof response === 'string' ? response : JSON.stringify(response) }, done_reason: doneReason });
  };
  return {
    calls, rows, fetchImpl,
    run: msg => runBuilderResearch({
      thread: THREAD, message: msg || message(), env: ENV, fetchImpl, post: async row => rows.push(row),
      supabase: { storage: { from: () => ({ download: async () => ({ data: new Blob([bytes || 'text']), error: null }) }) } },
    }),
  };
}

function pmMessage(purpose = 'pm', summary = '') {
  return message({
    pm_purpose: purpose, evidence_summary: summary, research_urls: [], web_search: false,
    context: { job_title: 'PRIVATE-SELECTED-JOB' }, history: ['PRIVATE-HISTORY'],
    research_consent: {
      allowed: true, policy_version: 'builder_research_v1', actor_user_id: OWNER,
      pm_purpose: purpose, evidence_summary_sha256: crypto.createHash('sha256').update(summary).digest('hex'),
      recorded_at: '2026-10-25T00:00:00.000Z',
    },
  });
}

test('PM purposes invoke exactly their assigned cloud model once and withhold unrelated private context', async () => {
  for (const [purpose, model] of [['pm', 'kimi-k2.7-code'], ['qa', 'deepseek-v4-pro:0813'], ['technical_review', 'kimi-k2.7-code']]) {
    const f = fixture({ models: ['kimi-k3', 'deepseek-v4-pro:0813', 'kimi-k2.7-code'], result: () => 'Start by checking the reported behavior against expected behavior.' });
    const result = await f.run(pmMessage(purpose));
    assert.equal(result.model, model);
    assert.equal(result.research.purpose, purpose);
    assert.equal(result.research.fallback_allowed, false);
    assert.equal(result.research.history_withheld, true);
    assert.deepEqual(f.calls.filter(call => call.url.endsWith('/chat')).map(call => call.body.model), [model]);
    assert.equal(f.calls.filter(call => call.url.endsWith('/web_search')).length, 0);
    const chat = JSON.stringify(f.calls.find(call => call.url.endsWith('/chat')).body);
    assert.ok(!chat.includes('PRIVATE-SELECTED-JOB') && !chat.includes('PRIVATE-HISTORY'));
    assert.match(chat, /technical PM, investigator and QA lead/);
    assert.match(chat, /Atlas is a map, not evidence/);
    assert.match(chat, /cannot create jobs/);
    assert.match(chat, /People before property/);
    assert.match(chat, /custodian, not owner/);
    assert.match(chat, /not by keywords/);
    assert.match(chat, /Do not make the owner diagnose code/);
    assert.match(chat, /not a complete autonomous investigator/);
    const request = f.calls.find(call => call.url.endsWith('/chat')).body;
    assert.ok(!('format' in request));
    assert.match(result.reply, /Start by checking/);
  }
});

test('a reviewed report keeps its qualification when cited alongside primary documentation or corroborating domains', () => {
  const report = { id: 'reviewed-summary', transfer: 'reviewed_summary', content: CONTENT };
  for (const otherSources of [
    [SOURCE],
    ['a.com', 'b.org', 'c.net'].map((domain, index) => ({ id: `web-${index}`, url: `https://${domain}/`, content: CONTENT })),
  ]) {
    const sources = [report, ...otherSources];
    const checked = evidenceAnswer({
      summary: 'Reported behavior with reference material.',
      claims: [{ statement: 'The owner reports this behavior.', evidence: sources.map(source => ({ source_id: source.id, quote: CONTENT })) }],
    }, sources);
    assert.equal(checked.claims[0].verification, 'human_report_not_independently_verified');
  }
});

test('a short reviewed report accepts its complete exact quote but not fragments or short document quotes', async () => {
  const f = fixture({ result: () => answer('reviewed-summary', 'HTTP 500') });
  const checked = await f.run(pmMessage('pm', 'HTTP 500'));
  assert.equal(checked.research.claims[0].verification, 'human_report_not_independently_verified');
  assert.throws(() => evidenceAnswer(answer('report', '500'), [{ id: 'report', transfer: 'reviewed_summary', content: 'HTTP 500' }]), /quote was not found/);
  assert.throws(() => evidenceAnswer(answer('report', 'HTTP 500'), [{ id: 'report', transfer: 'locally_extracted_text', content: 'HTTP 500' }]), /quote was not found/);
  assert.throws(() => evidenceAnswer(answer('report', 'HTTP 500'), [{ id: 'report', transfer: 'reviewed_summary', content: 'Reported HTTP 500 after saving.' }]), /quote was not found/);
});

test('PM rejects output-limit termination for advisory and sourced answers without fallback or success', async () => {
  for (const sourced of [false, true]) {
    const f = fixture({
      doneReason: 'length',
      result: () => sourced ? answer('reviewed-summary', CONTENT) : 'An unfinished answer with the remaining checks',
    });
    await assert.rejects(f.run(pmMessage('pm', sourced ? CONTENT : '')), /output limit reached; answer is incomplete/);
    assert.deepEqual(f.calls.filter(call => call.url.endsWith('/chat')).map(call => call.body.model), ['kimi-k2.7-code']);
    assert.ok(!f.rows.some(row => row.kind === 'message'));
  }
});

test('PM summary quotes are matched but labelled human reports, never primary or live verification', async () => {
  const f = fixture({ result: () => answer('reviewed-summary', CONTENT) });
  const result = await f.run(pmMessage('pm', CONTENT));
  assert.equal(result.research.claims[0].verification, 'human_report_not_independently_verified');
  assert.equal(result.research.sources[0].transfer, 'reviewed_summary');
  assert.equal(result.research.sources[0].sha256, crypto.createHash('sha256').update(CONTENT).digest('hex'));
  assert.ok(!('content' in result.research.sources[0]));
  const chat = f.calls.find(call => call.url.endsWith('/chat'));
  assert.equal(JSON.parse(chat.body.messages[1].content).sources[0].content, CONTENT);
  assert.ok(!JSON.stringify(chat.body).includes(OWNER));
  assert.ok(!JSON.stringify(chat.body).includes(THREAD.id));
  assert.equal(chat.body.format.properties.claims.minItems, 1);
});

test('PM preserves a complete advisory answer instead of silently cutting off its limitations', async () => {
  const text = `${'Guidance. '.repeat(350)}This does not prove execution or safe completion.`;
  const f = fixture({ result: () => text });
  const result = await f.run(pmMessage());
  assert.ok(result.reply.includes(text));
  const oversized = fixture({ result: () => 'x'.repeat(12001) });
  await assert.rejects(oversized.run(pmMessage()), /bounded response contract/);
});

test('PM screenshot review requires advertised vision on its assigned model without a model switch', async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]);
  const msg = pmMessage();
  msg.payload.research_consent.raw_images_allowed = true;
  msg.payload.research_files = [{
    id: 'image', file_name: 'synthetic.png', file_type: 'image/png', file_size_bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    storage_path: `desktop/${OWNER}/builder-chat/${THREAD.id}/image-synthetic.png`,
  }];
  const f = fixture({
    bytes,
    result: () => ({ summary: 'A synthetic shape is visible.', claims: [], image_observations: [{ source_id: 'attachment-1', description: 'A blue square.' }] }),
  });
  const outcome = await f.run(msg);
  assert.equal(outcome.research.raw_images_sent, 1);
  const chat = f.calls.find(call => call.url.endsWith('/chat')).body;
  assert.equal(chat.format.properties.image_observations.minItems, 1);
  assert.deepEqual(chat.messages[1].images, [bytes.toString('base64')]);
  const incompatible = fixture({ models: ['kimi-k3', 'kimi-k2.7-code'], bytes, vision: false });
  await assert.rejects(incompatible.run(msg), /required completion\/vision capability/);
  assert.ok(!incompatible.calls.some(call => call.url.endsWith('/chat')));
});

test('PM refuses changed approval, unassigned purpose and oversized summaries before cloud access', async () => {
  for (const mutate of [
    msg => { msg.payload.evidence_summary = 'changed'; },
    msg => { msg.payload.pm_purpose = 'qa'; },
    msg => { msg.payload.pm_purpose = 'random'; },
    msg => { msg.payload.evidence_summary = 'x'.repeat(6001); },
  ]) {
    const f = fixture({ models: ['kimi-k3'] });
    const msg = pmMessage();
    mutate(msg);
    await assert.rejects(f.run(msg), /purpose|summary/);
    assert.equal(f.calls.length, 0);
  }
});

test('PM unavailability, provider failure and invalid output never start another model', async () => {
  for (const options of [
    { models: ['kimi-k3'] },
    { models: ['kimi-k3', 'kimi-k2.7-code'], failedModel: 'kimi-k2.7-code' },
    { models: ['kimi-k3', 'kimi-k2.7-code'], result: () => '' },
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(pmMessage()), /no automatic fallback/i);
    assert.ok(f.calls.filter(call => call.url.endsWith('/chat')).length <= 1);
    assert.ok(!f.calls.some(call => call.body?.model === 'kimi-k3'));
    assert.ok(!f.rows.some(row => /trying the next/.test(row.content)));
  }
});

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

test('normal PM dispatch bypasses private checkout, gateway, history and proposal flow', async () => {
  const f = fixture({ result: () => 'Atlas guides investigation; it is not execution evidence.' });
  const posted = [];
  const store = {
    thread: async () => THREAD, updateThread: async () => {}, complete: async () => {},
    post: async (_id, row) => posted.push(row),
    history: async () => { throw new Error('Private history must not be loaded'); },
  };
  const outcome = await processBuilderChatMessage({ store, message: pmMessage(), deps: {
    resolveHead: () => { throw new Error('Private checkout must not be loaded'); },
    gateway: { run: () => { throw new Error('Private gateway must not be invoked'); } },
    research: { env: ENV, fetchImpl: f.fetchImpl },
  } });
  assert.equal(outcome.error, undefined);
  assert.ok(!posted.some(row => row.kind === 'proposal'));
  assert.equal(posted.at(-1).payload.model, 'kimi-k2.7-code');
  assert.equal(posted.at(-1).payload.research.purpose, 'pm');
});
