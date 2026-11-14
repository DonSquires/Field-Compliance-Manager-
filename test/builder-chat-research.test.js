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

function fixture({ models = ['kimi-k2.7-code'], vision = true, result = () => answer(), bytes, failedModel, searchResults, doneReason = 'stop', fetchStatus = {}, chatStatus,
  env = ENV, gateway, modelRouter, fetchHealth, callGateway } = {}) {
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
    if (endpoint === 'web_fetch') {
      if (fetchStatus[body.url]) return new Response(JSON.stringify({ error: 'page not found' }), { status: fetchStatus[body.url] });
      return Response.json({ title: 'Compose documentation', content: CONTENT });
    }
    if (endpoint === 'web_search') return Response.json({ results: searchResults || [{ url: SOURCE.url }] });
    if (chatStatus) return new Response(JSON.stringify({ error: 'you (account) have reached your monthly usage limit, upgrade for higher limits: https://ollama.com/upgrade' }), { status: chatStatus });
    if (body.model === failedModel) return new Response('', { status: 503 });
    const response = result(body);
    return Response.json({ message: response?.tool_calls ? response : { content: typeof response === 'string' ? response : JSON.stringify(response) }, done_reason: doneReason });
  };
  return {
    calls, rows, fetchImpl,
    run: msg => runBuilderResearch({
      thread: THREAD, message: msg || message(), env, fetchImpl, gateway, modelRouter, fetchHealth, callGateway,
      post: async row => rows.push(row),
      supabase: { storage: { from: () => ({ download: async storagePath => ({
        data: new Blob([typeof bytes === 'function' ? bytes(storagePath) : bytes || 'text']), error: null,
      }) }) } },
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

function fusionPmMessage(purpose = 'pm', summary = '') {
  const value = pmMessage(purpose, summary);
  return { ...value, payload: { ...value.payload, research_consent: {
    ...value.payload.research_consent, policy_version: 'builder_pm_fusion_v1',
    raw_images_allowed: true, fusion_provider_allowlist: ['ollama_cloud', 'openai', 'anthropic', 'gemini'],
  } } };
}

function fusionHealth({ cloud = true, vision = false } = {}) {
  return {
    gpu_workstation: { configured: false, healthy: false },
    ollama: { configured: false, healthy: false },
    ollama_cloud: { configured: cloud, healthy: cloud, ready_model: 'kimi-k2.7-code', models: ['kimi-k2.7-code'] },
    openai: { configured: true, healthy: true, ready_model: 'gpt-4o-mini', models: ['gpt-4o-mini'] },
    anthropic: { configured: true, healthy: true, ready_model: 'claude-haiku-5-5', models: ['claude-haiku-5-5'] },
    gemini: { configured: true, healthy: true, ready_model: 'gemini-3.8-flash', models: ['gemini-3.8-flash'], vision_models: vision ? ['gemini-3.8-flash'] : [] },
  };
}

function orderedFusionRouter(order, observations = []) {
  return {
    rank: async ({ candidates, surface, workloadKind }) => {
      assert.equal(surface, 'builder');
      assert.equal(workloadKind, 'builder_conversation');
      return {
        ordered: order.map(provider => candidates.find(candidate => candidate.provider === provider)).filter(Boolean),
        task_class: 'conversation', policy: { surface: 'builder', task_class: 'conversation' }, excluded: [],
      };
    },
    observe: row => observations.push(row),
  };
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

test('new PM Fusion consent ranks only approved providers and falls through an exhausted Ollama Cloud account', async () => {
  const calls = [];
  const observations = [];
  const router = orderedFusionRouter(['ollama_cloud', 'openai', 'anthropic', 'gemini'], observations);
  const f = fixture({
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'server-only' },
    fetchHealth: async () => fusionHealth(), modelRouter: router,
    callGateway: async ({ modelRequest }) => {
      const request = modelRequest.request;
      calls.push({ provider: modelRequest.provider, model: modelRequest.model_name, messages: request.messages });
      if (modelRequest.provider === 'ollama_cloud') return { ok: false, status: 429, error: 'provider quota exhausted' };
      return { ok: true, status: 200, data: { content: JSON.stringify({
        summary: 'The reviewed packet is advisory.',
        claims: [{ statement: 'The packet reports a concern.', evidence: [{ source_id: 'reviewed-summary', quote: 'Reviewed, non-sensitive report summary.' }] }],
      }), finish_reason: 'stop' } };
    },
  });
  const result = await f.run(fusionPmMessage('pm', 'Reviewed, non-sensitive report summary.'));

  assert.equal(result.research.policy_version, 'builder_pm_fusion_v1');
  assert.equal(result.research.provider, 'openai');
  assert.equal(result.research.model, 'gpt-4o-mini');
  assert.equal(result.research.external_egress, true);
  assert.deepEqual(calls.map(call => call.provider), ['ollama_cloud', 'openai']);
  const approvedPrompt = JSON.stringify(calls[0].messages);
  assert.match(approvedPrompt, /Reviewed, non-sensitive report summary/);
  assert.doesNotMatch(approvedPrompt, /PRIVATE-SELECTED-JOB|PRIVATE-HISTORY/);
  assert.ok(observations.some(row => row.provider === 'ollama_cloud' && !row.ok));
  assert.ok(observations.some(row => row.provider === 'openai' && row.ok));
  const attempts = result.research.routing.attempts;
  assert.deepEqual(attempts.map(row => row.provider), ['ollama_cloud', 'openai']);
});

test('public web evidence stays on Ollama Cloud even when Fusion ranks another consented provider first', async () => {
  const calls = [];
  const f = fixture({
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'server-only' },
    fetchHealth: async () => fusionHealth(),
    modelRouter: orderedFusionRouter(['openai', 'ollama_cloud']),
    callGateway: async ({ modelRequest }) => {
      calls.push({ provider: modelRequest.provider, messages: modelRequest.request.messages });
      return { ok: true, status: 200, data: { content: JSON.stringify(answer()), finish_reason: 'stop' } };
    },
  });

  const msg = fusionPmMessage('pm');
  msg.payload.research_urls = [SOURCE.url];
  await f.run(msg);

  assert.deepEqual(calls.map(call => call.provider), ['ollama_cloud']);
  assert.match(JSON.stringify(calls[0].messages), /Compose uses a YAML file/);
});

test('Fusion can select Anthropic and Gemini for text PM turns without widening the consent set', async () => {
  for (const provider of ['anthropic', 'gemini']) {
    const calls = [];
    const f = fixture({
      env: { ...ENV, OLLAMA_API_KEY: '', OLLAMA_API_TOKEN: '', BOB_VIBE_ALLOW_OLLAMA_CLOUD: 'false' },
      gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'server-only' },
      fetchHealth: async () => fusionHealth({ cloud: false }),
      modelRouter: orderedFusionRouter([provider]),
      callGateway: async ({ modelRequest }) => {
        calls.push(modelRequest.provider);
        return { ok: true, status: 200, data: { content: JSON.stringify({ summary: 'The current question can be answered from the approved packet.', claims: [] }), finish_reason: 'stop' } };
      },
    });
    const result = await f.run(fusionPmMessage('technical_review'));
    assert.equal(result.research.provider, provider);
    assert.deepEqual(calls, [provider]);
    assert.equal(result.research.external_egress, true);
    assert.deepEqual(result.research.routing.attempts.map(attempt => attempt.provider), [provider]);
  }
});

test('Fusion can keep a PM packet on a configured private provider when policy ranks it first', async () => {
  const calls = [];
  const health = fusionHealth();
  health.gpu_workstation = { configured: true, healthy: true, ready_model: 'qwen2.5-coder:7b', models: ['qwen2.5-coder:7b'] };
  const f = fixture({
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'server-only' },
    fetchHealth: async () => health,
    modelRouter: orderedFusionRouter(['gpu_workstation']),
    callGateway: async ({ modelRequest }) => {
      calls.push(modelRequest.provider);
      return { ok: true, status: 200, data: { content: JSON.stringify({ summary: 'A private Fusion answer.', claims: [] }), finish_reason: 'stop' } };
    },
  });

  const result = await f.run(fusionPmMessage('pm'));
  assert.equal(result.research.provider, 'gpu_workstation');
  assert.equal(result.research.external_egress, false);
  assert.deepEqual(calls, ['gpu_workstation']);
});

