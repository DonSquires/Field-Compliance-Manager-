const crypto = require('node:crypto');

const PROVIDERS = Object.freeze({
  OPENAI: 'openai',
  OLLAMA: 'ollama'
});

const LOCAL_WORKLOADS = new Set([
  'file_classification',
  'redaction_assistance',
  'repository_summary',
  'simple_documentation'
]);

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

function routeBuilderModel({ workloadKind, containsRestrictedData = false }) {
  if (!workloadKind || typeof workloadKind !== 'string') {
    throw new Error('workloadKind is required');
  }

  if (containsRestrictedData || LOCAL_WORKLOADS.has(workloadKind)) {
    return {
      provider: PROVIDERS.OLLAMA,
      reason: containsRestrictedData ? 'restricted_data_local_only' : 'low_risk_local_workload'
    };
  }

  return {
    provider: PROVIDERS.OPENAI,
    reason: 'complex_builder_workload'
  };
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

async function persistModelArtifact({ supabase, modelRunId, modelRequest, gatewayData }) {
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
    _artifact_type: resolveArtifactType(modelRequest),
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
  timeoutMs = 90000
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

async function executeBuilderModelRun({ supabase, modelRequest, gateway, validateOutput = null }) {
  if (!supabase || !modelRequest) throw new Error('supabase and modelRequest are required');

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

  const result = await callModelGateway({ ...gateway, modelRequest });
  const completedAt = new Date().toISOString();
  if (result.ok) {
    if (validateOutput) {
      try {
        result.validated_output = validateOutput(result.data?.content);
      } catch {
        result.ok = false;
        result.status = 422;
        result.error = 'model output failed validation';
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
  stableSerialize,
  routeBuilderModel,
  buildModelRunRequest,
  resolveArtifactType,
  contentMetadata,
  persistModelArtifact,
  callModelGateway,
  executeBuilderModelRun
};