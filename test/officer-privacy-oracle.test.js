const assert = require('node:assert/strict');
const test = require('node:test');
const { describeOfficerPrivacy, discloseOfficerPrivacy, reviewOfficerPrivacy } = require('../officer-privacy-oracle');
const { createModelGatewayConfig, validateModelRequest, invokeBuilderModel } = require('../builder-model-gateway');

const finding = (key, status = 'clear', names = [], details = []) => ({ key, status, names, details });
const describe = (fields, findings, provider = 'gpu_workstation') => describeOfficerPrivacy(fields, JSON.stringify({ fields: findings }), provider, 'synthetic-private');

test('Conductor removes exact names without rewriting operational instructions', async () => {
  const fields = { site_brief: 'Ask Alex Example to inspect the west exit.' };
  const result = await discloseOfficerPrivacy(fields, describe(fields, [finding('site_brief', 'redact', ['Alex Example'])]));
  assert.equal(result.fields.site_brief, 'Ask [name withheld] to inspect the west exit.');
  assert.equal(result.privacy.status, 'checked');
});

test('clinical or legal source fields can be withheld in full, never treated as clean', async () => {
  const fields = { hs_notes: 'Synthetic restricted assessment.', site_brief: 'Keep the exit clear.' };
  const result = await discloseOfficerPrivacy(fields, describe(fields, [finding('hs_notes', 'withhold'), finding('site_brief')]));
  assert.equal(result.fields.hs_notes, null);
  assert.equal(result.fields.site_brief, fields.site_brief);
  assert.equal(result.privacy.status, 'partly_withheld');
});

test('incomplete, duplicate, contradictory and invented privacy findings fail closed', () => {
  const fields = { site_brief: 'Alex Example checks the exit.', hs_notes: '' };
  for (const findings of [
    [finding('site_brief')],
    [finding('site_brief'), finding('site_brief')],
    [finding('site_brief', 'clear', ['Alex Example']), finding('hs_notes')],
    [finding('site_brief', 'redact'), finding('hs_notes')],
    [finding('site_brief', 'redact', ['Not in source']), finding('hs_notes')],
  ]) assert.throws(() => describe(fields, findings));
  assert.throws(() => describeOfficerPrivacy(fields, '{}', 'openai', 'cloud'));
  assert.throws(() => describeOfficerPrivacy(fields, '{}', 'ollama', 'unqualified'));
});

test('changed sources and spans that the shared replacement cannot remove fail closed', async () => {
  const fields = { site_brief: 'Ask Alex Example.' };
  await assert.rejects(discloseOfficerPrivacy({ site_brief: 'Changed source' }, describe(fields, [finding('site_brief')])), /source changed/);
  const embedded = { site_brief: 'SyntheticAlexExampleToken' };
  await assert.rejects(discloseOfficerPrivacy(embedded, describe(embedded, [finding('site_brief', 'redact', ['AlexExample'])])), /not fully withheld/);
});

test('private provider outages never fall back to a cloud model or disclose source text', async () => {
  const providers = [];
  await assert.rejects(reviewOfficerPrivacy({
    fields: { hs_notes: 'Restricted synthetic text' }, config: {},
    invoke: async ({ input }) => {
      providers.push(input.provider);
      assert.equal(input.builder_mode, 'officer_privacy');
      assert.match(input.system_prompt, /ALL narrative person names must be removed/);
      assert.deepEqual(input.output_schema.properties.fields.items.properties.key.enum, ['hs_notes']);
      assert.deepEqual(input.output_schema.properties.fields.items.required, ['key', 'status', 'names', 'details']);
      return { status: 503 };
    },
  }), /remains withheld/);
  assert.deepEqual(providers, ['gpu_workstation', 'ollama']);
});

test('only qualified GPU or VPS Ollama receipts can produce an officer disclosure', async () => {
  const fields = { site_brief: 'Keep the exit clear.' };
  const body = { provider: 'gpu_workstation', model: 'synthetic-private', content: JSON.stringify({ fields: [finding('site_brief')] }) };
  const result = await reviewOfficerPrivacy({ fields, config: {}, invoke: async () => ({ status: 200, body }) });
  assert.equal(result.fields.site_brief, fields.site_brief);
  const vps = await reviewOfficerPrivacy({ fields, config: {}, invoke: async () => ({ status: 200, body: { ...body, provider: 'ollama' } }) });
  assert.equal(vps.privacy.provider, 'ollama');
  await assert.rejects(reviewOfficerPrivacy({ fields, config: {}, invoke: async () => ({ status: 200, body: { ...body, provider: 'ollama_cloud' } }) }), /remains withheld/);
});

