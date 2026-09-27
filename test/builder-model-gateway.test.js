const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createModelGatewayConfig,
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

test('model gateway rejects models outside the provider allowlist', () => {
  assert.equal(validateModelRequest(request({ model: 'unapproved' }), config()), 'model is not allowed');
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
  const result = await invokeBuilderModel({
    input: request({ provider: 'ollama', model: 'approved-local' }),
    config: config(),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        message: { content: 'local summary' },
        prompt_eval_count: 8,
        eval_count: 3
      })
    })
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.content, 'local summary');
  assert.deepEqual(result.body.usage, { input_tokens: 8, output_tokens: 3 });
});

test('local prompt budget reserves requested output tokens inside the model context window', async () => {
  const localConfig = createModelGatewayConfig({ OLLAMA_BASE_URL: 'http://ollama.example:11434', BOB_OLLAMA_MODELS: 'approved-local', BOB_OLLAMA_NUM_CTX: '4096', BOB_BUILDER_MAX_OUTPUT_TOKENS: '1000' });
  let called = false;
  const result = await invokeBuilderModel({
    input: request({ provider: 'ollama', model: 'approved-local', system_prompt: 's'.repeat(11_000), user_prompt: 'u', max_output_tokens: 1000 }),
    config: localConfig,
    fetchImpl: async () => { called = true; throw new Error('must reject before probing an oversized prompt'); }
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.code, 'context_exceeded');
  assert.equal(called, false);
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