const DEFAULT_MAX_PROMPT_CHARS = 1_200_000; // ~300k tokens: room for a real working set, the way a coding agent holds one
const ALLOWED_BUILDER_MODES = new Set([
  'product_analyst',
  'ux_designer',
  'frontend_engineer',
  'backend_engineer',
  'qa_security_reviewer',
  'code_reviewer',
  'release_engineer'
]);
// 'xhigh' is the highest value the Chat Completions API accepts for current reasoning models
// (probed 2026-09-26 against gpt-5.4 … gpt-6-*; 'max' is rejected).
const REASONING_EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
// In-house first: the laptop GPU and the VPS Ollama are Bob's own compute; OpenAI is the
// outsourced fallback for when Bob is stuck or the prompt does not fit a local context window.
const PROVIDER_KINDS = Object.freeze({ openai: 'openai', ollama: 'ollama', gpu_workstation: 'ollama' });
const HEALTH_OK_TTL_MS = 30_000;
const HEALTH_FAIL_TTL_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const CHARS_PER_TOKEN = 3.5;
const healthCache = new Map();

function parseModelAllowlist(value, fallback) {
  return new Set(String(value || fallback).split(',').map(model => model.trim()).filter(Boolean));
}

function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / CHARS_PER_TOKEN);
}

// Prompts that cannot fit a local model's context are the clearest "outsource this" signal.
function promptFitsProvider(input, providerConfig) {
  if (providerConfig.kind !== 'ollama') return true;
  return estimateTokens(promptLength(input)) <= Math.floor(providerConfig.numCtx * 0.85);
}

async function probeProvider(config, name, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const providerConfig = config[name];
  if (!providerConfig) return { name, configured: false, healthy: false, installed: [] };
  if (providerConfig.kind === 'openai') {
    if (!providerConfig.apiKey) return { name, configured: false, healthy: false, installed: [] };
    const cached = healthCache.get(name);
    if (cached && cached.until > now()) return { name, configured: true, healthy: cached.healthy, installed: cached.installed, cached: true };
    // The account's model list decides which allowlisted model is real today; unreachable = assume the allowlist.
    let installed = [];
    try {
      const response = await fetchImpl(`${providerConfig.baseUrl}/models`, { headers: { Authorization: `Bearer ${providerConfig.apiKey}` }, signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS * 3) });
      const data = response.ok ? await response.json().catch(() => null) : null;
      installed = Array.isArray(data?.data) ? data.data.map(model => String(model.id || '')).filter(Boolean) : [];
    } catch { installed = []; }
    healthCache.set(name, { healthy: true, installed, until: now() + (installed.length ? 10 * 60_000 : HEALTH_FAIL_TTL_MS) });
    return { name, configured: true, healthy: true, installed, cached: false };
  }
  if (!providerConfig.baseUrl) return { name, configured: false, healthy: false, installed: [] };
  const cached = healthCache.get(name);
  if (cached && cached.until > now()) return { name, configured: true, healthy: cached.healthy, installed: cached.installed, cached: true };
  let healthy = false;
  let installed = [];
  try {
    const response = await fetchImpl(`${providerConfig.baseUrl}/api/tags`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    healthy = response.ok;
    const data = healthy ? await response.json().catch(() => null) : null;
    installed = Array.isArray(data?.models) ? data.models.map(model => String(model.name || model.model || '')).filter(Boolean) : [];
  } catch {
    healthy = false;
  }
  healthCache.set(name, { healthy, installed, until: now() + (healthy ? HEALTH_OK_TTL_MS : HEALTH_FAIL_TTL_MS) });
  return { name, configured: true, healthy, installed, cached: false };
}

// The model a provider would actually serve for a request: the requested model when allowed and
// installed, else the first allowlisted model that is installed (local) or allowlisted (OpenAI).
// A requested local model that is allowlisted but not installed resolves to nothing rather than to a
// substitute: the adapter asks for a specific model when it must differ from the author's.
function resolveProviderModel(config, name, requestedModel, installed = null) {
  const providerConfig = config[name];
  if (!providerConfig) return null;
  const available = model => !Array.isArray(installed) || installed.length === 0 || installed.includes(model) || installed.includes(`${model}:latest`);
  if (requestedModel && providerConfig.models.has(requestedModel)) return available(requestedModel) ? requestedModel : null;
  return bestAvailableModel(providerConfig.models, installed);
}

async function modelHealth(config, options = {}) {
  const names = Object.keys(PROVIDER_KINDS);
  const probes = await Promise.all(names.map(name => probeProvider(config, name, options)));
  return Object.fromEntries(probes.map(probe => [probe.name, {
    kind: PROVIDER_KINDS[probe.name],
    configured: probe.configured,
    healthy: probe.healthy,
    models: [...(config[probe.name]?.models ?? [])],
    installed: probe.installed,
    ready_model: probe.healthy ? resolveProviderModel(config, probe.name, null, probe.installed) : null,
    num_ctx: config[probe.name]?.numCtx ?? null
  }]));
}

function isReasoningModel(model) {
  return /^(gpt-[5-9]|o[0-9])/i.test(String(model || ''));
}