test('all fields across bounded batches are reviewed and bound to the complete source', async () => {
  const fields = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`hazard_${index}`, index === 44 ? 'Ask Alex Example to check the exit.' : `Control ${index}`]));
  const batches = [];
  const result = await reviewOfficerPrivacy({
    fields, config: {},
    invoke: async ({ input }) => {
      const batch = JSON.parse(input.user_prompt);
      batches.push(batch);
      assert.ok(Object.keys(batch).length <= 40);
      assert.ok(JSON.stringify(batch).length <= 30_000);
      return { status: 200, body: { provider: 'gpu_workstation', model: 'synthetic-private', content: JSON.stringify({
        fields: Object.keys(batch).map((key) => key === 'hazard_44' ? finding(key, 'redact', ['Alex Example']) : finding(key)),
      }) } };
    },
  });
  assert.equal(batches.length, 2);
  assert.deepEqual(Object.keys(result.fields), Object.keys(fields));
  assert.equal(result.fields.hazard_44, 'Ask [name withheld] to check the exit.');
  assert.equal(result.privacy.source_hash, require('node:crypto').createHash('sha256').update(JSON.stringify(Object.entries(fields))).digest('hex'));
});

test('GPU failure in a later batch restarts the entire briefing on VPS Ollama', async () => {
  const fields = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`field_${index}`, `Value ${index}`]));
  for (const problem of ['incomplete', 'model-change', 'outage']) {
    let calls = 0;
    const providers = [];
    const result = await reviewOfficerPrivacy({
      fields, config: {},
      invoke: async ({ input, input: { provider } }) => {
        calls += 1;
        providers.push(provider);
        if (provider === 'gpu_workstation' && calls === 2 && problem === 'outage') return { status: 503 };
        const keys = Object.keys(JSON.parse(input.user_prompt));
        return { status: 200, body: {
          provider, model: provider === 'gpu_workstation' && calls === 2 && problem === 'model-change' ? 'different-model' : 'synthetic-private',
          content: JSON.stringify({ fields: provider === 'gpu_workstation' && calls === 2 && problem === 'incomplete' ? [] : keys.map((key) => finding(key)) }),
        } };
      },
    });
    assert.equal(result.privacy.provider, 'ollama');
    assert.deepEqual(providers, ['gpu_workstation', 'gpu_workstation', 'ollama', 'ollama']);
    assert.equal(calls, 4);
  }
});

test('batching respects serialized size and rejects an indivisible oversized field', async () => {
  const batches = [];
  await reviewOfficerPrivacy({
    fields: { first: 'a'.repeat(20_000), second: 'b'.repeat(20_000) }, config: {},
    invoke: async ({ input }) => {
      const batch = JSON.parse(input.user_prompt);
      batches.push(batch);
      return { status: 200, body: { provider: 'gpu_workstation', model: 'synthetic-private', content: JSON.stringify({ fields: Object.keys(batch).map((key) => finding(key)) }) } };
    },
  });
  assert.equal(batches.length, 2);
  await assert.rejects(reviewOfficerPrivacy({ fields: { oversized: 'a'.repeat(30_000) }, config: {}, invoke: viNeverCalled }), /exceeds the private model envelope/);
});

function viNeverCalled() { throw new Error('The model must not be invoked for an oversized field'); }

test('private review rejects cloud providers and non-private inference endpoints', () => {
  const config = createModelGatewayConfig({ OLLAMA_BASE_URL: 'http://127.0.0.1:11434', BOB_OLLAMA_MODELS: 'synthetic' });
  const input = { provider: 'ollama', model: 'synthetic', builder_mode: 'officer_privacy', prompt_version: 'test', idempotency_key: 'test', system_prompt: 'Synthetic', user_prompt: 'Synthetic' };
  assert.equal(validateModelRequest(input, config), null);
  assert.match(validateModelRequest({ ...input, provider: 'openai' }, config), /private inference/);
  for (const baseUrl of ['https://ollama.com', 'https://private.example', 'http://127.0.0.1.public.example', 'ftp://127.0.0.1', 'http://user:pass@127.0.0.1']) {
    config.ollama.baseUrl = baseUrl;
    assert.match(validateModelRequest(input, config), /private/);
  }
});

test('sensitive inference refuses redirects and returns only a private receipt', async () => {
  const config = createModelGatewayConfig({ OLLAMA_BASE_URL: 'http://127.0.0.7:11434', BOB_OLLAMA_MODELS: 'synthetic' });
  let inference = false;
  const result = await invokeBuilderModel({
    config, input: { provider: 'ollama', model: 'synthetic', builder_mode: 'officer_privacy', prompt_version: 'test', idempotency_key: 'test', system_prompt: 'Synthetic', user_prompt: 'Synthetic' },
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'synthetic' }] }) };
      inference = true;
      assert.equal(init.redirect, 'error');
      return { ok: true, json: async () => ({ message: { content: '{"fields":[]}' } }) };
    },
  });
  assert.equal(inference, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'ollama');
});
