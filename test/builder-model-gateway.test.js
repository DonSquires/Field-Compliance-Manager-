const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createModelGatewayConfig,
  modelGatewayReadiness,
  validateModelRequest,
  invokeBuilderModel
} = require('../builder-model-gateway');

function request(overrides = {}) {
  return {
    provider: 'openai',
    model: 'approved-openai',
    builder_mode: 'product_analyst',
    prompt_version: 'product-v1',
    idempotency_key: 'job::step::hash',
    system_prompt: 'Return a grounded specification.',
    user_prompt: 'Analyze this change.',
    ...overrides
  };
}

function config() {
  return createModelGatewayConfig({
    OPENAI_API_KEY: 'test-key',
    OPENAI_BASE_URL: 'https://openai.example/v1',
    BOB_OPENAI_MODELS: 'approved-openai',
    OLLAMA_BASE_URL: 'http://ollama.example:11434',
    BOB_OLLAMA_MODELS: 'approved-local'
  });
}

test('model gateway accepts the VPS and hPanel Ollama URL alias', () => {
  const gatewayConfig = createModelGatewayConfig({
    OLLAMA_URL: 'https://hpanel-gpu.example/ollama/',
    BOB_OLLAMA_AUTH_TOKEN: 'gpu-gateway-token',
    BOB_OLLAMA_MODELS: 'qwen-coder:14b'
  });

  assert.equal(gatewayConfig.ollama.baseUrl, 'https://hpanel-gpu.example/ollama');
  assert.equal(gatewayConfig.ollama.apiKey, 'gpu-gateway-token');
  assert.deepEqual(modelGatewayReadiness(gatewayConfig), {
    openai_configured: false,
    ollama_configured: true,
    ollama_auth_configured: true,
    local_builder_provider: 'ollama'
  });
});

test('model gateway rejects models outside the provider allowlist', () => {
  assert.equal(validateModelRequest(request({ model: 'unapproved' }), config()), 'model is not allowed');
});

test('model gateway reports an unconfigured provider without dereferencing it', async () => {
  const result = await invokeBuilderModel({
    input: request({ provider: 'ollama', model: 'approved-local' }),
    config: { openai: { baseUrl: 'https://openai.example/v1', apiKey: 'test-key', models: new Set(['approved-openai']) } },
    fetchImpl: async () => {
      throw new Error('fetch should not be called');
    }
  });

  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'ollama provider is not configured');
});

test('model gateway normalizes OpenAI output and usage', async () => {
  let capturedUrl;
  const result = await invokeBuilderModel({
    input: request(),
    config: config(),
    fetchImpl: async url => {
      capturedUrl = url;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"summary":"grounded"}' } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 }
        })
      };
    }
  });

  assert.equal(capturedUrl, 'https://openai.example/v1/chat/completions');
  assert.equal(result.status, 200);
  assert.equal(result.body.content, '{"summary":"grounded"}');
  assert.deepEqual(result.body.usage, { prompt_tokens: 12, completion_tokens: 4 });
});

test('model gateway normalizes Ollama output and token counts', async () => {
  let captured;
  const result = await invokeBuilderModel({
    input: request({ provider: 'ollama', model: 'approved-local' }),
    config: createModelGatewayConfig({
      OLLAMA_BASE_URL: 'http://ollama.example:11434',
      BOB_OLLAMA_AUTH_TOKEN: 'local-token',
      BOB_OLLAMA_MODELS: 'approved-local'
    }),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
      ok: true,
      json: async () => ({
        message: { content: 'local summary' },
        prompt_eval_count: 8,
        eval_count: 3
      })
    };
    }
  });

  assert.equal(captured.url, 'http://ollama.example:11434/api/chat');
  assert.equal(captured.options.headers.Authorization, 'Bearer local-token');
  assert.equal(result.status, 200);
  assert.equal(result.body.content, 'local summary');
  assert.deepEqual(result.body.usage, { input_tokens: 8, output_tokens: 3 });
});

test('model gateway falls back to the local provider when the preferred hosted provider is unavailable', async () => {
  let calls = [];
  const result = await invokeBuilderModel({
    input: request({ provider: 'openai', model: 'approved-openai' }),
    config: createModelGatewayConfig({
      OPENAI_API_KEY: 'test-key',
      OPENAI_BASE_URL: 'https://openai.example/v1',
      BOB_OPENAI_MODELS: 'approved-openai',
      OLLAMA_BASE_URL: 'http://ollama.example:11434',
      BOB_OLLAMA_AUTH_TOKEN: 'local-token',
      BOB_OLLAMA_MODELS: 'approved-local'
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers.Authorization });
      if (url.startsWith('https://openai.example')) {
        return { ok: false, json: async () => ({ error: 'rate limited' }) };
      }
      return {
        ok: true,
        json: async () => ({
          message: { content: 'local fallback summary' },
          prompt_eval_count: 5,
          eval_count: 2
        })
      };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://openai.example/v1/chat/completions');
  assert.equal(calls[1].url, 'http://ollama.example:11434/api/chat');
  assert.equal(calls[1].authorization, 'Bearer local-token');
  assert.equal(result.status, 200);
  assert.equal(result.body.provider, 'ollama');
  assert.equal(result.body.content, 'local fallback summary');
});

test('model gateway does not expose provider response bodies on failure', async () => {
  const result = await invokeBuilderModel({
    input: request(),
    config: config(),
    fetchImpl: async () => ({ ok: false, json: async () => ({ secret: 'provider-detail' }) })
  });

  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result), /provider-detail/);
});