// Deterministic "best available": the allowlist is ordered strongest-first and the provider serves
// the first entry it actually has (installed locally / listed by the OpenAI account).
function bestAvailableModel(allowlist, installed = null) {
  const available = model => !Array.isArray(installed) || installed.length === 0 || installed.includes(model) || installed.includes(`${model}:latest`);
  return [...allowlist].find(available) || null;
}

// Independent AI review must come from a model other than the author's. Autonomous jobs
// (opened by Bob) supply no reviewer, so pick one: BOB_BUILDER_REVIEWER_MODEL, else the first
// allowlisted (and available) model that is not the author model; null when none is distinct.
function defaultReviewerModel(env = process.env, installed = null) {
  const allowlist = [...parseModelAllowlist(env.BOB_OPENAI_MODELS, 'gpt-5.4,gpt-5.4-mini,gpt-4o-mini')];
  const author = String(env.BOB_BUILDER_MODEL || bestAvailableModel(allowlist, installed) || allowlist[0] || '').trim();
  const explicit = String(env.BOB_BUILDER_REVIEWER_MODEL || '').trim();
  if (explicit && explicit !== author) return explicit;
  return bestAvailableModel(allowlist.filter(model => model !== author), installed);
}

function defaultAuthorModel(env = process.env, installed = null) {
  const explicit = String(env.BOB_BUILDER_MODEL || '').trim();
  if (explicit) return explicit;
  return bestAvailableModel([...parseModelAllowlist(env.BOB_OPENAI_MODELS, 'gpt-5.4,gpt-5.4-mini,gpt-4o-mini')], installed) || 'gpt-5.4';
}

