'use strict';

/**
 * Bob model gateway — routes each reasoning ROLE (planner, verifier, subagent,
 * synthesis) through an ordered chain of OpenAI-compatible providers:
 *
 *   gpu_workstation  the owner's laptop GPU (Ollama over the reverse SSH link)
 *   vps_ollama       the VPS Ollama container (CPU; embeddings + optional chat)
 *   openai           OpenAI (default author for the planner)
 *
 * A provider that is unconfigured, unhealthy, or fails mid-call is skipped and
 * the next one in the chain is tried, so Bob keeps working when the laptop is
 * off. Health probes are cached briefly to keep turn latency bounded.
 */

const DEFAULT_TIMEOUT_MS = 120000;
const HEALTH_OK_TTL_MS = 30000;
const HEALTH_FAIL_TTL_MS = 60000;
const QUOTA_FAIL_TTL_MS = 10 * 60000;
// A laptop pulling or loading a model answers /models late; a short probe called it unreachable (2026-09-27).
const HEALTH_PROBE_TIMEOUT_MS = Math.max(1500, Number(process.env.BOB_MODEL_PROBE_TIMEOUT_MS || 8000));

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

// Ollama's OpenAI-compatible API lives under /v1; the control plane shares the same variable without it.
function ollamaOpenAiBase(value) {
  const base = trimSlash(value);
  if (!base) return '';
  return /\/v1$/.test(base) ? base : `${base}/v1`;
}

function parseChain(raw, fallback) {
  const list = String(raw || '').split(',').map((item) => item.trim()).filter(Boolean);
  return list.length ? list : fallback;
}

function isReasoningModel(model, override) {
  if (override === 'true') return true;
  if (override === 'false') return false;
  return /^(gpt-[5-9]|o[0-9])/i.test(String(model || ''));
}

function createGatewayConfig(env = process.env) {
  const openaiModel = env.OPENAI_MODEL || 'gpt-4o-mini';
  const providers = {
    openai: {
      kind: 'openai',
      baseUrl: trimSlash(env.OPENAI_BASE_URL || 'https://api.openai.com/v1'),
      apiKey: env.OPENAI_API_KEY || '',
      models: {
        planner: env.OPENAI_PLAN_MODEL || openaiModel,
        verifier: env.OPENAI_VERIFY_MODEL || openaiModel,
        subagent: env.OPENAI_SUBAGENT_MODEL || openaiModel,
        synthesis: env.OPENAI_PLAN_MODEL || openaiModel,
      },
      reasoningEffort: {
        planner: env.OPENAI_PLAN_REASONING_EFFORT || 'medium',
        verifier: env.OPENAI_VERIFY_REASONING_EFFORT || 'low',
        subagent: env.OPENAI_SUBAGENT_REASONING_EFFORT || 'low',
        synthesis: env.OPENAI_PLAN_REASONING_EFFORT || 'medium',
      },
      reasoningOverride: env.OPENAI_PLAN_IS_REASONING,
    },
    gpu_workstation: {
      kind: 'ollama',
      baseUrl: ollamaOpenAiBase(env.GPU_WORKSTATION_URL),
      apiKey: env.GPU_WORKSTATION_API_KEY || 'ollama',
      models: {
        planner: env.GPU_WORKSTATION_PLAN_MODEL || env.GPU_WORKSTATION_MODEL || '',
        verifier: env.GPU_WORKSTATION_MODEL || '',
        subagent: env.GPU_WORKSTATION_MODEL || '',
        synthesis: env.GPU_WORKSTATION_PLAN_MODEL || env.GPU_WORKSTATION_MODEL || '',
      },
    },
    vps_ollama: {
      kind: 'ollama',
      baseUrl: ollamaOpenAiBase(env.OLLAMA_URL),
      apiKey: 'ollama',
      models: {
        planner: env.BOB_OLLAMA_PLAN_MODEL || '',
        verifier: env.BOB_OLLAMA_CHAT_MODEL || '',
        subagent: env.BOB_OLLAMA_CHAT_MODEL || '',
        synthesis: env.BOB_OLLAMA_PLAN_MODEL || '',
      },
    },
    // Anthropic Claude via its OpenAI-compatible endpoint (owner direction 2026-11-10).
    anthropic: {
      kind: 'openai',
      baseUrl: trimSlash(env.ANTHROPIC_OPENAI_BASE_URL || 'https://api.anthropic.com/v1'),
      apiKey: env.ANTHROPIC_API_KEY || '',
      models: {
        planner: env.ANTHROPIC_PLAN_MODEL || env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        verifier: env.ANTHROPIC_VERIFY_MODEL || env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
        subagent: env.ANTHROPIC_SUBAGENT_MODEL || env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
        synthesis: env.ANTHROPIC_PLAN_MODEL || env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      },
    },
    // OmniRoute: owner-run OpenAI-compatible gateway; inert until OMNIROUTE_BASE_URL is set, then
    // used when a BOB_ROUTE_* chain names it or the auto router ranks it. A self-hosted instance may run without a key.
    omniroute: {
      kind: 'gateway',
      baseUrl: trimSlash(env.OMNIROUTE_BASE_URL),
      apiKey: env.OMNIROUTE_API_KEY || 'none',
      models: {
        planner: env.OMNIROUTE_PLAN_MODEL || env.OMNIROUTE_MODEL || 'auto',
        verifier: env.OMNIROUTE_MODEL || 'auto',
        subagent: env.OMNIROUTE_MODEL || 'auto',
        synthesis: env.OMNIROUTE_PLAN_MODEL || env.OMNIROUTE_MODEL || 'auto',
      },
    },
  };
  const defaultChain = ['gpu_workstation', 'openai', ...(providers.anthropic.apiKey ? ['anthropic'] : [])];
  return {
    providers,
    // In-house first (owner ruling 2026-09-26): every role tries the laptop GPU when the link is
    // up, then OpenAI. The VPS Ollama is CPU-only and too slow for the chat turn budget, so it
    // joins a chat chain only when configured explicitly (BOB_ROUTE_*). plan.js escalates to the
    // next provider when a local author's plan is unparseable or the verifier blocks it. Claude is the
    // last resort (owner direction 2026-11-10): an empty OpenAI balance degrades to it, not to failure.
    chains: {
      planner: parseChain(env.BOB_ROUTE_PLANNER, defaultChain),
      verifier: parseChain(env.BOB_ROUTE_VERIFIER, defaultChain),
      subagent: parseChain(env.BOB_ROUTE_SUBAGENT, defaultChain),
      synthesis: parseChain(env.BOB_ROUTE_SYNTHESIS, defaultChain),
    },
    timeoutMs: Math.max(5000, Number(env.BOB_MODEL_TIMEOUT_MS || env.OPENAI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)),
    temperature: Number.isFinite(Number.parseFloat(env.BOB_PLAN_TEMPERATURE)) ? Number.parseFloat(env.BOB_PLAN_TEMPERATURE) : 0.6,
    // Drafts (job descriptions, agreements) are long; reasoning tokens count against
    // this budget too, so a small cap silently returns an empty or truncated reply.
    planMaxTokens: Number(env.OPENAI_PLAN_MAX_TOKENS || 16000),
    planRetryMaxTokens: Number(env.OPENAI_PLAN_RETRY_MAX_TOKENS || 24000),
  };
}

