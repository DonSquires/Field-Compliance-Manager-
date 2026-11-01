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

test('local design uses the evidence schema while cloud retains supported JSON mode', () => {
  const { buildProviderBody } = require('../builder-model-gateway');
  const schema = { type: 'object', properties: { route: { type: 'string', enum: ['existing-route'] } }, required: ['route'] };
  for (const provider of ['ollama', 'gpu_workstation']) {
    const body = buildProviderBody({ input: request({ provider, output_schema: schema }), config: config(), model: 'local' });
    assert.deepEqual(body.format, schema);
    assert.equal(body.keep_alive, '5m');
  }
  assert.equal(buildProviderBody({ input: request({ provider: 'ollama_cloud', output_schema: schema }), config: config(), model: 'cloud' }).format, 'json');
  assert.equal(buildProviderBody({ input: request({ provider: 'ollama', output_schema: { type: 'object', required: ['summary'] } }), config: config(), model: 'local' }).format, 'json', 'legacy incomplete schemas retain existing mode');
});

test('Ollama Cloud defaults to the installed coding model before general fallback models', () => {
  const cloud = createModelGatewayConfig({ OLLAMA_API_TOKEN: 'test-cloud-token' }).ollama_cloud;
  const models = Array.from(cloud.models);
  assert.equal(models[0], 'kimi-k2.7-code');
  assert.equal(models[1], 'deepseek-v4.1-flash:1017');
  assert.ok(cloud.models.has('gpt-oss:120b'), 'existing fallback remains available');
});

const nativeTools = [{
  type: 'function',
  function: {
    name: 'read_file', description: 'Read numbered source.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
}];

test('native local calls use declared tools, typed history and the existing normalized dispatch protocol', async () => {
  const c = config();
  c.ollama.baseUrl = 'http://native-tools.example';
  let body;
  const result = await invokeBuilderModel({
    config: c,
    input: request({
      provider: 'ollama', model: 'approved-local', builder_mode: 'vibe_engineer', tools: nativeTools,
      output_schema: { type: 'object', properties: { tool: { type: 'string' } } },
      messages: [
        { role: 'system', content: 'JSON-only transport.' },
        { role: 'user', content: 'Inspect source.' },
        { role: 'assistant', content: JSON.stringify({ tool: 'read_file', args: { path: 'src/a.ts' } }) },
        { role: 'user', content: '{"tool_result":{"content":"source"},"recovery":"inspect the next file"}' },
      ],
    }),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) };
      if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ capabilities: ['completion', 'tools'] }) };
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'src/b.ts' } } }] } }) };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.tool_protocol, 'native');
  assert.deepEqual(JSON.parse(result.body.content), { tool: 'read_file', args: { path: 'src/b.ts' } });
  assert.deepEqual(body.tools, nativeTools);
  assert.equal(body.format, undefined);
  assert.match(body.messages[0].content, /Native function calling overrides/);
  assert.deepEqual(body.messages[2].tool_calls[0].function, { name: 'read_file', arguments: { path: 'src/a.ts' } });
  assert.equal(body.messages[3].role, 'tool');
  assert.equal(body.messages[3].tool_name, 'read_file');
  assert.match(body.messages[3].content, /recovery/);
});

test('health/model inventory cannot leak between different private endpoints', async () => {
  const { probeProvider } = require('../builder-model-gateway');
  const c = config();
  const first = 'http://inventory-a.example';
  const second = 'http://inventory-b.example';
  const probes = [];
  const fetchImpl = async url => {
    probes.push(url);
    return { ok: true, json: async () => ({ models: [{ name: url.startsWith(first) ? 'model-a' : 'model-b' }] }) };
  };
  c.ollama.baseUrl = first;
  const a = await probeProvider(c, 'ollama', { fetchImpl });
  c.ollama.baseUrl = second;
  const b = await probeProvider(c, 'ollama', { fetchImpl });
  c.ollama.baseUrl = first;
  const cached = await probeProvider(c, 'ollama', { fetchImpl });
  assert.deepEqual(a.installed, ['model-a']);
  assert.deepEqual(b.installed, ['model-b']);
  assert.deepEqual(cached.installed, ['model-a']);
  assert.equal(cached.cached, true);
  assert.equal(probes.length, 2);
});

