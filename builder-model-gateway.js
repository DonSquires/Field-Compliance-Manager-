const { planningTimeoutFor } = require('./supabase/functions/_shared/builder-model-adapter');
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
// Ollama Cloud (ollama.com) speaks the Ollama chat API but is an external, keyed service: it is an
// outsourced tier like OpenAI, never a stand-in for Bob's own compute.
const PROVIDER_KINDS = Object.freeze({ openai: 'openai', ollama: 'ollama', gpu_workstation: 'ollama', ollama_cloud: 'ollama_cloud' });
const OLLAMA_API_KINDS = new Set(['ollama', 'ollama_cloud']);
const HEALTH_OK_TTL_MS = 30_000;
const HEALTH_FAIL_TTL_MS = 60_000;
const planningTimeouts = new Map();
const PLANNING_COOLDOWN_MS = 5 * 60_000;
// An exhausted account ("You have no credits remaining", insufficient_quota) does not recover in a
// minute. OpenAI's model list still answers, so health kept calling it ready and every frontend job
// spent its last fallback retrying a 429 (19 failed attempts across 5 jobs, 2026-10).
const QUOTA_COOLDOWN_MS = Math.max(60_000, Number(process.env.BOB_PROVIDER_QUOTA_COOLDOWN_MS || 30 * 60_000));
const QUOTA_EXHAUSTED_PATTERN = /insufficient_quota|no credits|credit balance|exceeded your current quota|billing|usage limit|weekly limit|session limit/i;
// A CPU box evaluating a prompt on every core answers /api/tags late; two seconds called a working
// model "unreachable".
const HEALTH_PROBE_TIMEOUT_MS = Math.max(2_000, Number(process.env.BOB_MODEL_PROBE_TIMEOUT_MS || 10_000));
const CHARS_PER_TOKEN = 3.5;
const healthCache = new Map();
const busyLocalProviders = new Set();

function authHeaders(providerConfig) {
  return providerConfig.apiKey ? { Authorization: `Bearer ${providerConfig.apiKey}` } : {};
}

function parseModelAllowlist(value, fallback) {
  return new Set(String(value || fallback).split(',').map(model => model.trim()).filter(Boolean));
}

function estimateTokens(chars) {
  return Math.ceil(Number(chars || 0) / CHARS_PER_TOKEN);
}

function durationMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value / 1e6 : null;
}

function eligibleLocalModels(providerConfig, probe) {
  if (!providerConfig.modelMemoryBudgetBytes) return [...providerConfig.models];
  return [...providerConfig.models].filter(model => {
    const bytes = probe.model_sizes?.[model] ?? probe.model_sizes?.[`${model}:latest`];
    return Number.isFinite(bytes) && bytes > 0 && bytes <= providerConfig.modelMemoryBudgetBytes;
  });
}

// Prompts that cannot fit a local model's context are the clearest "outsource this" signal.
function promptFitsProvider(input, providerConfig) {
  if (!OLLAMA_API_KINDS.has(providerConfig.kind)) return true;
  const outputBudget = Math.min(Number(input.max_output_tokens) || providerConfig.maxOutputTokens || 8192, providerConfig.maxOutputTokens || 8192, 16384);
  return estimateTokens(promptLength(input)) + outputBudget + 512 <= providerConfig.numCtx;
}

