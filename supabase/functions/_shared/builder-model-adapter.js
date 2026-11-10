const crypto = require('node:crypto');
const { getDefaultModelRouter } = require('../../../services/fcm-api/src/bob/modelRouter');

const PROVIDERS = Object.freeze({
  OPENAI: 'openai',
  OLLAMA: 'ollama',
  GPU_WORKSTATION: 'gpu_workstation',
  OLLAMA_CLOUD: 'ollama_cloud',
  ANTHROPIC: 'anthropic',
  OMNIROUTE: 'omniroute'
});

const LOCAL_WORKLOADS = new Set([
  'file_classification',
  'redaction_assistance',
  'repository_summary',
  'simple_documentation'
]);
const AUTHOR_WORKLOADS = new Set(['backend_implementation', 'frontend_implementation', 'frontend_repair', 'vibe_implementation']);
const REVIEW_WORKLOADS = new Set(['independent_code_review']);
const SECURITY_WORKLOADS = new Set(['security_review']);
const LOCAL_PROVIDERS = new Set([PROVIDERS.OLLAMA, PROVIDERS.GPU_WORKSTATION]);
const HOSTED_LONG_PROVIDERS = new Set([PROVIDERS.OLLAMA_CLOUD, PROVIDERS.ANTHROPIC, PROVIDERS.OMNIROUTE]);

// OpenAI answers within the 90 s that suits an edge-style caller; an in-house model may need
// ~100 s just to load cold on the VPS CPU (llama3.1:8b, job 73560f1c timed out at 90 s) and then
// generates at ~13 tok/s. Give local providers a longer budget so "slow" is not read as "stuck".
const DEFAULT_GATEWAY_TIMEOUT_MS = 90000;
const DEFAULT_LOCAL_GATEWAY_TIMEOUT_MS = 420000;
// Hosted large models answer slower than OpenAI's small models but need no cold load.
const DEFAULT_CLOUD_GATEWAY_TIMEOUT_MS = 300000;

function planningTimeoutFor(input) {
  return input?.provider === PROVIDERS.OLLAMA && !Array.isArray(input.messages)
    && ['product_analysis', 'ux_design'].includes(input.workload_kind) ? 120000 : null;
}

