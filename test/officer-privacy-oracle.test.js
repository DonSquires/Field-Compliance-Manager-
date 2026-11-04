const assert = require('node:assert/strict');
const test = require('node:test');
const { describeOfficerPrivacy, discloseOfficerPrivacy, reviewOfficerPrivacy } = require('../officer-privacy-oracle');
const { createModelGatewayConfig, validateModelRequest, invokeBuilderModel } = require('../builder-model-gateway');

const finding = (key, status = 'clear', names = [], details = []) => ({ key, status, names, details });
const describe = (fields, findings) => describeOfficerPrivacy(fields, JSON.stringify({ fields: findings }), 'gpu_workstation', 'synthetic-private');

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
  assert.deepEqual(providers, ['gpu_workstation']);
});

test('only the qualified GPU receipt can produce an officer disclosure', async () => {
  const fields = { site_brief: 'Keep the exit clear.' };
  const body = { provider: 'gpu_workstation', model: 'synthetic-private', content: JSON.stringify({ fields: [finding('site_brief')] }) };
  const result = await reviewOfficerPrivacy({ fields, config: {}, invoke: async () => ({ status: 200, body }) });
  assert.equal(result.fields.site_brief, fields.site_brief);
  await assert.rejects(reviewOfficerPrivacy({ fields, config: {}, invoke: async () => ({ status: 200, body: { ...body, provider: 'ollama' } }) }), /remains withheld/);
});

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
