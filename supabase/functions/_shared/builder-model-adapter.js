const crypto = require('node:crypto');

const PROVIDERS = Object.freeze({
  OPENAI: 'openai',
  OLLAMA: 'ollama',
  GPU_WORKSTATION: 'gpu_workstation'
});

const LOCAL_WORKLOADS = new Set([
  'file_classification',
  'redaction_assistance',
  'repository_summary',
  'simple_documentation'
]);
const AUTHOR_WORKLOADS = new Set(['backend_implementation', 'frontend_implementation', 'frontend_repair']);
const REVIEW_WORKLOADS = new Set(['independent_code_review']);
const LOCAL_PROVIDERS = new Set([PROVIDERS.OLLAMA, PROVIDERS.GPU_WORKSTATION]);

// OpenAI answers within the 90 s that suits an edge-style caller; an in-house model may need
// ~100 s just to load cold on the VPS CPU (llama3.1:8b, job 73560f1c timed out at 90 s) and then
// generates at ~13 tok/s. Give local providers a longer budget so "slow" is not read as "stuck".
const DEFAULT_GATEWAY_TIMEOUT_MS = 90000;
const DEFAULT_LOCAL_GATEWAY_TIMEOUT_MS = 420000;

function gatewayTimeoutFor(provider, gateway = {}, env = process.env) {
  if (Number.isFinite(Number(gateway.timeoutMs)) && Number(gateway.timeoutMs) > 0) return Number(gateway.timeoutMs);
  if (LOCAL_PROVIDERS.has(provider)) {
    const configured = Number(env?.BOB_LOCAL_MODEL_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_LOCAL_GATEWAY_TIMEOUT_MS;
  }
  return DEFAULT_GATEWAY_TIMEOUT_MS;
}

function parseChain(raw, fallback) {
  const list = String(raw || '').split(',').map(item => item.trim()).filter(item => Object.values(PROVIDERS).includes(item));
  return list.length ? list : fallback;
}

// Owner ruling 2026-09-26: Bob works on his own compute (laptop GPU, then the VPS) and only
// outsources to OpenAI when he is stuck — unreachable, too small for the prompt, or failing.
// Restricted data never leaves the house. Chains are env-tunable per workload class.
function routingChains(env = process.env) {
  return {
    restricted: parseChain(env.BOB_BUILDER_ROUTE_RESTRICTED, [PROVIDERS.OLLAMA, PROVIDERS.GPU_WORKSTATION]),
    local: parseChain(env.BOB_BUILDER_ROUTE_LOCAL, [PROVIDERS.GPU_WORKSTATION, PROVIDERS.OLLAMA, PROVIDERS.OPENAI]),
    author: parseChain(env.BOB_BUILDER_ROUTE_AUTHOR, [PROVIDERS.GPU_WORKSTATION, PROVIDERS.OPENAI]),
    review: parseChain(env.BOB_BUILDER_ROUTE_REVIEW, [PROVIDERS.GPU_WORKSTATION, PROVIDERS.OLLAMA, PROVIDERS.OPENAI]),
    analysis: parseChain(env.BOB_BUILDER_ROUTE_ANALYSIS, [PROVIDERS.GPU_WORKSTATION, PROVIDERS.OPENAI])
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
  else if (REVIEW_WORKLOADS.has(workloadKind)) { chain = chains.review; reason = 'in_house_first_review'; }
  else { chain = chains.analysis; reason = 'in_house_first_analysis'; }
  return { provider: chain[0], chain, reason };
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
  timeoutMs = DEFAULT_GATEWAY_TIMEOUT_MS
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
      return { ok: false, status: response.status, error: data.error || `gateway returned ${response.status}` };
    }
    return { ok: true, status: response.status, data };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return {
      ok: false,
      status: timedOut ? 408 : 502,
      error: timedOut ? 'model gateway timed out' : 'model gateway unavailable',
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
 * chain past a provider that already failed (escalation between attempts).
 */
function selectProviders(modelRequest, { health = null, avoid = [], startAfter = null } = {}) {
  const chain = Array.isArray(modelRequest.chain) && modelRequest.chain.length ? modelRequest.chain : [modelRequest.provider];
  const from = startAfter ? chain.indexOf(startAfter) + 1 : 0;
  const candidates = [];
  for (const provider of chain.slice(from)) {
    const status = health ? health[provider] : null;
    if (status && (!status.configured || !status.healthy)) continue;
    const model = provider === PROVIDERS.OPENAI
      ? (modelRequest.model_name || status?.ready_model || null)
      : (status?.ready_model || (Array.isArray(status?.models) ? status.models[0] : null) || null);
    if (avoid.some(identity => identity && identity.provider === provider && (!identity.model || !model || identity.model === model))) continue;
    candidates.push({ provider, model });
  }
  return candidates;
}

const ESCALATE_STATUSES = new Set([408, 413, 422, 429, 500, 502, 503, 504]);

function providerRequest(modelRequest, candidate, suffix) {
  return {
    ...modelRequest,
    provider: candidate.provider,
    model_name: candidate.model,
    idempotency_key: suffix ? `${modelRequest.idempotency_key}::${suffix}` : modelRequest.idempotency_key,
    request: { ...modelRequest.request, provider: candidate.provider, model_name: candidate.model }
  };
}

async function executeBuilderModelRun({ supabase, modelRequest, gateway, validateOutput = null, avoidIdentities = [], startAfter = null }) {
  if (!supabase || !modelRequest) throw new Error('supabase and modelRequest are required');
  const health = await fetchModelHealth(gateway || {});
  const candidates = selectProviders(modelRequest, { health, avoid: avoidIdentities, startAfter });
  if (!candidates.length) return { ok: false, status: 503, error: 'no model provider is available for this request', attempts: [] };
  const attempts = [];
  let last = null;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    // The first provider keeps the caller's idempotency key; escalations get their own run record.
    const attemptRequest = providerRequest(modelRequest, candidate, index === 0 ? null : candidate.provider);
    last = await executeSingleModelRun({ supabase, modelRequest: attemptRequest, gateway, validateOutput });
    attempts.push({ provider: candidate.provider, model: candidate.model, ok: last.ok, status: last.status ?? null, error: last.ok ? null : String(last.error || '').slice(0, 200) });
    if (last.ok || last.duplicate) return { ...last, provider: candidate.provider, model_name: candidate.model, attempts, escalated: index > 0 };
    if (!ESCALATE_STATUSES.has(Number(last.status))) break;
  }
  return { ...last, attempts, escalated: attempts.length > 1 };
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
      started_at: startedAt
    }, { onConflict: 'idempotency_key' })
    .select('id')
    .single();

  if (insertError || !modelRun?.id) {
    return { ok: false, status: 503, error: 'model run provenance could not be recorded' };
  }

  const result = await callModelGateway({ ...gateway, modelRequest, timeoutMs: gatewayTimeoutFor(modelRequest.provider, gateway) });
  const completedAt = new Date().toISOString();
  if (result.ok) {
    if (validateOutput) {
      try {
        result.validated_output = validateOutput(result.data?.content);
      } catch (validationError) {
        // Keep the validator's reason and a short, redacted head of the output: a bare
        // "failed validation" cost a live round-trip to diagnose (job 3a4a2d06's reviewer).
        const reason = validationError instanceof Error ? validationError.message : String(validationError);
        const preview = String(result.data?.content ?? '').replace(/\s+/g, ' ').slice(0, 240);
        result.ok = false;
        result.status = 422;
        result.error = `model output failed validation: ${reason}${preview ? ` (output starts: ${preview})` : ''}`.slice(0, 600);
      }
    }
  }
  if (result.ok) {
    const persistence = await persistModelArtifact({
      supabase,
      modelRunId: modelRun.id,
      modelRequest,
      gatewayData: result.data
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
      error: result.error
    })
    .eq('id', modelRun.id);

  return { ...result, model_run_id: modelRun.id };
}

module.exports = {
  PROVIDERS,
  LOCAL_WORKLOADS,
  AUTHOR_WORKLOADS,
  REVIEW_WORKLOADS,
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
  selectProviders,
  providerRequest,
  executeBuilderModelRun,
  executeSingleModelRun
};