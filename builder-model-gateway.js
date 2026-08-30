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

function createModelGatewayConfig(env = process.env) {
  return {
    openai: {
      apiKey: env.OPENAI_API_KEY || '',
      baseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
      models: parseModelAllowlist(env.BOB_OPENAI_MODELS, 'gpt-4o-mini')
    },
    ollama: {
      baseUrl: (env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
      models: parseModelAllowlist(env.BOB_OLLAMA_MODELS, 'qwen2.5:7b')
    },
    timeoutMs: Math.min(Number(env.BOB_MODEL_TIMEOUT_MS || 90000), 145000),
    maxPromptChars: Number(env.BOB_MODEL_MAX_PROMPT_CHARS || DEFAULT_MAX_PROMPT_CHARS)
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
        body: JSON.stringify({
          model,
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
      return { status: 502, body: { error: `${input.provider} provider request failed` } };
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
  createModelGatewayConfig,
  validateModelRequest,
  invokeBuilderModel
};