test('a Fusion provider output-limit finish reason is refused rather than accepted as an answer', async () => {
  const f = fixture({
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'server-only' },
    fetchHealth: async () => fusionHealth({ cloud: false }),
    modelRouter: orderedFusionRouter(['gemini']),
    callGateway: async () => ({ ok: true, status: 200, data: { content: '{"summary":"truncated', finish_reason: 'MAX_TOKENS' } }),
  });
  await assert.rejects(f.run(fusionPmMessage('pm')), /output limit reached; answer is incomplete/);
  assert.equal(f.rows.some(row => row.kind === 'message'), false);
});

test('new PM Fusion rejects provider-list tampering and routes image bytes only to a verified Gemini vision model', async () => {
  const tampered = fusionPmMessage();
  tampered.payload.research_consent.fusion_provider_allowlist.push('omniroute');
  const denied = fixture({ gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'server-only' } });
  await assert.rejects(denied.run(tampered), /differs from the approved allowlist/);
  assert.equal(denied.calls.length, 0);

  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const jpeg = Buffer.from([255, 216, 255, 1, 2, 3]);
  const sha256 = image => crypto.createHash('sha256').update(image).digest('hex');
  const msg = fusionPmMessage('pm', '');
  msg.payload.research_files = [
    { id: 'attachment-png', file_name: 'approved.png', file_type: 'image/png', file_size_bytes: png.length,
      sha256: sha256(png), storage_path: `desktop/${OWNER}/builder-chat/${THREAD.id}/attachment-png-approved.png`, extracted_text: '' },
    { id: 'attachment-jpeg', file_name: 'approved.jpg', file_type: 'image/jpeg', file_size_bytes: jpeg.length,
      sha256: sha256(jpeg), storage_path: `desktop/${OWNER}/builder-chat/${THREAD.id}/attachment-jpeg-approved.jpg`, extracted_text: '' },
  ];
  const calls = [];
  const f = fixture({
    bytes: storagePath => storagePath.includes('attachment-png-') ? png : jpeg,
    env: { ...ENV, OLLAMA_API_KEY: '', OLLAMA_API_TOKEN: '', BOB_VIBE_ALLOW_OLLAMA_CLOUD: 'false' },
    gateway: { gatewayUrl: 'http://gateway.invalid', apiToken: 'server-only' },
    fetchHealth: async () => fusionHealth({ cloud: false, vision: true }),
    modelRouter: orderedFusionRouter(['gemini', 'openai', 'anthropic']),
    callGateway: async ({ modelRequest }) => {
      calls.push({ provider: modelRequest.provider, message: modelRequest.request.messages[1] });
      return { ok: true, status: 200, data: { content: JSON.stringify({
        summary: 'The approved image shows a roster screen.', claims: [],
        image_observations: [
          { source_id: 'attachment-1', description: 'A roster screen is visible.' },
          { source_id: 'attachment-2', description: 'A second roster view is visible.' },
        ],
      }), finish_reason: 'stop' } };
    },
  });
  const result = await f.run(msg);
  assert.equal(result.research.provider, 'gemini');
  assert.equal(result.research.raw_images_sent, 2);
  assert.deepEqual(calls.map(call => call.provider), ['gemini']);
  assert.deepEqual(calls[0].message.image_mime_types, ['image/png', 'image/jpeg']);
  assert.deepEqual(calls[0].message.images, [png.toString('base64'), jpeg.toString('base64')]);
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

test('a search result that cannot be fetched is skipped with a receipt instead of aborting research', async () => {
  const dead = 'https://gone.example.org/missing';
  const f = fixture({ searchResults: [{ url: dead }, { url: SOURCE.url }], fetchStatus: { [dead]: 404 } });
  const result = await f.run(message({ research_urls: [], web_search: true }));
  assert.equal(result.model, 'kimi-k2.7-code');
  assert.deepEqual(result.research.unfetched_sources, [{ url: dead, error: 'Ollama web_fetch HTTP 404: page not found' }]);
});

test('an explicitly requested source that cannot be fetched names the endpoint, status and URL', async () => {
  const dead = 'https://gone.example.org/missing';
  const f = fixture({ fetchStatus: { [dead]: 404 } });
  await assert.rejects(f.run(message({ research_urls: [dead] })), /web_fetch HTTP 404: page not found.*gone\.example\.org/);
});

test('an account usage limit stops immediately with an actionable message instead of trying every model', async () => {
  const f = fixture({ models: ['kimi-k2.7-code', 'deepseek-v4.1-flash:1017'], chatStatus: 429 });
  await assert.rejects(f.run(), /Ollama Cloud usage limit reached \(HTTP 429\).*add usage credits or upgrade/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/chat')).length, 1);
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

test('PM investigation handoff persists a confirmable card, not a dispatched job or fabricated repair', async () => {
  const msg = pmMessage();
  const f = fixture({ result: () => ({ content: '', tool_calls: [{ function: {
    name: 'propose_builder_investigation',
    arguments: {
      title: 'Reported Compose behavior', report_quote: msg.content,
      assessment: 'The reported configuration behavior needs investigation before selecting a repair.',
      investigation_steps: ['Inspect the owning source and current schema path.', 'Reproduce the report using synthetic configuration.'],
      acceptance_checks: ['Verify the expected configuration behavior after the fix.', 'Verify existing valid configuration remains supported.'],
      unknowns: 'The cause and affected paths have not been independently checked.',
      frontend_required: false, backend_required: true,
    },
  } }] }) });
  const posted = [];
  const completions = [];
  const store = {
    thread: async () => THREAD, updateThread: async () => {},
    complete: async (...args) => completions.push(args),
    post: async (_id, row) => posted.push(row),
    history: async () => assert.fail('No private history'),
  };
  const outcome = await processBuilderChatMessage({ store, message: msg, deps: {
    resolveHead: () => assert.fail('No private checkout'),
    supabase: { rpc: () => assert.fail('No automatic job or diary write') },
    research: { env: ENV, fetchImpl: f.fetchImpl },
  } });
  assert.equal(outcome.error, undefined);
  const card = posted.find(row => row.kind === 'proposal');
  assert.equal(card.payload.proposal.handoff_kind, 'investigation');
  assert.equal(card.payload.proposal.source_message_id, msg.id);
  assert.equal(card.payload.job_id, undefined);
  assert.equal(card.payload.main_head, null);
  assert.match(outcome.reply, /No job exists yet/);
  assert.equal(f.calls.filter(call => call.url.endsWith('/chat')).length, 1);
  assert.deepEqual(completions, [[msg.id, 'done']]);
});