function createModelGatewayConfig(env = process.env) {
  return {
    openai: {
      kind: 'openai',
      apiKey: env.OPENAI_API_KEY || '',
      baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      // Bob Builder authors at full strength by default; the allowlist still bounds what a request may ask for.
      models: parseModelAllowlist(env.BOB_OPENAI_MODELS, 'gpt-5.4,gpt-5.4-mini,gpt-4o-mini')
    },
    ollama: {
      kind: 'ollama',
      baseUrl: (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      models: parseModelAllowlist(env.BOB_OLLAMA_MODELS, 'qwen2.5-coder:7b'),
      // CPU inference on the VPS: keep the window modest so the KV cache fits and prompt eval stays bounded.
      numCtx: Math.max(4096, Number(env.BOB_OLLAMA_NUM_CTX) || 16384)
    },
    gpu_workstation: {
      kind: 'ollama',
      baseUrl: (env.GPU_WORKSTATION_URL || '').replace(/\/(v1)?\/*$/, ''),
      models: parseModelAllowlist(env.BOB_GPU_MODELS, 'qwen2.5-coder:7b'),
      numCtx: Math.max(4096, Number(env.BOB_GPU_NUM_CTX) || 32768)
    },
    // The agentic lane is not bound by an edge timeout: give reasoning models
    // maximum effort, room to write, and long turns.
    reasoningEffort: REASONING_EFFORTS.has(env.BOB_BUILDER_REASONING_EFFORT) ? env.BOB_BUILDER_REASONING_EFFORT : 'high',
    maxOutputTokens: Math.max(1000, Number(env.BOB_BUILDER_MAX_OUTPUT_TOKENS || 32000)),
    // CPU prompt evaluation on the VPS MoE reviewer can take many minutes on a first, uncached turn.
    timeoutMs: Math.min(Number(env.BOB_MODEL_TIMEOUT_MS || 600000), 1800000),
    maxPromptChars: Number(env.BOB_MODEL_MAX_PROMPT_CHARS || DEFAULT_MAX_PROMPT_CHARS)
  };
}

function promptLength(input) {
  if (Array.isArray(input.messages)) return input.messages.reduce((sum, message) => sum + String(message?.content ?? '').length, 0);
  return String(input.system_prompt || '').length + String(input.user_prompt || '').length;
}

function validateModelRequest(input, config) {
  if (!input || typeof input !== 'object') return 'request body is required';
  if (!PROVIDER_KINDS[input.provider]) return 'unsupported model provider';
  if (!ALLOWED_BUILDER_MODES.has(input.builder_mode)) return 'unsupported builder mode';
  if (!input.prompt_version || typeof input.prompt_version !== 'string') return 'prompt_version is required';
  if (!input.idempotency_key || typeof input.idempotency_key !== 'string') return 'idempotency_key is required';
  if (Array.isArray(input.messages)) {
    // Multi-turn (agentic) requests carry the conversation; every turn must be a typed, string message.
    if (!input.messages.length) return 'messages must not be empty';
    if (input.messages.some(message => !message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string')) return 'messages must be role/content pairs';
  } else {
    if (!input.system_prompt || !input.user_prompt) return 'system_prompt and user_prompt are required';
    if (typeof input.system_prompt !== 'string' || typeof input.user_prompt !== 'string') return 'prompts must be strings';
  }
  if (promptLength(input) > config.maxPromptChars) return 'prompt exceeds configured limit';
  if (input.model && !config[input.provider].models.has(input.model)) return 'model is not allowed';
  if (input.reasoning_effort && !REASONING_EFFORTS.has(input.reasoning_effort)) return 'unsupported reasoning effort';
  return null;
}

function buildProviderBody({ input, config, model }) {
  const isOpenAI = input.provider === 'openai';
  const messages = Array.isArray(input.messages)
    ? input.messages
    : [{ role: 'system', content: input.system_prompt }, { role: 'user', content: input.user_prompt }];
  const body = { model, messages };
  if (!isOpenAI) {
    const providerConfig = config[input.provider];
    body.stream = false;
    if (input.output_schema) body.format = 'json';
    // Ollama defaults to a 4k window and would truncate Bob's prompts silently; keep the model warm between turns.
    body.options = { num_ctx: providerConfig.numCtx, temperature: typeof input.temperature === 'number' ? input.temperature : 0.2, num_predict: Math.min(Number(input.max_output_tokens) || 8192, 16384) };
    body.keep_alive = '30m';
    return body;
  }
  if (input.output_schema) body.response_format = { type: 'json_object' };
  if (isReasoningModel(model)) {
    body.reasoning_effort = input.reasoning_effort || config.reasoningEffort;
    body.max_completion_tokens = Math.min(Number(input.max_output_tokens) || config.maxOutputTokens, config.maxOutputTokens);
  } else {
    body.max_tokens = Math.min(Number(input.max_output_tokens) || 16000, 16000);
    body.temperature = typeof input.temperature === 'number' ? input.temperature : 0.2;
  }
  return body;
}

async function invokeBuilderModel({ input, config, fetchImpl = globalThis.fetch }) {
  const validationError = validateModelRequest(input, config);
  if (validationError) return { status: 400, body: { error: validationError } };

  const providerConfig = config[input.provider];
  if (input.provider === 'openai' && !providerConfig.apiKey) {
    return { status: 503, body: { error: 'OpenAI provider is not configured', code: 'provider_unconfigured' } };
  }
  if (providerConfig.kind === 'ollama' && !providerConfig.baseUrl) {
    return { status: 503, body: { error: `${input.provider} provider is not configured`, code: 'provider_unconfigured' } };
  }
  if (!promptFitsProvider(input, providerConfig)) {
    return { status: 413, body: { error: `prompt exceeds the ${input.provider} context window (${providerConfig.numCtx} tokens)`, code: 'context_exceeded' } };
  }
  const probe = await probeProvider(config, input.provider, { fetchImpl });
  if (providerConfig.kind === 'ollama' && !probe.healthy) return { status: 503, body: { error: `${input.provider} provider is unreachable`, code: 'provider_unavailable' } };
  const model = resolveProviderModel(config, input.provider, input.model, probe.installed ?? null);
  if (!model) return { status: 503, body: { error: `${input.provider} has none of the allowed models installed`, code: 'model_unavailable' } };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const isOpenAI = input.provider === 'openai';
    const response = await fetchImpl(
      isOpenAI ? `${providerConfig.baseUrl}/chat/completions` : `${providerConfig.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isOpenAI ? { Authorization: `Bearer ${providerConfig.apiKey}` } : {})
        },
        body: JSON.stringify(buildProviderBody({ input, config, model })),
        signal: controller.signal
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const detail = data?.error?.message ? `: ${String(data.error.message).slice(0, 200)}` : (typeof data?.error === 'string' ? `: ${data.error.slice(0, 200)}` : '');
      if (providerConfig.kind === 'ollama' && (response.status >= 500 || response.status === 429)) healthCache.set(input.provider, { healthy: false, installed: [], until: Date.now() + HEALTH_FAIL_TTL_MS });
      return { status: 502, body: { error: `${input.provider} provider request failed${detail}`, code: 'provider_error' } };
    }

    const content = isOpenAI ? data.choices?.[0]?.message?.content : data.message?.content;
    if (typeof content !== 'string') {
      return { status: 502, body: { error: `${input.provider} provider returned no content` } };
    }

    return {
      status: 200,
      body: {
        provider: input.provider,
        model,
        content,
        finish_reason: isOpenAI ? (data.choices?.[0]?.finish_reason ?? null) : (data.done_reason ?? null),
        usage: isOpenAI
          ? (data.usage || {})
          : { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 }
      }
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    if (!timedOut && providerConfig.kind === 'ollama') healthCache.set(input.provider, { healthy: false, installed: [], until: Date.now() + HEALTH_FAIL_TTL_MS });
    return {
      status: timedOut ? 504 : 502,
      body: { error: timedOut ? 'model provider timed out' : 'model provider unavailable', code: timedOut ? 'provider_timeout' : 'provider_unavailable' }
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ALLOWED_BUILDER_MODES,
  PROVIDER_KINDS,
  REASONING_EFFORTS,
  bestAvailableModel,
  defaultAuthorModel,
  estimateTokens,
  modelHealth,
  probeProvider,
  promptFitsProvider,
  resolveProviderModel,
  buildProviderBody,
  createModelGatewayConfig,
  defaultReviewerModel,
  isReasoningModel,
  validateModelRequest,
  invokeBuilderModel
};