function gatewayTimeoutFor(provider, gateway = {}, env = process.env, request = {}) {
  const planningTimeout = planningTimeoutFor({ ...request, provider });
  if (planningTimeout) return Math.min(Number(gateway.timeoutMs) > 0 ? Number(gateway.timeoutMs) : Infinity, planningTimeout + 5000);
  if (Number.isFinite(Number(gateway.timeoutMs)) && Number(gateway.timeoutMs) > 0) return Number(gateway.timeoutMs);
  if (LOCAL_PROVIDERS.has(provider)) {
    const configured = Number(env?.BOB_LOCAL_MODEL_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LOCAL_GATEWAY_TIMEOUT_MS;
  }
  if (HOSTED_LONG_PROVIDERS.has(provider)) {
    const configured = Number(env?.BOB_CLOUD_MODEL_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CLOUD_GATEWAY_TIMEOUT_MS;
  }
  return DEFAULT_GATEWAY_TIMEOUT_MS;
}

function parseChain(raw, fallback) {
  const list = String(raw || '').split(',').map(item => item.trim()).filter(item => Object.values(PROVIDERS).includes(item));
  return list.length ? list : fallback;
}

// Owner ruling 2026-10-16: Bob's own compute is the primary Builder workforce. Every unrestricted
// stage (analysis, authoring, independent review) runs on the laptop GPU first, then the VPS CPU,
// and reaches OpenAI only as the last resort when both in-house tiers fail, time out, or return
// output that fails validation. This supersedes the 2026-10-13 strong-first default: paying
// OpenAI per call for 30-60 agentic turns per job is the cost the owner has ruled out.
//
// Owner direction 2026-10-18: Ollama Cloud (owner's ollama.com subscription) is the first outsourced
// tier, ahead of per-call OpenAI. It is external, so it never joins the restricted (local-only) chain.
//
// Owner direction 2026-10-21 ("a stronger model, in the VPS or GPU or both, in parallel or any way that
// benefits the project"): the VPS CPU tier leaves the unrestricted chains. Measured over 21 days it
// passed 0-3% of analysis/UX runs (qwen2.5-coder:7b; qwen3-coder:30b timed out) while costing 2-7 min
// per attempt before escalation; the laptop GPU, Ollama Cloud gpt-oss:120b (13/14 agentic) and OpenAI
// carry the work. In-house still goes first (GPU), the flat-rate subscription second, per-call OpenAI
// last. The VPS CPU now serves restricted-data runs and knowledge embeddings. Parallelism comes from the
// gateway's one-request-per-local-provider guard: a busy GPU answers 429, which escalates, so concurrent
// stages spread across the GPU and Ollama Cloud instead of queueing.
// Owner direction 2026-11-10: Anthropic Claude is an implementation and security-review engine. It
// joins the unrestricted chains after the flat-rate Ollama Cloud subscription and before per-call
// OpenAI, and leads the independent (security) review chains. An unconfigured provider is skipped by health, so
// these defaults are inert until ANTHROPIC_API_KEY is set. OmniRoute (which can reach free
// third-party tiers) joins a chain when BOB_BUILDER_ROUTE_* names it or the auto router ranks it.
const IN_HOUSE_FIRST = Object.freeze([PROVIDERS.GPU_WORKSTATION, PROVIDERS.OLLAMA_CLOUD, PROVIDERS.ANTHROPIC, PROVIDERS.OPENAI]);
const SECURITY_FIRST = Object.freeze([PROVIDERS.ANTHROPIC, PROVIDERS.GPU_WORKSTATION, PROVIDERS.OLLAMA_CLOUD, PROVIDERS.OPENAI]);
const EXTERNAL_PROVIDERS = new Set([PROVIDERS.OLLAMA_CLOUD, PROVIDERS.OPENAI, PROVIDERS.ANTHROPIC, PROVIDERS.OMNIROUTE]);

function localOnly(chain) {
  const local = chain.filter(provider => !EXTERNAL_PROVIDERS.has(provider));
  return local.length ? local : [PROVIDERS.OLLAMA, PROVIDERS.GPU_WORKSTATION];
}

function routingChains(env = process.env) {
  return {
    // Restricted data never leaves Bob's own compute, whatever the environment asks for.
    restricted: localOnly(parseChain(env.BOB_BUILDER_ROUTE_RESTRICTED, [PROVIDERS.OLLAMA, PROVIDERS.GPU_WORKSTATION])),
    local: parseChain(env.BOB_BUILDER_ROUTE_LOCAL, [...IN_HOUSE_FIRST]),
    author: parseChain(env.BOB_BUILDER_ROUTE_AUTHOR, [...IN_HOUSE_FIRST]),
    review: parseChain(env.BOB_BUILDER_ROUTE_REVIEW, [...SECURITY_FIRST]),
    security: parseChain(env.BOB_BUILDER_ROUTE_SECURITY, [...SECURITY_FIRST]),
    analysis: parseChain(env.BOB_BUILDER_ROUTE_ANALYSIS, [...IN_HOUSE_FIRST])
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableSerialize(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function routeBuilderModel({ workloadKind, containsRestrictedData = false, env = process.env }) {
  if (!workloadKind || typeof workloadKind !== 'string') {
    throw new Error('workloadKind is required');
  }
  const chains = routingChains(env);
  let chain;
  let reason;
  if (containsRestrictedData) { chain = chains.restricted; reason = 'restricted_data_local_only'; }
  else if (LOCAL_WORKLOADS.has(workloadKind)) { chain = chains.local; reason = 'low_risk_local_workload'; }
  else if (AUTHOR_WORKLOADS.has(workloadKind)) { chain = chains.author; reason = 'in_house_first_author'; }
  else if (REVIEW_WORKLOADS.has(workloadKind)) { chain = chains.review; reason = 'security_review_engine_first'; }
  else if (SECURITY_WORKLOADS.has(workloadKind)) { chain = chains.security; reason = 'security_review_engine_first'; }
  else { chain = chains.analysis; reason = 'in_house_first_analysis'; }
  const pinVariable = {
    restricted_data_local_only: 'BOB_BUILDER_ROUTE_RESTRICTED',
    low_risk_local_workload: 'BOB_BUILDER_ROUTE_LOCAL',
    in_house_first_author: 'BOB_BUILDER_ROUTE_AUTHOR',
    security_review_engine_first: REVIEW_WORKLOADS.has(workloadKind) ? 'BOB_BUILDER_ROUTE_REVIEW' : 'BOB_BUILDER_ROUTE_SECURITY',
    in_house_first_analysis: 'BOB_BUILDER_ROUTE_ANALYSIS'
  }[reason];
  // An explicit env chain is the owner's emergency override and switches auto ranking off for that stage.
  const pinned = Boolean(String(env?.[pinVariable] || '').trim());
  return { provider: chain[0], chain, reason, pinned };
}

function buildModelRunRequest({
  organizationId,
  jobId,
  stepId = null,
  builderMode,
  workloadKind,
  promptVersion,
  systemPrompt,
  userPrompt,
  inputArtifactIds = [],
  outputSchema = null,
  containsRestrictedData = false,
  modelName = null
}) {
  if (!organizationId || !jobId || !builderMode || !promptVersion) {
    throw new Error('organizationId, jobId, builderMode, and promptVersion are required');
  }
  if (!systemPrompt || !userPrompt) {
    throw new Error('systemPrompt and userPrompt are required');
  }

  const route = routeBuilderModel({ workloadKind, containsRestrictedData });
  const requestBody = {
    provider: route.provider,
    model_name: modelName,
    builder_mode: builderMode,
    workload_kind: workloadKind,
    prompt_version: promptVersion,
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    input_artifact_ids: inputArtifactIds,
    output_schema: outputSchema
  };
  const requestHash = crypto
    .createHash('sha256')
    .update(stableSerialize(requestBody))
    .digest('hex');

  return {
    organization_id: organizationId,
    job_id: jobId,
    step_id: stepId,
    provider: route.provider,
    chain: route.chain,
    routing_reason: route.reason,
    routing_pinned: route.pinned,
    model_name: modelName,
    prompt_version: promptVersion,
    idempotency_key: `${jobId}::${stepId || 'job'}::${requestHash}`,
    input_artifact_ids: inputArtifactIds,
    request: requestBody
  };
}

function resolveArtifactType(modelRequest) {
  const mode = modelRequest?.request?.builder_mode;
  const workload = modelRequest?.request?.workload_kind;
  if (mode === 'product_analyst') return 'product_specification';
  if (mode === 'ux_designer') return 'ui_design_plan';
  if (mode === 'frontend_engineer' || mode === 'backend_engineer') return 'code_implementation';
  if (mode === 'qa_security_reviewer') {
    return workload === 'security_review' ? 'security_review' : 'test_results';
  }
  if (mode === 'code_reviewer') return 'code_review';
  if (mode === 'release_engineer') return 'release_notes';
  throw new Error('unsupported builder mode for artifact persistence');
}

function contentMetadata(content) {
  const bytes = Buffer.from(content, 'utf8');
  let contentType = 'text/markdown';
  try {
    JSON.parse(content);
    contentType = 'application/json';
  } catch {}
  return {
    bytes,
    contentType,
    checksum: crypto.createHash('sha256').update(bytes).digest('hex')
  };
}

async function persistModelArtifact({ supabase, modelRunId, modelRequest, gatewayData, artifactType = null }) {
  if (typeof gatewayData?.content !== 'string' || !gatewayData.content) {
    return { success: false, error: 'model gateway returned no artifact content' };
  }

  const metadata = contentMetadata(gatewayData.content);
  const extension = metadata.contentType === 'application/json' ? 'json' : 'md';
  const objectPath = `${modelRequest.organization_id}/${modelRequest.job_id}/${modelRunId}.${extension}`;
  const bucket = supabase.storage.from('builder-artifacts');
  const { error: uploadError } = await bucket.upload(objectPath, metadata.bytes, {
    contentType: metadata.contentType,
    upsert: false
  });
  if (uploadError) return { success: false, error: 'model artifact upload failed' };

  const { data: storedObject, error: downloadError } = await bucket.download(objectPath);
  if (downloadError || !storedObject) {
    await bucket.remove([objectPath]);
    return { success: false, error: 'model artifact verification failed' };
  }

  const storedBytes = Buffer.from(await storedObject.arrayBuffer());
  const storedChecksum = crypto.createHash('sha256').update(storedBytes).digest('hex');
  if (storedBytes.length !== metadata.bytes.length || storedChecksum !== metadata.checksum) {
    await bucket.remove([objectPath]);
    return { success: false, error: 'model artifact integrity check failed' };
  }

  const { data: artifact, error: rpcError } = await supabase.rpc('builder_finalize_model_artifact', {
    _model_run_id: modelRunId,
    _artifact_type: artifactType || resolveArtifactType(modelRequest),
    _content_type: metadata.contentType,
    _object_path: objectPath,
    _sha256: metadata.checksum,
    _size_bytes: metadata.bytes.length,
    _model_name: gatewayData.model || modelRequest.model_name || 'provider_default',
    _usage_metadata: gatewayData.usage || {}
  });
  if (rpcError || !artifact?.id) {
    await bucket.remove([objectPath]);
    return { success: false, error: 'model artifact registration failed' };
  }

  return { success: true, artifact, objectPath };
}

async function callModelGateway({
  fetchImpl = globalThis.fetch,
  gatewayUrl,
  apiToken,
  modelRequest,
  timeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS,
  retrying = false
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (!gatewayUrl || !apiToken) throw new Error('model gateway credentials are required');
  if (!modelRequest) throw new Error('modelRequest is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${gatewayUrl.replace(/\/+$/, '')}/api/bob/builder/model-run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({
        provider: modelRequest.provider,
        model: modelRequest.model_name,
        idempotency_key: modelRequest.idempotency_key,
        ...modelRequest.request
      }),
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: 'model gateway returned malformed JSON' };
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: data.error || `gateway returned ${response.status}`, code: typeof data.code === 'string' ? data.code.slice(0, 80) : null };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    // A dropped keep-alive socket (the control plane calls its own gateway) is not the model being
    // down: retry once after a short pause before reporting it. Timeouts are never retried here.
    if (!timedOut && !retrying) {
      clearTimeout(timer);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return callModelGateway({ fetchImpl, gatewayUrl, apiToken, modelRequest, timeoutMs, retrying: true });
    }
    const detail = String(error?.cause?.code || error?.cause?.message || error?.message || '').slice(0, 120);
    return {
      ok: false,
      status: timedOut ? 408 : 502,
      error: timedOut ? 'model gateway timed out' : `model gateway unavailable${detail ? ` (${detail})` : ''}`,
      timeout: timedOut
    };
  } finally {
    clearTimeout(timer);
  }
}

const healthSnapshotCache = { at: 0, value: null };
const HEALTH_SNAPSHOT_TTL_MS = 20_000;

// Provider health as the control plane sees it (configured, reachable, installed models).
// Cached briefly; a missing route or failure yields null and the chain falls back to
// "try every provider in order", which the gateway's own probes still guard.
async function fetchModelHealth({ gatewayUrl, apiToken, fetchImpl = globalThis.fetch, now = Date.now, health = null } = {}) {
  if (health) return health;
  if (!gatewayUrl || !apiToken) return null;
  if (healthSnapshotCache.value && now() - healthSnapshotCache.at < HEALTH_SNAPSHOT_TTL_MS) return healthSnapshotCache.value;
  try {
    const response = await fetchImpl(`${gatewayUrl.replace(/\/+$/, '')}/api/bob/builder/model-health`, { headers: { Authorization: `Bearer ${apiToken}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const value = await response.json();
    healthSnapshotCache.at = now();
    healthSnapshotCache.value = value && typeof value === 'object' ? value : null;
    return healthSnapshotCache.value;
  } catch {
    return null;
  }
}

/**
 * The ordered providers a request may try, with the model each would serve. Unhealthy or
 * unconfigured providers are dropped when health is known; `avoid` removes provider+model
 * identities (the independent reviewer must not be the author); `startAfter` resumes the
 * chain past a provider that already failed. Gateway health's models list is already memory-budgeted.
 */
function selectProviders(modelRequest, { health = null, avoid = [], startAfter = null } = {}) {
  const chain = Array.isArray(modelRequest.chain) && modelRequest.chain.length ? modelRequest.chain : [modelRequest.provider];
  const from = startAfter ? chain.indexOf(startAfter) + 1 : 0;
  const candidates = [];
  for (const provider of chain.slice(from)) {
    const status = health ? health[provider] : null;
    // A health report that omits a provider (an older gateway, or Ollama Cloud with no key) means it is not available.
    if (health && !status) continue;
    if (status && (!status.configured || !status.healthy)) continue;
    const avoided = candidate => avoid.some(identity => identity && identity.provider === provider && (!identity.model || !candidate || identity.model === candidate));
    let model = provider === PROVIDERS.OPENAI
      ? (modelRequest.model_name || status?.ready_model || null)
      : (status?.ready_model || (Array.isArray(status?.models) ? status.models[0] : null) || null);
    if (provider !== PROVIDERS.OPENAI && status && !model) continue;
    if (avoided(model)) {
      if (provider === PROVIDERS.OPENAI) continue;
      // The in-house reviewer may share the author's machine but not its model: the next installed
      // allowlisted model on the same provider (e.g. gpt-oss:20b after qwen3-coder:30b) serves instead.
      const installed = Array.isArray(status?.installed) && status.installed.length ? status.installed : null;
      const isInstalled = candidate => !installed || installed.includes(candidate) || installed.includes(`${candidate}:latest`);
      model = (Array.isArray(status?.models) ? status.models : []).find(candidate => !avoided(candidate) && isInstalled(candidate)) || null;
      if (!model) continue;
    }
    candidates.push({ provider, model });
  }
  return candidates;
}

const ESCALATE_STATUSES = new Set([408, 413, 422, 429, 500, 502, 503, 504]);

// Every installed allowlisted model a healthy provider offers, after the one selectProviders chose,
// so the ranker can prefer a stronger model on the same provider (e.g. gpt-oss:120b over kimi).
function expandModels(pool, modelRequest, health, avoid = []) {
  const expanded = [];
  const seen = new Set();
  const push = candidate => {
    const key = `${candidate.provider}\u0000${candidate.model || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    expanded.push(candidate);
  };
  for (const candidate of pool) {
    push(candidate);
    const status = health ? health[candidate.provider] : null;
    if (!status || !Array.isArray(status.models)) continue;
    if (candidate.provider === PROVIDERS.OPENAI && modelRequest.model_name) continue;
    const installed = Array.isArray(status.installed) && status.installed.length ? status.installed : null;
    for (const model of status.models) {
      if (!model || (installed && !installed.includes(model) && !installed.includes(`${model}:latest`))) continue;
      if (avoid.some(identity => identity && identity.provider === candidate.provider && (!identity.model || identity.model === model))) continue;
      push({ provider: candidate.provider, model });
    }
  }
  return expanded;
}

/**
 * The candidates a request should try, best first. With a model router (data-driven auto routing)
 * the pool is every healthy catalogued provider and installed model, ranked for this workload;
 * without one, or when the stage is env-pinned, the static chain order stands. Restricted data
 * never reaches an external provider on either path.
 */
async function routedCandidates(modelRequest, { health = null, avoid = [], startAfter = null, router = getDefaultModelRouter(), surface = 'builder' } = {}) {
  const staticCandidates = selectProviders(modelRequest, { health, avoid, startAfter });
  if (!router) return { candidates: staticCandidates, routing: { mode: 'static', reason: 'no_router' } };
  if (modelRequest.routing_pinned) return { candidates: staticCandidates, routing: { mode: 'static', reason: 'env_pinned' } };
  const restricted = modelRequest.routing_reason === 'restricted_data_local_only';
  let ranked = null;
  try {
    const known = new Set(Object.values(PROVIDERS));
    const extra = restricted ? [] : (await router.catalogProviders()).filter(provider => known.has(provider));
    const chain = [...new Set([...(Array.isArray(modelRequest.chain) && modelRequest.chain.length ? modelRequest.chain : [modelRequest.provider]), ...extra])];
    const pool = expandModels(selectProviders({ ...modelRequest, chain }, { health, avoid }), modelRequest, health, avoid)
      .filter(candidate => !restricted || !EXTERNAL_PROVIDERS.has(candidate.provider));
    ranked = await router.rank({
      candidates: pool,
      surface,
      workloadKind: modelRequest.request?.workload_kind || null,
      promptVersion: modelRequest.prompt_version,
      organizationId: modelRequest.organization_id,
      restricted
    });
  } catch (error) {
    return { candidates: staticCandidates, routing: { mode: 'static', reason: `router_error: ${String(error && error.message || error).slice(0, 120)}` } };
  }
  if (!ranked) return { candidates: staticCandidates, routing: { mode: 'static', reason: 'routing_data_unavailable' } };
  let ordered = ranked.ordered
    .filter(candidate => !restricted || !EXTERNAL_PROVIDERS.has(candidate.provider))
    .map(({ provider, model }) => ({ provider, model }));
  if (startAfter) {
    const last = ordered.map(candidate => candidate.provider).lastIndexOf(startAfter);
    if (last >= 0) ordered = ordered.slice(last + 1);
  }
  const routing = {
    mode: 'auto',
    surface,
    task_class: ranked.task_class,
    policy: ranked.policy,
    ranked: ranked.ordered.map(({ provider, model, score, quality, success, runs, cost_tier }) => ({ provider, model, score, quality, success, runs, cost_tier })),
    excluded: ranked.excluded
  };
  if (!ordered.length) return { candidates: staticCandidates, routing: { ...routing, mode: 'static', reason: 'policy_permitted_none' } };
  return { candidates: ordered, routing };
}

// The routing decision stored on the run, so later ranking and the owner can see why this model ran.
function compactRouting(routing, modelRequest) {
  return {
    mode: routing.mode,
    reason: routing.reason || modelRequest.routing_reason || null,
    task_class: routing.task_class || null,
    policy_id: routing.policy?.id || null,
    rank: Array.isArray(routing.ranked) ? routing.ranked.findIndex(entry => entry.provider === modelRequest.provider && entry.model === modelRequest.model_name) + 1 || null : null,
    score: Array.isArray(routing.ranked) ? routing.ranked.find(entry => entry.provider === modelRequest.provider && entry.model === modelRequest.model_name)?.score ?? null : null
  };
}

function observeOutcome(router, routing, candidate, result, startedAt) {
  if (!router || typeof router.observe !== 'function' || !candidate) return;
  router.observe({ provider: candidate.provider, model: candidate.model, taskClass: routing?.task_class || 'general', ok: Boolean(result?.ok), latencyMs: Date.now() - startedAt });
}

function providerRequest(modelRequest, candidate, suffix) {
  return {
    ...modelRequest,
    provider: candidate.provider,
    model_name: candidate.model,
    idempotency_key: suffix ? `${modelRequest.idempotency_key}::${suffix}` : modelRequest.idempotency_key,
    request: { ...modelRequest.request, provider: candidate.provider, model_name: candidate.model }
  };
}

async function executeBuilderModelRun({ supabase, modelRequest, gateway, validateOutput = null, avoidIdentities = [], startAfter = null, router = getDefaultModelRouter() }) {
  if (!supabase || !modelRequest) throw new Error('supabase and modelRequest are required');
  const health = await fetchModelHealth(gateway || {});
  const { candidates, routing } = await routedCandidates(modelRequest, { health, avoid: avoidIdentities, startAfter, router });
  if (!candidates.length) return { ok: false, status: 503, error: 'no model provider is available for this request', attempts: [], routing };
  const attempts = [];
  const corrections = [];
  const triedProviders = new Set();
  let last = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    // The first provider keeps the caller's idempotency key; escalations get their own run record
    // (a second model on an already-tried provider is keyed by provider and model).
    const suffix = index === 0 ? null : triedProviders.has(candidate.provider) ? `${candidate.provider}:${candidate.model}` : candidate.provider;
    triedProviders.add(candidate.provider);
    const attemptRequest = { ...providerRequest(modelRequest, candidate, suffix), routing };
    if (corrections.length) {
      const feedback = JSON.stringify({ validation_corrections: corrections.slice(-3), instruction: 'Correct these prior validation failures. Preserve all original evidence, scope and output requirements.' });
      attemptRequest.request = Array.isArray(attemptRequest.request.messages)
        ? { ...attemptRequest.request, messages: [...attemptRequest.request.messages, { role: 'user', content: feedback }] }
        : { ...attemptRequest.request, user_prompt: `${attemptRequest.request.user_prompt}\n\n${feedback}` };
      attemptRequest.idempotency_key += `::correction-${crypto.createHash('sha256').update(feedback).digest('hex').slice(0, 16)}`;
    }
    const attemptStarted = Date.now();
    last = await executeSingleModelRun({ supabase, modelRequest: attemptRequest, gateway, validateOutput });
    if (!last.duplicate) observeOutcome(router, routing, candidate, last, attemptStarted);
    attempts.push({ provider: candidate.provider, model: candidate.model, ok: last.ok, status: last.status ?? null, error: last.ok ? null : String(last.error || '').slice(0, 200) });
    if (last.ok || last.duplicate) return { ...last, provider: candidate.provider, model_name: candidate.model, attempts, escalated: index > 0, routing };
    if (last.validation_error) corrections.push(String(last.validation_error).slice(0, 600));
    if (!ESCALATE_STATUSES.has(Number(last.status))) break;
  }
  return { ...last, attempts, escalated: attempts.length > 1, routing };
}

async function executeSingleModelRun({ supabase, modelRequest, gateway, validateOutput = null }) {

  const { data: existing } = await supabase
    .from('builder_model_runs')
    .select('id, status, output_artifact_ids, usage_metadata')
    .eq('idempotency_key', modelRequest.idempotency_key)
    .maybeSingle();
  if (existing?.status === 'completed') {
    return { ok: true, duplicate: true, modelRun: existing };
  }
  if (existing?.status === 'running') {
    return { ok: false, status: 409, duplicate: true, error: 'model run is already in progress' };
  }

  const startedAt = new Date().toISOString();
  const { data: modelRun, error: insertError } = await supabase
    .from('builder_model_runs')
    .upsert({
      organization_id: modelRequest.organization_id,
      job_id: modelRequest.job_id,
      step_id: modelRequest.step_id,
      provider: modelRequest.provider,
      model_name: modelRequest.model_name || 'provider_default',
      prompt_version: modelRequest.prompt_version,
      idempotency_key: modelRequest.idempotency_key,
      input_artifact_ids: modelRequest.input_artifact_ids,
      status: 'running',
      started_at: startedAt,
      completed_at: null,
      error: null,
      output_artifact_ids: [],
      usage_metadata: {}
    }, { onConflict: 'idempotency_key' })
    .select('id')
    .single();

  if (insertError || !modelRun?.id) {
    return { ok: false, status: 503, error: 'model run provenance could not be recorded' };
  }

  const result = await callModelGateway({ ...gateway, modelRequest, timeoutMs: gatewayTimeoutFor(modelRequest.provider, gateway, process.env, modelRequest.request) });
  const usage = { ...(result.data?.usage || {}), output_validated: null, ...(modelRequest.routing && modelRequest.routing.reason !== 'no_router' ? { routing: compactRouting(modelRequest.routing, modelRequest) } : {}) };
  const completedAt = new Date().toISOString();
  if (result.ok) {
    if (validateOutput) {
      try {
        result.validated_output = validateOutput(result.data?.content);
        usage.output_validated = true;
      } catch (validationError) {
        // Keep the validator's reason and a short, redacted head of the output: a bare
        // "failed validation" cost a live round-trip to diagnose (job 3a4a2d06's reviewer).
        const reason = validationError instanceof Error ? validationError.message : String(validationError);
        const preview = String(result.data?.content ?? '').replace(/\s+/g, ' ').slice(0, 240);
        result.ok = false;
        usage.output_validated = false;
        result.status = 422;
        result.validation_error = reason.slice(0, 600);
        result.error = `model output failed validation: ${reason}${preview ? ` (output starts: ${preview})` : ''}`.slice(0, 600);
      }
    }
  }
  if (result.ok) {
    const persistence = await persistModelArtifact({
      supabase,
      modelRunId: modelRun.id,
      modelRequest,
      gatewayData: { ...result.data, usage }
    });
    if (persistence.success) {
      return {
        ...result,
        data: { ...result.data, output_artifact_ids: [persistence.artifact.id] },
        model_run_id: modelRun.id,
        artifact: persistence.artifact,
        validated_output: result.validated_output
      };
    }
    result.ok = false;
    result.status = 502;
    result.error = persistence.error;
  }

  const finalStatus = result.timeout ? 'timeout' : 'failed';

  await supabase
    .from('builder_model_runs')
    .update({
      status: finalStatus,
      completed_at: completedAt,
      error: result.error,
      usage_metadata: { ...usage, failure: { http_status: result.status, code: result.code || null, timeout: result.timeout === true } }
    })
    .eq('id', modelRun.id);

  return { ...result, model_run_id: modelRun.id };
}

module.exports = {
  PROVIDERS,
  EXTERNAL_PROVIDERS,
  LOCAL_WORKLOADS,
  AUTHOR_WORKLOADS,
  REVIEW_WORKLOADS,
  SECURITY_WORKLOADS,
  routingChains,
  stableSerialize,
  routeBuilderModel,
  buildModelRunRequest,
  resolveArtifactType,
  contentMetadata,
  persistModelArtifact,
  callModelGateway,
  fetchModelHealth,
  gatewayTimeoutFor,
  planningTimeoutFor,
  selectProviders,
  expandModels,
  routedCandidates,
  compactRouting,
  providerRequest,
  executeBuilderModelRun,
  executeSingleModelRun
};