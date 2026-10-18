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
  assert.deepEqual(result.body.usage, { input_tokens: 8, output_tokens: 3, inference: { load_ms: null, prompt_ms: null, generation_ms: null, output_tokens_per_second: null } });
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
test('model health publishes each provider effective output cap so callers can size prompts', async () => {
  const localConfig = createModelGatewayConfig({
    OLLAMA_BASE_URL: 'http://ollama.example:11434',
    BOB_OLLAMA_MODELS: 'approved-local',
    BOB_OLLAMA_NUM_CTX: '32768',
    BOB_BUILDER_MAX_OUTPUT_TOKENS: '32000'
  });
  const { modelHealth } = require('../builder-model-gateway');
  const health = await modelHealth(localConfig, { fetchImpl: async () => ({ ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) }) });
  assert.equal(health.ollama.num_ctx, 32768);
  assert.equal(health.ollama.max_output_tokens, 8192, 'a local provider never reserves more than its own cap');
  assert.equal(health.openai.max_output_tokens, 32000);
});

test('Ollama Cloud is keyed, uses the Ollama chat API at ollama.com, and never sends keep_alive', async () => {
  const cloudConfig = createModelGatewayConfig({ OLLAMA_API_TOKEN: 'cloud-key', BOB_OLLAMA_CLOUD_MODELS: 'gpt-oss:120b' });
  const calls = [];
  const result = await invokeBuilderModel({
    input: request({ provider: 'ollama_cloud', model: 'gpt-oss:120b' }),
    config: cloudConfig,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'gpt-oss:120b' }] }) };
      return { ok: true, json: async () => ({ message: { content: 'cloud answer' }, prompt_eval_count: 5, eval_count: 2 }) };
    }
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.content, 'cloud answer');
  const chat = calls.find(call => call.url === 'https://ollama.com/api/chat');
  assert.ok(chat, 'chat goes to ollama.com');
  assert.equal(chat.init.headers.Authorization, 'Bearer cloud-key');
  assert.equal(JSON.parse(chat.init.body).keep_alive, undefined);
  assert.ok(calls.every(call => call.init.headers?.Authorization === 'Bearer cloud-key'), 'every cloud request is authenticated');
});

