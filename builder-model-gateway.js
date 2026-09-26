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
const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

function parseModelAllowlist(value, fallback) {
  return new Set(String(value || fallback).split(',').map(model => model.trim()).filter(Boolean));
}

function isReasoningModel(model) {
  return /^(gpt-5|o[0-9])/i.test(String(model || ''));
}

// Independent AI review must come from a model other than the author's. Autonomous jobs
// (opened by Bob) supply no reviewer, so pick one: BOB_BUILDER_REVIEWER_MODEL, else the first
// allowlisted model that is not the author model; null when no distinct model is configured.
function defaultReviewerModel(env = process.env) {
  const author = String(env.BOB_BUILDER_MODEL || 'gpt-5.4').trim();
  const explicit = String(env.BOB_BUILDER_REVIEWER_MODEL || '').trim();
  if (explicit && explicit !== author) return explicit;
  return [...parseModelAllowlist(env.BOB_OPENAI_MODELS, 'gpt-5.4,gpt-5.4-mini,gpt-4o-mini')].find(model => model !== author) || null;
}

function createModelGatewayConfig(env = process.env) {
  return {
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      // Bob Builder authors at full strength by default; the allowlist still bounds what a request may ask for.
      models: parseModelAllowlist(env.BOB_OPENAI_MODELS, 'gpt-5.4,gpt-5.4-mini,gpt-4o-mini')
    },
    ollama: {
      baseUrl: (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      models: parseModelAllowlist(env.BOB_OLLAMA_MODELS, 'qwen2.5:7b')
    },
    // The agentic lane is not bound by an edge timeout: give reasoning models
    // maximum effort, room to write, and long turns.
    reasoningEffort: REASONING_EFFORTS.has(env.BOB_BUILDER_REASONING_EFFORT) ? env.BOB_BUILDER_REASONING_EFFORT : 'high',
    maxOutputTokens: Math.max(1000, Number(env.BOB_BUILDER_MAX_OUTPUT_TOKENS || 32000)),
    timeoutMs: Math.min(Number(env.BOB_MODEL_TIMEOUT_MS || 600000), 900000),
    maxPromptChars: Number(env.BOB_MODEL_MAX_PROMPT_CHARS || DEFAULT_MAX_PROMPT_CHARS)
  };
}

function promptLength(input) {
  if (Array.isArray(input.messages)) return input.messages.reduce((sum, message) => sum + String(message?.content ?? '').length, 0);
  return String(input.system_prompt || '').length + String(input.user_prompt || '').length;
}

function validateModelRequest(input, config) {
  if (!input || typeof input !== 'object') return 'request body is required';
  if (!['openai', 'ollama'].includes(input.provider)) return 'unsupported model provider';
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
    body.stream = false;
    if (input.output_schema) body.format = 'json';
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
  const model = input.model || [...providerConfig.models][0];
  if (input.provider === 'openai' && !providerConfig.apiKey) {
    return { status: 503, body: { error: 'OpenAI provider is not configured' } };
  }

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
      const detail = data?.error?.message ? `: ${String(data.error.message).slice(0, 200)}` : '';
      return { status: 502, body: { error: `${input.provider} provider request failed${detail}` } };
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
    return {
      status: timedOut ? 504 : 502,
      body: { error: timedOut ? 'model provider timed out' : 'model provider unavailable' }
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  ALLOWED_BUILDER_MODES,
  REASONING_EFFORTS,
  buildProviderBody,
  createModelGatewayConfig,
  defaultReviewerModel,
  isReasoningModel,
  validateModelRequest,
  invokeBuilderModel
};