test('verified lack of native capability selects visible JSON compatibility, not silent failure', async () => {
  const c = config();
  c.ollama.baseUrl = 'http://legacy-tools.example';
  let body;
  const schema = { type: 'object', properties: { tool: { type: 'string' } } };
  const result = await invokeBuilderModel({
    config: c, input: request({ provider: 'ollama', model: 'approved-local', builder_mode: 'vibe_engineer', tools: nativeTools, output_schema: schema }),
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) };
      if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ capabilities: ['completion'] }) };
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: { content: '{"tool":"read_file","args":{"path":"src/a.ts"}}' } }) };
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.tool_protocol, 'json');
  assert.match(result.body.tool_protocol_reason, /does not declare/);
  assert.equal(body.tools, undefined);
  assert.deepEqual(body.format, schema);
});

test('declared native support without an actual function cannot become a false-success reply', async () => {
  const c = config();
  c.ollama.baseUrl = 'http://declared-but-unused-tools.example';
  const input = request({ provider: 'ollama', model: 'approved-local', builder_mode: 'vibe_engineer', tools: nativeTools });
  const bodies = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) };
    if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ capabilities: ['completion', 'tools'] }) };
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ message: { content: bodies.length === 1 ? 'Changed and verified.' : '{"tool":"read_file","args":{"path":"src/a.ts"}}' } }) };
  };
  const refused = await invokeBuilderModel({ config: c, input, fetchImpl });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, 'native_tool_call_missing');
  assert.match(refused.body.error, /no tool executed/);
  assert.equal(refused.body.content, undefined);
  const compatible = await invokeBuilderModel({ config: c, input, fetchImpl });
  assert.equal(compatible.status, 200);
  assert.equal(compatible.body.tool_protocol, 'json');
  assert.match(compatible.body.tool_protocol_reason, /returned no function call/);
  assert.ok(bodies[0].tools);
  assert.equal(bodies[1].tools, undefined);
  assert.equal(JSON.parse(compatible.body.content).tool, 'read_file');
});

test('a failed native capability probe cannot be mislabeled as supported or legacy', async () => {
  const c = config();
  c.ollama.baseUrl = 'http://unavailable-tools.example';
  const result = await invokeBuilderModel({
    config: c, input: request({ provider: 'ollama', model: 'approved-local', builder_mode: 'vibe_engineer', tools: nativeTools }),
    fetchImpl: async url => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) };
      return { ok: false, status: 503 };
    },
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, 'native_tool_capability_unavailable');
});

test('parallel native calls are explicitly refused before any Vibe tool dispatch', async () => {
  const c = config();
  c.ollama.baseUrl = 'http://batch-tools.example';
  const result = await invokeBuilderModel({
    config: c, input: request({ provider: 'ollama', model: 'approved-local', builder_mode: 'vibe_engineer', tools: nativeTools }),
    fetchImpl: async url => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) };
      if (url.endsWith('/api/show')) return { ok: true, json: async () => ({ capabilities: ['completion', 'tools'] }) };
      return { ok: true, json: async () => ({ message: { tool_calls: [1, 2].map(() => ({ function: { name: 'read_file', arguments: { path: 'a.ts' } } })) } }) };
    },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.code, 'native_tool_batch_refused');
  assert.match(result.body.error, /none of these calls were executed/);
});

