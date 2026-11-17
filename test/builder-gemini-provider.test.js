'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createModelGatewayConfig, invokeBuilderModel } = require('../builder-model-gateway');
const { routeBuilderModel } = require('../supabase/functions/_shared/builder-model-adapter');
const { vibeExternalProviders, applyVibeRouting, vibeProviderCandidates } = require('../builder-vibe-session');

const input = {
  provider: 'gemini', model: 'gemini-approved', builder_mode: 'vibe_engineer',
  prompt_version: 'fixture-v1', idempotency_key: 'synthetic',
  system_prompt: 'Return JSON.', user_prompt: 'Say OK.',
  output_schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
};

test('Gemini completes a Builder request with native generateContent transport', async () => {
  const config = createModelGatewayConfig({ GEMINI_API_KEY: 'synthetic-google-key', BOB_GEMINI_MODELS: 'gemini-approved' });
  let sent;
  const result = await invokeBuilderModel({
    config, input,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers['x-goog-api-key'], 'synthetic-google-key');
      if (url.endsWith('/models?pageSize=100')) return { ok: true, json: async () => ({ models: [
        { name: 'models/gemini-approved', supportedGenerationMethods: ['generateContent'] },
      ] }) };
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-approved:generateContent');
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }) };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.model, 'gemini-approved');
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.equal('reasoning_effort' in sent.generationConfig, false);
});

test('Supabase Gemini transport is explicit and uses its dedicated project credential', () => {
  const config = createModelGatewayConfig({
    BOB_GEMINI_USE_SUPABASE_PROXY: '1',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-legacy-key',
    BOB_GEMINI_PROXY_SERVICE_KEY: 'synthetic-project-secret',
  });
  assert.equal(config.gemini.baseUrl, 'https://fixture.supabase.co/functions/v1/bob-gemini-gateway');
  assert.equal(config.gemini.apiKey, 'synthetic-project-secret');
  const disabled = createModelGatewayConfig({ SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' });
  assert.equal(disabled.gemini.apiKey, '');
});

test('proxy discovery and completion authenticate with the gateway project credential', async () => {
  const config = createModelGatewayConfig({
    BOB_GEMINI_USE_SUPABASE_PROXY: '1', BOB_GEMINI_MODELS: 'gemini-approved',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-legacy-key',
    BOB_GEMINI_PROXY_SERVICE_KEY: 'synthetic-project-secret',
  });
  const urls = [];
  const result = await invokeBuilderModel({
    config, input,
    fetchImpl: async (url, init) => {
      urls.push(url);
      assert.equal(init.headers.Authorization, 'Bearer synthetic-project-secret');
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'models/gemini-approved' }] }) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(urls, [
    'https://fixture.supabase.co/functions/v1/bob-gemini-gateway/models',
    'https://fixture.supabase.co/functions/v1/bob-gemini-gateway/chat/completions',
  ]);
});

test('Gemini discovery accepts Google model IDs prefixed with models/', async () => {
  const config = createModelGatewayConfig({
    GEMINI_API_KEY: 'synthetic-prefixed-model-key', BOB_GEMINI_MODELS: 'gemini-approved',
  });
  let completionModel;
  const result = await invokeBuilderModel({
    config, input,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/models?pageSize=100')) return { ok: true, json: async () => ({ models: [
        { name: 'models/gemini-approved', supportedGenerationMethods: ['generateContent'] },
      ] }) };
      completionModel = url;
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }] }) };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(completionModel, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-approved:generateContent');
});

test('proxy refuses requests when its project credential is missing even if a legacy service key exists', async () => {
  const config = createModelGatewayConfig({
    BOB_GEMINI_USE_SUPABASE_PROXY: '1', BOB_GEMINI_MODELS: 'gemini-approved',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-legacy-key',
  });
  let requests = 0;
  const result = await invokeBuilderModel({ config, input, fetchImpl: async () => { requests++; throw new Error('unexpected network request'); } });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'provider_unconfigured');
  assert.equal(requests, 0);
});

test('direct Gemini keeps using its Google credential when a proxy credential is configured', () => {
  const config = createModelGatewayConfig({
    BOB_GEMINI_USE_SUPABASE_PROXY: '1', GEMINI_API_KEY: 'synthetic-google-key',
    BOB_GEMINI_PROXY_SERVICE_KEY: 'synthetic-project-secret',
  });
  assert.equal(config.gemini.kind, 'gemini');
  assert.equal(config.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(config.gemini.apiKey, 'synthetic-google-key');
});

test('Gemini does not claim health or send prompts when credential discovery fails', async () => {
  for (const status of [401, 403, 503]) {
    const config = createModelGatewayConfig({ GEMINI_API_KEY: `synthetic-denied-${status}`, BOB_GEMINI_MODELS: 'gemini-approved' });
    const result = await invokeBuilderModel({
      config, input,
      fetchImpl: async url => {
        assert.ok(url.endsWith('/models'), 'no prompt is sent after the credential probe fails');
        return { ok: false, status, json: async () => ({ error: 'denied' }) };
      },
    });
    assert.equal(result.status, 503);
    assert.equal(result.body.code, 'provider_unavailable');
  }
});

test('Gemini and OpenAI Vibe escalation stays opt-in and never enters restricted routing', () => {
  assert.deepEqual(vibeExternalProviders({}), []);
  const externals = vibeExternalProviders({ BOB_VIBE_EXTERNAL_PROVIDERS: 'ollama_cloud,openai,anthropic,gemini' });
  assert.deepEqual(externals, ['ollama_cloud', 'openai', 'anthropic', 'gemini']);
  const request = applyVibeRouting({ provider: 'gpu_workstation' }, { allowCloud: true, externals });
  const candidates = vibeProviderCandidates(request, {
    gemini: { healthy: true, configured: true, models: ['gemini-approved'], installed: ['gemini-approved'] },
  });
  assert.ok(candidates.some(candidate => candidate.provider === 'gemini'));
  const restricted = routeBuilderModel({
    workloadKind: 'backend_implementation', containsRestrictedData: true,
    env: { BOB_BUILDER_ROUTE_RESTRICTED: 'gemini,openai,anthropic,ollama_cloud,gpu_workstation' },
  });
  assert.deepEqual(restricted.chain, ['gpu_workstation', 'ollama']);
});