function paramsUnsupportedError(text) {
  return /max_tokens|temperature|unsupported (parameter|value)|not supported with this model|reasoning_effort|max_completion_tokens/i.test(String(text || ''));
}

function createModelGateway({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, logger = console, router = null } = {}) {
  const config = createGatewayConfig(env);
  const health = new Map();
  // A role whose BOB_ROUTE_* chain is set explicitly is pinned (owner override); the rest are ranked
  // per turn by the data-driven model router (bob_model_catalog / bob_model_routing_policies).
  const pinnedRoles = {
    planner: Boolean(String(env.BOB_ROUTE_PLANNER || '').trim()),
    verifier: Boolean(String(env.BOB_ROUTE_VERIFIER || '').trim()),
    subagent: Boolean(String(env.BOB_ROUTE_SUBAGENT || '').trim()),
    synthesis: Boolean(String(env.BOB_ROUTE_SYNTHESIS || '').trim()),
  };
  const lastRanked = {};

  function providerFor(name, role) {
    const provider = config.providers[name];
    if (!provider || !provider.baseUrl) return null;
    const model = provider.models[role];
    if (!model) return null;
    if (provider.kind === 'openai' && !provider.apiKey) return null;
    return { name, ...provider, model };
  }

  async function probe(name) {
    const provider = config.providers[name];
    if (!provider || !provider.baseUrl) return { name, configured: false, healthy: false };
    const cached = health.get(name);
    if (cached && cached.until > now()) return { name, configured: true, healthy: cached.healthy, cached: true, ...(cached.reason ? { reason: cached.reason } : {}) };
    let healthy = false;
    let reason = null;
    try {
      const response = await fetchImpl(`${provider.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${provider.apiKey || 'none'}` },
        signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
      });
      healthy = response.ok;
      if (!healthy) reason = `probe_http_${response.status} ${provider.baseUrl}/models`;
    } catch (error) {
      healthy = false;
      reason = `probe_${(error && error.name === 'TimeoutError') ? 'timeout' : 'unreachable'} ${provider.baseUrl}`;
    }
    health.set(name, { healthy, until: now() + (healthy ? HEALTH_OK_TTL_MS : HEALTH_FAIL_TTL_MS), ...(reason ? { reason } : {}) });
    return { name, configured: true, healthy, cached: false, ...(reason ? { reason } : {}) };
  }

  function markUnhealthy(name, ttlMs = HEALTH_FAIL_TTL_MS, reason = null) {
    health.set(name, { healthy: false, until: now() + ttlMs, ...(reason ? { reason } : {}) });
  }

  function buildBody(provider, role, messages, options) {
    const reasoning = provider.kind === 'openai' && isReasoningModel(provider.model, provider.reasoningOverride);
    const body = { model: provider.model, messages, response_format: { type: 'json_object' } };
    if (options.forceClassicParams !== true && reasoning) {
      body.max_completion_tokens = options.maxTokens || config.planMaxTokens;
      body.reasoning_effort = options.reasoningEffort || (provider.reasoningEffort ? provider.reasoningEffort[role] : undefined) || 'medium';
    } else {
      body.max_tokens = options.maxTokens || (role === 'planner' || role === 'synthesis' ? 6000 : 1500);
      body.temperature = typeof options.temperature === 'number' ? options.temperature : config.temperature;
    }
    return body;
  }

  async function callProvider(provider, role, messages, options, attempts) {
    const timeoutMs = Math.min(options.timeoutMs || config.timeoutMs, config.timeoutMs);
    let forceClassicParams = false;
    let budgetRetry = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = now();
      const body = buildBody(provider, role, messages, {
        ...options,
        forceClassicParams,
        // Second chance after an empty/truncated completion: less reasoning, more room for the answer.
        ...(budgetRetry ? { maxTokens: Math.max(options.maxTokens || 0, config.planRetryMaxTokens), reasoningEffort: 'low' } : {}),
      });
      let response;
      let text = '';
      try {
        response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
          body: JSON.stringify(body),
          signal: options.signal || AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        attempts.push({ provider: provider.name, model: provider.model, ok: false, error: error && error.name === 'TimeoutError' ? 'timeout' : String(error && error.message || error).slice(0, 200), latency_ms: now() - started });
        markUnhealthy(provider.name);
        return null;
      }
      if (response.status === 400 && !forceClassicParams && paramsUnsupportedError(text)) {
        // Self-heal: the model rejected the reasoning-style params; retry with classic ones.
        forceClassicParams = true;
        attempts.push({ provider: provider.name, model: provider.model, ok: false, error: 'params_rejected_retrying_classic', latency_ms: now() - started });
        continue;
      }
      if (!response.ok) {
        // "You have no credits remaining" (429 insufficient_quota) is not a burst limit: keep OpenAI out
        // of the chain for a while and say so in health, instead of re-hitting it every turn (2026-09-27).
        const quota = response.status === 429 && /insufficient_quota|no credits|billing/i.test(text);
        attempts.push({ provider: provider.name, model: provider.model, ok: false, error: quota ? 'insufficient_quota' : `http_${response.status}`, detail: text.slice(0, 200), latency_ms: now() - started });
        if (quota) markUnhealthy(provider.name, QUOTA_FAIL_TTL_MS, 'insufficient_quota');
        else if (response.status >= 500 || response.status === 429) markUnhealthy(provider.name);
        return null;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        attempts.push({ provider: provider.name, model: provider.model, ok: false, error: 'invalid_provider_json', latency_ms: now() - started });
        return null;
      }
      const choice = parsed && parsed.choices && parsed.choices[0] ? parsed.choices[0] : null;
      const content = choice && choice.message ? choice.message.content : null;
      const finishReason = choice ? choice.finish_reason : null;
      const empty = typeof content !== 'string' || !content.trim();
      if ((empty || finishReason === 'length') && !budgetRetry && (role === 'planner' || role === 'synthesis')) {
        budgetRetry = true;
        attempts.push({ provider: provider.name, model: provider.model, ok: false, error: empty ? 'empty_completion_retrying_low_effort' : 'truncated_completion_retrying_low_effort', latency_ms: now() - started });
        continue;
      }
      if (empty) {
        attempts.push({ provider: provider.name, model: provider.model, ok: false, error: 'empty_completion', latency_ms: now() - started });
        return null;
      }
      attempts.push({ provider: provider.name, model: provider.model, ok: true, latency_ms: now() - started, finish_reason: finishReason });
      return { content, provider: provider.name, model: provider.model, latency_ms: now() - started, usage: parsed.usage || null, finish_reason: finishReason, truncated: finishReason === 'length' };
    }
    return null;
  }

  async function rankedChain(role) {
    const base = config.chains[role] || config.chains.planner;
    if (!router || pinnedRoles[role]) return base;
    try {
      const names = [...new Set([...base, ...Object.keys(config.providers)])];
      const candidates = names.map((name) => providerFor(name, role)).filter(Boolean).map((provider) => ({ provider: provider.name, model: provider.model }));
      const ranked = await router.rank({ candidates, surface: 'in_app', role });
      if (!ranked || !ranked.ordered.length) return base;
      const chain = [...new Set(ranked.ordered.map((entry) => entry.provider))];
      lastRanked[role] = { chain, taskClass: ranked.task_class, ranked: ranked.ordered, policy: ranked.policy };
      return chain;
    } catch (error) {
      logger.warn?.(`model gateway: auto routing failed for ${role}, static chain stands (${String(error && error.message || error).slice(0, 160)})`);
      return base;
    }
  }

  /**
   * Run a JSON-mode chat completion for a role. Returns
   * { content, provider, model, latency_ms, attempts } or throws when every
   * provider in the chain failed. `options.avoid` ({ provider, model }) skips a
   * provider that would answer with that exact identity — the critic must never be
   * the model that wrote the draft (BOB_DOCTRINE §9).
   */
  async function chatJson(role, messages, options = {}) {
    const chain = options.chain || await rankedChain(role);
    const taskClass = lastRanked[role] ? lastRanked[role].taskClass : 'general';
    const attempts = [];
    for (const name of chain) {
      const provider = providerFor(name, role);
      if (!provider) continue;
      if (options.avoid && options.avoid.provider === name && options.avoid.model === provider.model) {
        attempts.push({ provider: name, model: provider.model, ok: false, error: 'same_identity_as_author' });
        continue;
      }
      if (provider.kind !== 'openai') {
        const status = await probe(name);
        if (!status.healthy) {
          attempts.push({ provider: name, model: provider.model, ok: false, error: status.reason ? `unhealthy_or_unreachable (${status.reason})` : 'unhealthy_or_unreachable' });
          continue;
        }
      }
      const callStarted = now();
      const result = await callProvider(provider, role, messages, options, attempts);
      if (router && typeof router.observe === 'function') router.observe({ provider: name, model: provider.model, taskClass, ok: Boolean(result), latencyMs: now() - callStarted });
      if (result) return { ...result, attempts };
      if (options.signal && options.signal.aborted) break;
    }
    const error = new Error(`no model provider available for role ${role}`);
    error.attempts = attempts;
    throw error;
  }

  async function status() {
    const names = Object.keys(config.providers);
    const probes = await Promise.all(names.map((name) => probe(name)));
    return {
      chains: config.chains,
      auto_routing: router ? { enabled: true, pinned_roles: Object.keys(pinnedRoles).filter((role) => pinnedRoles[role]), last_ranked: lastRanked } : { enabled: false },
      providers: probes.map((entry) => ({
        ...entry,
        kind: config.providers[entry.name].kind,
        models: config.providers[entry.name].models,
      })),
    };
  }

  // The role's current chain: the last auto-ranked order when routing is data-driven, else the static one.
  function currentChain(role) {
    return (lastRanked[role] && lastRanked[role].chain) || config.chains[role] || config.chains.planner;
  }

  // The rest of a role's chain after `providerName` (escalation), or null when it was the last resort.
  function chainAfter(role, providerName) {
    const chain = currentChain(role);
    const index = chain.indexOf(providerName);
    if (index < 0 || index + 1 >= chain.length) return null;
    return chain.slice(index + 1);
  }

  function providerKind(providerName) {
    return config.providers[providerName] ? config.providers[providerName].kind : null;
  }

  // The role's chain with the strong (openai) tiers first and the in-house tiers kept as fallback:
  // a code request wants the strong planner, but an exhausted OpenAI balance must degrade to the
  // laptop model, not fail the turn (2026-09-27: every code request 502'd on "no credits remaining").
  // Null when the chain has no strong tier or is already strong-first.
  function fastChain(role) {
    const chain = currentChain(role);
    const fast = chain.filter((name) => providerKind(name) === 'openai');
    if (!fast.length || fast.length === chain.length) return null;
    const reordered = [...fast, ...chain.filter((name) => providerKind(name) !== 'openai')];
    return reordered.join(',') === chain.join(',') ? null : reordered;
  }

  return { config, chatJson, status, probe, isReasoningModel, chainAfter, fastChain, providerKind };
}

module.exports = { createGatewayConfig, createModelGateway, isReasoningModel, paramsUnsupportedError, parseChain };