test('native definitions remain private, scoped, well-formed and included in prompt limits', () => {
  assert.match(validateModelRequest(request({ builder_mode: 'vibe_engineer', tools: nativeTools }), config()), /restricted to private/);
  assert.match(validateModelRequest(request({ provider: 'ollama', model: 'approved-local', tools: nativeTools }), config()), /restricted to private/);
  assert.match(validateModelRequest(request({ provider: 'ollama', model: 'approved-local', builder_mode: 'vibe_engineer', tools: [nativeTools[0], nativeTools[0]] }), config()), /unique/);
  const c = config();
  c.maxPromptChars = 100;
  assert.equal(validateModelRequest(request({ provider: 'ollama', model: 'approved-local', builder_mode: 'vibe_engineer', tools: nativeTools }), c), 'prompt exceeds configured limit');
});

test('VPS planning times out at the provider, cools down after two failures, and automatically recovers', async t => {
  let clock = Date.now() - 600001;
  t.mock.method(Date, 'now', () => clock);
  const c = createModelGatewayConfig({ OLLAMA_BASE_URL: 'http://planning-cooldown.example', BOB_OLLAMA_MODELS: 'planning-model' });
  c.timeoutMs = 5;
  let calls = 0;
  let aborts = 0;
  let succeed = false;
  const fetchImpl = async (url, init) => {
    if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'planning-model' }] }) };
    calls += 1;
    if (succeed) return { ok: true, json: async () => ({ message: { content: '{}' } }) };
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
      aborts += 1;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true }));
  };
  const input = request({ provider: 'ollama', model: 'planning-model', workload_kind: 'ux_design' });
  for (let i = 0; i < 2; i += 1) {
    const result = await invokeBuilderModel({ input, config: c, fetchImpl });
    assert.equal(result.status, 504);
    assert.equal(result.body.code, 'provider_timeout');
  }
  assert.equal(aborts, 2, 'provider fetch is actually aborted before fallback');
  const cooled = await invokeBuilderModel({ input, config: c, fetchImpl });
  assert.equal(cooled.status, 429);
  assert.equal(cooled.body.code, 'provider_planning_cooldown');
  assert.equal(cooled.body.retry_after_ms, 300000);
  assert.equal(calls, 2);
  succeed = true;
  assert.equal((await invokeBuilderModel({ input: { ...input, workload_kind: 'frontend_implementation' }, config: c, fetchImpl })).status, 200, 'engineering is not blocked by planning cooldown');
  clock += 300001;
  assert.equal((await invokeBuilderModel({ input, config: c, fetchImpl })).status, 200);
  succeed = false;
  assert.equal((await invokeBuilderModel({ input, config: c, fetchImpl })).status, 504);
  succeed = true;
  assert.equal((await invokeBuilderModel({ input, config: c, fetchImpl })).status, 200, 'a successful planning response clears the counter');
  succeed = false;
  assert.equal((await invokeBuilderModel({ input, config: c, fetchImpl })).status, 504);
  assert.equal((await invokeBuilderModel({ input, config: c, fetchImpl })).status, 504);
  assert.equal((await invokeBuilderModel({ input, config: c, fetchImpl })).body.code, 'provider_planning_cooldown');
});

test('model gateway rejects models outside the provider allowlist', () => {
  assert.equal(validateModelRequest(request({ model: 'unapproved' }), config()), 'model is not allowed');
});

test('VPS planning aborts at exactly 120 seconds even when the general gateway budget is longer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = config();
  c.timeoutMs = 600000;
  let started = false;
  let aborted = false;
  const running = invokeBuilderModel({
    input: request({ provider: 'ollama', model: 'approved-local', workload_kind: 'product_analysis' }),
    config: c,
    fetchImpl: async (url, init) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'approved-local' }] }) };
      started = true;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true }));
    }
  });
  await new Promise(setImmediate);
  assert.equal(started, true);
  t.mock.timers.tick(119999);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  assert.equal((await running).status, 504);
  assert.equal(aborted, true);
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