test('Ollama Cloud without a key is reported unconfigured and is never called', async () => {
  let called = false;
  const result = await invokeBuilderModel({
    input: request({ provider: 'ollama_cloud', model: 'gpt-oss:120b' }),
    config: createModelGatewayConfig({ BOB_OLLAMA_CLOUD_MODELS: 'gpt-oss:120b' }),
    fetchImpl: async () => { called = true; throw new Error('must not call'); }
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'provider_unconfigured');
  assert.equal(called, false);
});

test('local Ollama requests carry no Authorization header', async () => {
  const calls = [];
  await invokeBuilderModel({
    input: request({ provider: 'ollama', model: 'approved-local' }),
    config: createModelGatewayConfig({ OLLAMA_BASE_URL: 'http://ollama.local:11434', BOB_OLLAMA_MODELS: 'approved-local', OLLAMA_API_TOKEN: 'cloud-key' }),
    fetchImpl: async (url, init = {}) => { calls.push(init); return { ok: true, json: async () => url.endsWith('/api/tags') ? { models: [{ name: 'approved-local' }] } : { message: { content: 'x' } } }; }
  });
  assert.ok(calls.length >= 1);
  assert.ok(calls.every(init => !init.headers?.Authorization), 'the cloud key never leaves for a local host');
});

test('GPU health filters by installed byte size and reserves context headroom, not parameter count', async () => {
  const { modelHealth } = require('../builder-model-gateway');
  const cfg = createModelGatewayConfig({
    GPU_WORKSTATION_URL: 'http://gpu.example:11434',
    BOB_GPU_MODELS: 'qwen2.5-coder:14b,qwen2.5-coder:7b,unknown-size',
    BOB_GPU_VRAM_MB: '8192', BOB_GPU_HEADROOM_MB: '2048',
  });
  let chats = 0;
  const fetchImpl = async url => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [
      { name: 'qwen2.5-coder:14b', size: 9e9 }, { name: 'qwen2.5-coder:7b', size: 4.7e9 }, { name: 'unknown-size' },
    ] }) };
    chats++;
    return { ok: true, json: async () => ({ message: { content: 'ok' }, eval_count: 20, eval_duration: 2e9, load_duration: 1e9 }) };
  };
  const h = await modelHealth(cfg, { fetchImpl, now: () => Date.now() + 60000 });
  assert.deepEqual(h.gpu_workstation.models, ['qwen2.5-coder:7b']);
  assert.deepEqual(h.gpu_workstation.excluded_models, ['qwen2.5-coder:14b', 'unknown-size']);
  assert.equal(h.gpu_workstation.ready_model, 'qwen2.5-coder:7b');
  assert.equal(h.gpu_workstation.model_memory_budget_bytes, 6144 * 1024 ** 2);
  const denied = await invokeBuilderModel({ input: request({ provider: 'gpu_workstation', model: 'qwen2.5-coder:14b' }), config: cfg, fetchImpl });
  assert.equal(denied.status, 422);
  assert.equal(denied.body.code, 'model_memory_budget');
  assert.equal(chats, 0);
  const accepted = await invokeBuilderModel({ input: request({ provider: 'gpu_workstation', model: undefined }), config: cfg, fetchImpl });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.model, 'qwen2.5-coder:7b');
  assert.equal(accepted.body.usage.inference.output_tokens_per_second, 10);
  assert.equal(accepted.body.usage.inference.load_ms, 1000);
  let release;
  const first = invokeBuilderModel({
    input: request({ provider: 'gpu_workstation', model: 'qwen2.5-coder:7b' }), config: cfg,
    fetchImpl: () => new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ message: { content: 'done' } }) }); }),
  });
  await new Promise(resolve => setImmediate(resolve));
  const busy = await invokeBuilderModel({ input: request({ provider: 'gpu_workstation', model: 'qwen2.5-coder:7b' }), config: cfg, fetchImpl });
  assert.equal(busy.body.code, 'provider_busy');
  release();
  await first;
  const after = await invokeBuilderModel({ input: request({ provider: 'gpu_workstation', model: 'qwen2.5-coder:7b' }), config: cfg, fetchImpl });
  assert.equal(after.status, 200, 'local request lock is released');
  assert.throws(() => createModelGatewayConfig({ BOB_GPU_HEADROOM_MB: '8192' }), /GPU memory configuration/);
  assert.throws(() => createModelGatewayConfig({ BOB_GPU_VRAM_MB: 'invalid' }), /GPU memory configuration/);
});

// Keep last: it marks the module-level OpenAI health entry exhausted for the cooldown.
test('an exhausted provider account returns 429 and is reported unavailable until the cooldown ends', async () => {
  const { modelHealth } = require('../builder-model-gateway');
  let chatCalls = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/models')) return { ok: true, json: async () => ({ data: [{ id: 'approved-openai' }] }) };
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) };
    chatCalls += 1;
    return { ok: false, status: 429, json: async () => ({ error: { message: 'You have no credits remaining. Add credits to continue.', type: 'insufficient_quota', code: 'insufficient_quota' } }) };
  };
  const first = await invokeBuilderModel({ input: request(), config: config(), fetchImpl });
  assert.equal(first.status, 429);
  assert.equal(first.body.code, 'provider_quota');
  const health = await modelHealth(config(), { fetchImpl });
  assert.equal(health.openai.healthy, false);
  assert.equal(health.openai.unavailable_reason, 'quota_exhausted');
  assert.equal(health.openai.ready_model, null);
  const second = await invokeBuilderModel({ input: request(), config: config(), fetchImpl });
  assert.equal(second.status, 429);
  assert.equal(chatCalls, 1, 'the exhausted account is not called again during the cooldown');
});
