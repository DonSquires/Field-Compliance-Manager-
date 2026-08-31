const DEFAULT_MAX_PROMPT_CHARS = 100000;
const ALLOWED_BUILDER_MODES = new Set([
  'product_analyst',
  'ux_designer',
  'frontend_engineer',
  'backend_engineer',
  'qa_security_reviewer',
  'code_reviewer',
  'release_engineer'
]);

function parseModelAllowlist(value, fallback) {
  return new Set(String(value || fallback).split(',').map(model => model.trim()).filter(Boolean));
}

function normalizeBaseUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, '');
}

function createModelGatewayConfig(env = process.env) {
  return {
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      baseUrl: normalizeBaseUrl(env.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
      models: parseModelAllowlist(env.BOB_OPENAI_MODELS, 'gpt-4o-mini')
    },
    ollama: {
      baseUrl: normalizeBaseUrl(env.BOB_OLLAMA_BASE_URL || env.OLLAMA_BASE_URL || env.OLLAMA_URL, 'http://127.0.0.1:11434'),
      apiKey: env.BOB_OLLAMA_AUTH_TOKEN || env.OLLAMA_AUTH_TOKEN || env.OLLAMA_API_KEY || '',
      models: parseModelAllowlist(env.BOB_OLLAMA_MODELS, 'qwen2.5:7b')
    },
    timeoutMs: Math.min(Number(env.BOB_MODEL_TIMEOUT_MS || 90000), 145000),
    maxPromptChars: Number(env.BOB_MODEL_MAX_PROMPT_CHARS || DEFAULT_MAX_PROMPT_CHARS)
  };
}

function modelGatewayReadiness(config) {
  return {
    openai_configured: Boolean(config.openai.apiKey && config.openai.models.size),
    ollama_configured: Boolean(config.ollama.baseUrl && config.ollama.models.size),
    ollama_auth_configured: Boolean(config.ollama.apiKey),
    local_builder_provider: 'ollama'
  };
}

function validateModelRequest(input, config) {
  if (!input || typeof input !== 'object') return 'request body is required';
  if (!['openai', 'ollama'].includes(input.provider)) return 'unsupported model provider';
  if (!ALLOWED_BUILDER_MODES.has(input.builder_mode)) return 'unsupported builder mode';
  if (!input.prompt_version || typeof input.prompt_version !== 'string') return 'prompt_version is required';
  if (!input.idempotency_key || typeof input.idempotency_key !== 'string') return 'idempotency_key is required';
  if (!input.system_prompt || !input.user_prompt) return 'system_prompt and user_prompt are required';
  if (typeof input.system_prompt !== 'string' || typeof input.user_prompt !== 'string') return 'prompts must be strings';
  if (input.system_prompt.length + input.user_prompt.length > config.maxPromptChars) return 'prompt exceeds configured limit';
  if (input.model && !config[input.provider].models.has(input.model)) return 'model is not allowed';
  return null;
}

async function invokeBuilderModel({ input, config, fetchImpl = globalThis.fetch }) {
  const validationError = validateModelRequest(input, config);
  if (validationError) return { status: 400, body: { error: validationError } };

  const providerOrder = input.provider === 'openai' && config.ollama?.models?.size
    ? ['openai', 'ollama']
    : [input.provider];

  let lastResult = null;
  for (const provider of providerOrder) {
    const providerConfig = config[provider];
    const fallbackModel = input.model && providerConfig.models.has(input.model)
      ? input.model
      : [...providerConfig.models][0];

    if (!providerConfig || !providerConfig.models?.size) {
      lastResult = { status: 503, body: { error: `${provider} provider is not configured` } };
      continue;
    }

    if (provider === 'openai' && !providerConfig.apiKey) {
      lastResult = { status: 503, body: { error: 'OpenAI provider is not configured' } };
      continue;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const isOpenAI = provider === 'openai';
      const response = await fetchImpl(
        isOpenAI ? `${providerConfig.baseUrl}/chat/completions` : `${providerConfig.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...((isOpenAI || providerConfig.apiKey) ? { Authorization: `Bearer ${providerConfig.apiKey}` } : {})
          },
          body: JSON.stringify({
            model: fallbackModel,
            messages: [
              { role: 'system', content: input.system_prompt },
              { role: 'user', content: input.user_prompt }
            ],
            ...(isOpenAI ? {} : { stream: false })
          }),
          signal: controller.signal
        }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        lastResult = { status: 502, body: { error: `${provider} provider request failed` } };
        continue;
      }

      const content = isOpenAI ? data.choices?.[0]?.message?.content : data.message?.content;
      if (typeof content !== 'string') {
        lastResult = { status: 502, body: { error: `${provider} provider returned no content` } };
        continue;
      }

      return {
        status: 200,
        body: {
          provider,
          model: fallbackModel,
          content,
          usage: isOpenAI
            ? (data.usage || {})
            : { input_tokens: data.prompt_eval_count || 0, output_tokens: data.eval_count || 0 }
        }
      };
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      lastResult = {
        status: timedOut ? 504 : 502,
        body: { error: timedOut ? 'model provider timed out' : 'model provider unavailable' }
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return lastResult || { status: 502, body: { error: 'model provider unavailable' } };
}

module.exports = {
  ALLOWED_BUILDER_MODES,
  createModelGatewayConfig,
  modelGatewayReadiness,
  validateModelRequest,
  invokeBuilderModel
};