test('caller cancellation aborts generation or response body and releases the local serving guard', async () => {
  for (const phase of ['generation', 'body']) {
    const config = createModelGatewayConfig({
      OLLAMA_BASE_URL: `http://cancel-${phase}.local:11434`,
      BOB_OLLAMA_MODELS: 'cancel-model',
    });
    const input = request({ provider: 'ollama', model: 'cancel-model' });
    const controller = new AbortController();
    let reached;
    const started = new Promise(resolve => { reached = resolve; });
    let aborted = false;
    const fetchImpl = async (url, options) => {
      if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: [{ name: 'cancel-model' }] }) };
      const wait = () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('caller aborted'), { name: 'AbortError' }));
        }, { once: true });
        reached();
      });
      return phase === 'generation' ? wait() : { ok: true, json: wait };
    };
    const running = invokeBuilderModel({ input, config, fetchImpl, signal: controller.signal });
    await started;
    const busy = await invokeBuilderModel({ input, config, fetchImpl });
    assert.equal(busy.body.code, 'provider_busy');
    controller.abort();
    const cancelled = await running;
    assert.equal(aborted, true);
    assert.equal(cancelled.status, 499);
    assert.equal(cancelled.body.code, 'request_cancelled');
    const next = await invokeBuilderModel({
      input, config,
      fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: 'next request works' } }) }),
    });
    assert.equal(next.status, 200, 'fallback can use the provider after cancelled inference unwinds');
  }
});

test('caller cancellation covers health and capability probes without caching cancelled results', async () => {
  for (const phase of ['health-fetch', 'health-body', 'capability-fetch', 'capability-body', 'openai-body']) {
    const c = createModelGatewayConfig({
      OLLAMA_BASE_URL: `http://preflight-${phase}.local:11434`,
      BOB_OLLAMA_MODELS: 'preflight-model',
      OPENAI_BASE_URL: `https://preflight-${phase}.example/v1`,
      OPENAI_API_KEY: 'fixture', BOB_OPENAI_MODELS: 'preflight-model',
    });
    const input = request({
      provider: phase === 'openai-body' ? 'openai' : 'ollama', model: 'preflight-model',
      ...(phase.startsWith('capability') ? {
        builder_mode: 'builder_chat',
        tools: [{ type: 'function', function: { name: 'reply', description: 'Answer', parameters: { type: 'object' } } }],
      } : {}),
    });
    const controller = new AbortController();
    let reached;
    const started = new Promise(resolve => { reached = resolve; });
    let upstreamAborted = false;
    const stalledFetch = async (url, options) => {
      if (phase.startsWith('capability') && url.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'preflight-model' }] }) };
      }
      const wait = () => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          upstreamAborted = true;
          reject(Object.assign(new Error('cancelled preflight'), { name: 'AbortError' }));
        }, { once: true });
        reached();
      });
      return phase.endsWith('fetch') ? wait() : { ok: true, json: wait };
    };
    const running = invokeBuilderModel({ input, config: c, fetchImpl: stalledFetch, signal: controller.signal });
    await started;
    controller.abort();
    assert.equal((await running).body.code, 'request_cancelled', phase);
    assert.equal(upstreamAborted, true, phase);
    const calls = [];
    const recovered = await invokeBuilderModel({
      input, config: c, fetchImpl: async url => {
        calls.push(url);
        return { ok: true, json: async () => url.endsWith('/api/tags')
          ? { models: [{ name: 'preflight-model' }] }
          : url.endsWith('/models') ? { data: [{ id: 'preflight-model' }] }
            : url.endsWith('/api/show') ? { capabilities: [] }
              : { message: { content: 'recovered' }, choices: [{ message: { content: 'recovered' } }] } };
      },
    });
    assert.equal(recovered.status, 200, phase);
    const probePath = phase.startsWith('capability') ? '/api/show' : phase === 'openai-body' ? '/models' : '/api/tags';
    assert.ok(calls.some(url => url.endsWith(probePath)), `${phase}: cancelled probe must not populate cache`);
  }
});

test('an already cancelled caller does not probe or invoke a model', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await invokeBuilderModel({
    input: request({ provider: 'ollama', model: 'approved-local' }), config: config(),
    signal: controller.signal, fetchImpl: () => { throw new Error('must not fetch'); },
  });
  assert.equal(result.body.code, 'request_cancelled');
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
