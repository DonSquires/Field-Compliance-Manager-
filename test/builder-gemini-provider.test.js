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

test('Gemini completes a Builder request with the existing JSON transport', async () => {
  const config = createModelGatewayConfig({ GEMINI_API_KEY: 'synthetic-google-key', BOB_GEMINI_MODELS: 'gemini-approved' });
  let sent;
  const result = await invokeBuilderModel({
    config, input,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.Authorization, 'Bearer synthetic-google-key');
      if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'gemini-approved' }] }) };
      assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.model, 'gemini-approved');
  assert.deepEqual(sent.response_format, { type: 'json_object' });
  assert.equal('reasoning_effort' in sent, false);
});

test('Supabase Gemini transport is explicit and does not require copying the Google secret', () => {
  const config = createModelGatewayConfig({
    BOB_GEMINI_USE_SUPABASE_PROXY: '1',
    SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key',
  });
  assert.equal(config.gemini.baseUrl, 'https://fixture.supabase.co/functions/v1/bob-gemini-gateway');
  assert.equal(config.gemini.apiKey, 'synthetic-service-key');
  const disabled = createModelGatewayConfig({ SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-key' });
  assert.equal(disabled.gemini.apiKey, '');
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
  assert.deepEqual(restricted.chain, ['gpu_workstation']);
});