async function probeProvider(config, name, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const providerConfig = config[name];
  if (!providerConfig) return { name, configured: false, healthy: false, installed: [] };
  if (providerConfig.kind === 'openai') {
    if (!providerConfig.apiKey) return { name, configured: false, healthy: false, installed: [] };
    const cached = healthCache.get(name);
    if (cached && cached.until > now()) return { name, configured: true, healthy: cached.healthy, installed: cached.installed, reason: cached.reason || null, cached: true };
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
  if (providerConfig.kind === 'ollama_cloud' && !providerConfig.apiKey) return { name, configured: false, healthy: false, installed: [] };
  const cached = healthCache.get(name);
  if (cached && cached.until > now()) return { name, configured: true, healthy: cached.healthy, installed: cached.installed, model_sizes: cached.model_sizes, reason: cached.reason || null, cached: true };
  let healthy = false;
  let installed = [];
  let modelSizes = {};
  try {
    const response = await fetchImpl(`${providerConfig.baseUrl}/api/tags`, { headers: authHeaders(providerConfig), signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    healthy = response.ok;
    const data = healthy ? await response.json().catch(() => null) : null;
    installed = Array.isArray(data?.models) ? data.models.map(model => String(model.name || model.model || '')).filter(Boolean) : [];
    modelSizes = Object.fromEntries((Array.isArray(data?.models) ? data.models : [])
      .filter(model => typeof model.size === 'number' && Number.isFinite(model.size) && model.size > 0)
      .map(model => [String(model.name || model.model || ''), model.size]));
  } catch {
    healthy = false;
  }
  healthCache.set(name, { healthy, installed, model_sizes: modelSizes, until: now() + (healthy ? HEALTH_OK_TTL_MS : HEALTH_FAIL_TTL_MS) });
  return { name, configured: true, healthy, installed, model_sizes: modelSizes, cached: false };
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
  return Object.fromEntries(probes.map(probe => {
    const provider = config[probe.name];
    const eligible = provider ? eligibleLocalModels(provider, probe) : [];
    return [probe.name, {
      kind: PROVIDER_KINDS[probe.name],
      configured: probe.configured,
      healthy: probe.healthy,
      models: eligible,
      configured_models: [...(provider?.models ?? [])],
      installed: probe.installed,
      ready_model: probe.healthy ? bestAvailableModel(eligible, probe.installed) : null,
      model_memory_budget_bytes: provider?.modelMemoryBudgetBytes ?? null,
      memory_budget_source: provider?.modelMemoryBudgetBytes ? 'configured_vram_minus_headroom' : null,
      excluded_models: [...(provider?.models ?? [])].filter(model => !eligible.includes(model)),
      unavailable_reason: probe.healthy ? null : (probe.reason || null),
      num_ctx: config[probe.name]?.numCtx ?? null,
      max_output_tokens: config[probe.name]?.maxOutputTokens ?? config.maxOutputTokens ?? null
    }];
  }));
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
  const maxOutputTokens = Math.max(1000, Number(env.BOB_BUILDER_MAX_OUTPUT_TOKENS || 8192));
  const vramMb = Number(env.BOB_GPU_VRAM_MB || 8192);
  const headroomMb = Number(env.BOB_GPU_HEADROOM_MB || 2048);
  if (!Number.isFinite(vramMb) || !Number.isFinite(headroomMb) || headroomMb < 1024 || vramMb <= headroomMb) {
    throw new Error('GPU memory configuration must reserve at least 1024 MiB and leave a positive model budget');
  }
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
      maxOutputTokens: Math.min(maxOutputTokens, 8192),
      // CPU inference on the VPS: keep the window modest so the KV cache fits and prompt eval stays bounded.
      numCtx: Math.max(4096, Number(env.BOB_OLLAMA_NUM_CTX) || 16384)
    },
    gpu_workstation: {
      kind: 'ollama',
      baseUrl: (env.GPU_WORKSTATION_URL || '').replace(/\/(v1)?\/*$/, ''),
      // RTX 5050 laptop: 8 GiB VRAM, 16 GiB RAM (owner-approved diagnostic, 2026-10-18).
      // Reserve VRAM for context/display; never select a 9 GB model just because it has more parameters.
      models: parseModelAllowlist(env.BOB_GPU_MODELS, 'qwen2.5-coder:7b,qwen2.5-coder:14b,qwen3:8b'),
      modelMemoryBudgetBytes: (vramMb - headroomMb) * 1024 ** 2,
      maxOutputTokens: Math.min(maxOutputTokens, 8192),
      numCtx: Math.max(4096, Number(env.BOB_GPU_NUM_CTX) || 32768)
    },
    // Ollama Cloud: strong hosted open models, tried after Bob's own compute and before OpenAI.
    // Ordered strongest-first. /api/tags lists every cloud model, including ones the plan does not
    // include (those fail at request time), so the default names only free-plan models (probed
    // 2026-10-18); add paid models through BOB_OLLAMA_CLOUD_MODELS once the plan covers them.
    ollama_cloud: {
      kind: 'ollama_cloud',
      apiKey: env.OLLAMA_API_KEY || env.OLLAMA_API_TOKEN || '',
      baseUrl: (env.OLLAMA_CLOUD_BASE_URL || 'https://ollama.com').replace(/\/+$/, ''),
      models: parseModelAllowlist(env.BOB_OLLAMA_CLOUD_MODELS, 'gpt-oss:120b,nemotron-3-super,gemma4:31b,gpt-oss:20b'),
      maxOutputTokens: Math.min(maxOutputTokens, 16384),
      numCtx: Math.max(8192, Number(env.BOB_OLLAMA_CLOUD_NUM_CTX) || 131072)
    },
    // The agentic lane is not bound by an edge timeout: give reasoning models
    // maximum effort, room to write, and long turns.
    reasoningEffort: REASONING_EFFORTS.has(env.BOB_BUILDER_REASONING_EFFORT) ? env.BOB_BUILDER_REASONING_EFFORT : 'high',
    maxOutputTokens,
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
    if (input.output_schema) body.format = providerConfig.kind === 'ollama' && input.output_schema.properties ? input.output_schema : 'json';
    // Ollama defaults to a 4k window and would truncate Bob's prompts silently; keep the model warm between turns.
    body.options = { num_ctx: providerConfig.numCtx, temperature: typeof input.temperature === 'number' ? input.temperature : 0.2, num_predict: Math.min(Number(input.max_output_tokens) || providerConfig.maxOutputTokens || 8192, providerConfig.maxOutputTokens || 8192, 16384) };
    if (providerConfig.kind === 'ollama') body.keep_alive = '5m';
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
  if (providerConfig.kind === 'ollama_cloud' && !providerConfig.apiKey) {
    return { status: 503, body: { error: 'Ollama Cloud provider is not configured', code: 'provider_unconfigured' } };
  }
  if (providerConfig.kind === 'ollama' && !providerConfig.baseUrl) {
    return { status: 503, body: { error: `${input.provider} provider is not configured`, code: 'provider_unconfigured' } };
  }
  if (!promptFitsProvider(input, providerConfig)) {
    return { status: 413, body: { error: `prompt exceeds the ${input.provider} context window (${providerConfig.numCtx} tokens)`, code: 'context_exceeded' } };
  }
  const probe = await probeProvider(config, input.provider, { fetchImpl });
  if (probe.reason === 'quota_exhausted') return { status: 429, body: { error: `${input.provider} account has no remaining quota or credits; skipped until it is topped up`, code: 'provider_quota' } };
  if (OLLAMA_API_KINDS.has(providerConfig.kind) && !probe.healthy) return { status: 503, body: { error: `${input.provider} provider is unreachable`, code: 'provider_unavailable' } };
  const eligible = eligibleLocalModels(providerConfig, probe);
  const model = input.model ? resolveProviderModel(config, input.provider, input.model, probe.installed ?? null)
    : bestAvailableModel(eligible, probe.installed ?? null);
  if (!model) return { status: 503, body: { error: `${input.provider} has none of the allowed models installed`, code: 'model_unavailable' } };
  if (!eligible.includes(model)) {
    return { status: 422, body: { error: `${input.provider} model exceeds the configured VRAM weight budget or its size is unknown; over-budget model selection is blocked`, code: 'model_memory_budget' } };
  }
  const local = providerConfig.kind === 'ollama';
  const planningTimeout = planningTimeoutFor(input);
  const planningKey = JSON.stringify([providerConfig.baseUrl, model]);
  for (const [key, entry] of planningTimeouts) {
    if (Date.now() - entry.at >= PLANNING_COOLDOWN_MS) planningTimeouts.delete(key);
  }
  const previousTimeouts = planningTimeout ? planningTimeouts.get(planningKey) : null;
  if (previousTimeouts && Date.now() - previousTimeouts.at < PLANNING_COOLDOWN_MS && previousTimeouts.count >= 2) {
    return { status: 429, body: { error: 'VPS structured planning is cooling down after two timeouts; continue the allowed fallback chain', code: 'provider_planning_cooldown', retry_after_ms: PLANNING_COOLDOWN_MS - (Date.now() - previousTimeouts.at) } };
  }
  if (local && busyLocalProviders.has(input.provider)) return { status: 429, body: { error: `${input.provider} is already serving a request; no parallel local model was loaded`, code: 'provider_busy' } };
  if (local) busyLocalProviders.add(input.provider);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutMs, planningTimeout || Infinity));
  try {
    const isOpenAI = input.provider === 'openai';
    const response = await fetchImpl(
      isOpenAI ? `${providerConfig.baseUrl}/chat/completions` : `${providerConfig.baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(providerConfig)
        },
        body: JSON.stringify(buildProviderBody({ input, config, model })),
        signal: controller.signal
      }
    );
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const detail = data?.error?.message ? `: ${String(data.error.message).slice(0, 200)}` : (typeof data?.error === 'string' ? `: ${data.error.slice(0, 200)}` : '');
      const quota = response.status === 429 && QUOTA_EXHAUSTED_PATTERN.test(`${detail} ${data?.error?.code || ''} ${data?.error?.type || ''}`);
      if (quota) healthCache.set(input.provider, { healthy: false, installed: [], reason: 'quota_exhausted', until: Date.now() + QUOTA_COOLDOWN_MS });
      else if (OLLAMA_API_KINDS.has(providerConfig.kind) && (response.status >= 500 || response.status === 429)) healthCache.set(input.provider, { healthy: false, installed: [], until: Date.now() + HEALTH_FAIL_TTL_MS });
      // 429 is passed through so callers escalate at once instead of retrying a provider that cannot answer.
      if (response.status === 429) return { status: 429, body: { error: `${input.provider} provider request failed${detail}`, code: quota ? 'provider_quota' : 'provider_rate_limited' } };
      return { status: 502, body: { error: `${input.provider} provider request failed${detail}`, code: 'provider_error' } };
    }

    const content = isOpenAI ? data.choices?.[0]?.message?.content : data.message?.content;
    if (typeof content !== 'string') {
      return { status: 502, body: { error: `${input.provider} provider returned no content` } };
    }
    if (planningTimeout) planningTimeouts.delete(planningKey);

    return {
      status: 200,
      body: {
        provider: input.provider,
        model,
        content,
        finish_reason: isOpenAI ? (data.choices?.[0]?.finish_reason ?? null) : (data.done_reason ?? null),
        usage: isOpenAI
          ? (data.usage || {})
          : {
            input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0,
            inference: {
              load_ms: durationMs(data.load_duration),
              prompt_ms: durationMs(data.prompt_eval_duration),
              generation_ms: durationMs(data.eval_duration),
              output_tokens_per_second: data.eval_duration > 0 ? (data.eval_count || 0) * 1e9 / data.eval_duration : null,
            }
          }
      }
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    if (timedOut && planningTimeout) {
      const previous = planningTimeouts.get(planningKey);
      planningTimeouts.set(planningKey, { count: (previous?.count || 0) + 1, at: Date.now() });
    }
    if (!timedOut && OLLAMA_API_KINDS.has(providerConfig.kind)) healthCache.set(input.provider, { healthy: false, installed: [], until: Date.now() + HEALTH_FAIL_TTL_MS });
    return {
      status: timedOut ? 504 : 502,
      body: { error: timedOut ? 'model provider timed out' : 'model provider unavailable', code: timedOut ? 'provider_timeout' : 'provider_unavailable' }
    };
  } finally {
    clearTimeout(timer);
    if (local) busyLocalProviders.delete(input.provider);
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