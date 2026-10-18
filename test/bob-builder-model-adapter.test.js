const assert = require('node:assert/strict');
const test = require('node:test');

const {
  routeBuilderModel,
  buildModelRunRequest,
  resolveArtifactType,
  contentMetadata,
  persistModelArtifact,
  callModelGateway,
  executeBuilderModelRun
} = require('../supabase/functions/_shared/builder-model-adapter.js');

function makeRequest(overrides = {}) {
  return buildModelRunRequest({
    organizationId: 'org-1',
    jobId: 'job-1',
    stepId: 'step-1',
    builderMode: 'product_analyst',
    workloadKind: 'architecture',
    promptVersion: 'product-analyst-v1',
    systemPrompt: 'Produce a grounded specification.',
    userPrompt: 'Assess the requested change.',
    ...overrides
  });
}

test('model routing keeps low-risk preprocessing in-house first', () => {
  const route = routeBuilderModel({ workloadKind: 'repository_summary' });
  assert.deepEqual(route.chain, ['gpu_workstation', 'ollama', 'ollama_cloud', 'openai']);
  assert.equal(route.provider, 'gpu_workstation');
});

test('model routing is in-house first with OpenAI as the outsourced fallback, per workload class', () => {
  // Owner ruling 2026-10-16: laptop GPU, then VPS CPU, then OpenAI as the paid last resort.
  assert.deepEqual(routeBuilderModel({ workloadKind: 'architecture' }).chain, ['gpu_workstation', 'ollama', 'ollama_cloud', 'openai'], 'structured Builder stages start on in-house compute');
  assert.deepEqual(routeBuilderModel({ workloadKind: 'backend_implementation' }).chain, ['gpu_workstation', 'ollama', 'ollama_cloud', 'openai'], 'unrestricted coding starts on the laptop GPU');
  assert.equal(routeBuilderModel({ workloadKind: 'backend_implementation' }).reason, 'in_house_first_author');
  assert.deepEqual(routeBuilderModel({ workloadKind: 'independent_code_review' }).chain, ['gpu_workstation', 'ollama', 'ollama_cloud', 'openai'], 'the independent check starts in-house too');
  assert.equal(routeBuilderModel({ workloadKind: 'independent_code_review' }).chain.at(-1), 'openai', 'OpenAI is always the last resort');
  assert.deepEqual(routeBuilderModel({ workloadKind: 'independent_code_review', env: { BOB_BUILDER_ROUTE_REVIEW: 'openai,gpu_workstation' } }).chain, ['openai', 'gpu_workstation'], 'operators can still pin a strong-first chain');
  // Operators can pin a class to OpenAI (or anything else) without a code change.
  assert.deepEqual(routeBuilderModel({ workloadKind: 'backend_implementation', env: { BOB_BUILDER_ROUTE_AUTHOR: 'openai' } }).chain, ['openai']);
  assert.deepEqual(routeBuilderModel({ workloadKind: 'backend_implementation', env: { BOB_BUILDER_ROUTE_AUTHOR: 'nonsense' } }).chain, ['gpu_workstation', 'ollama', 'ollama_cloud', 'openai'], 'unknown providers fall back to the default chain');
});

test('model routing keeps restricted data local regardless of workload', () => {
  const route = routeBuilderModel({ workloadKind: 'architecture', containsRestrictedData: true });
  assert.deepEqual(route.chain, ['ollama', 'gpu_workstation']);
  assert.ok(!route.chain.includes('openai'));
  assert.equal(route.reason, 'restricted_data_local_only');
});

test('model run request has a deterministic idempotency key', () => {
  const first = makeRequest({ outputSchema: { required: ['summary', 'risks'] } });
  const second = makeRequest({ outputSchema: { required: ['summary', 'risks'] } });
  assert.equal(first.idempotency_key, second.idempotency_key);
});

test('model run request changes idempotency key when prompt changes', () => {
  const first = makeRequest();
  const second = makeRequest({ userPrompt: 'Assess a different change.' });
  assert.notEqual(first.idempotency_key, second.idempotency_key);
});

test('model run request changes idempotency key when reviewer model changes', () => {
  const first = makeRequest({ modelName: 'reviewer-a' });
  const second = makeRequest({ modelName: 'reviewer-b' });
  assert.notEqual(first.idempotency_key, second.idempotency_key);
});

test('model gateway uses the canonical authenticated control-plane endpoint', async () => {
  let captured;
  const result = await callModelGateway({
    gatewayUrl: 'https://control.example/',
    apiToken: 'server-token',
    modelRequest: makeRequest(),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => JSON.stringify({ output_artifact_ids: [] }) };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://control.example/api/bob/builder/model-run');
  assert.equal(captured.options.headers.Authorization, 'Bearer server-token');
});

test('model gateway reports malformed responses without leaking response text', async () => {
  const result = await callModelGateway({
    gatewayUrl: 'https://control.example',
    apiToken: 'server-token',
    modelRequest: makeRequest(),
    fetchImpl: async () => ({ ok: false, status: 502, text: async () => 'upstream secret text' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'model gateway returned malformed JSON');
  assert.doesNotMatch(JSON.stringify(result), /upstream secret text/);
});

function createSupabaseMock({ completed = null, insertError = null } = {}) {
  const writes = [];
  const storageWrites = [];
  const artifact = { id: 'artifact-1' };
  let uploadedBytes = Buffer.alloc(0);
  const query = {
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({ data: completed, error: null }),
    upsert(value) { writes.push({ type: 'upsert', value }); return this; },
    single: async () => ({ data: insertError ? null : { id: 'run-1' }, error: insertError }),
    update(value) { writes.push({ type: 'update', value }); return this; }
  };
  return {
    writes,
    storageWrites,
    client: {
      from: table => { assert.equal(table, 'builder_model_runs'); return query; },
      storage: {
        from: bucket => {
          assert.equal(bucket, 'builder-artifacts');
          return {
            upload: async (objectPath, bytes, options) => {
              uploadedBytes = Buffer.from(bytes);
              storageWrites.push({ type: 'upload', objectPath, options });
              return { error: null };
            },
            download: async objectPath => {
              storageWrites.push({ type: 'download', objectPath });
              return { data: { arrayBuffer: async () => uploadedBytes }, error: null };
            },
            remove: async paths => {
              storageWrites.push({ type: 'remove', paths });
              return { error: null };
            }
          };
        }
      },
      rpc: async (name, args) => {
        assert.equal(name, 'builder_finalize_model_artifact');
        writes.push({ type: 'rpc', args });
        return { data: artifact, error: null };
      }
    }
  };
}

test('artifact type is derived from builder mode and workload', () => {
  assert.equal(resolveArtifactType(makeRequest()), 'product_specification');
  assert.equal(resolveArtifactType(makeRequest({
    builderMode: 'qa_security_reviewer',
    workloadKind: 'security_review'
  })), 'security_review');
});

test('artifact metadata identifies JSON and computes its digest', () => {
  const metadata = contentMetadata('{"summary":"grounded"}');
  assert.equal(metadata.contentType, 'application/json');
  assert.equal(metadata.bytes.length, 22);
  assert.match(metadata.checksum, /^[a-f0-9]{64}$/);
});

test('model execution does not dispatch when provenance cannot be recorded', async () => {
  const mock = createSupabaseMock({ insertError: { message: 'db unavailable' } });
  let dispatched = false;
  const result = await executeBuilderModelRun({
    supabase: mock.client,
    modelRequest: makeRequest(),
    gateway: {
      gatewayUrl: 'https://control.example',
      apiToken: 'server-token',
      fetchImpl: async (url) => { if (String(url).endsWith('/model-run')) dispatched = true; return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(dispatched, false);
});

test('model execution returns completed duplicate without dispatch', async () => {
  const mock = createSupabaseMock({ completed: { id: 'run-existing', status: 'completed' } });
  let dispatched = false;
  const result = await executeBuilderModelRun({
    supabase: mock.client,
    modelRequest: makeRequest(),
    gateway: {
      gatewayUrl: 'https://control.example',
      apiToken: 'server-token',
      fetchImpl: async (url) => { if (String(url).endsWith('/model-run')) dispatched = true; return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; }
    }
  });

  assert.equal(result.duplicate, true);
  assert.equal(dispatched, false);
});

test('model execution does not redispatch a running idempotency key', async () => {
  const mock = createSupabaseMock({ completed: { id: 'run-existing', status: 'running' } });
  let dispatched = false;
  const result = await executeBuilderModelRun({
    supabase: mock.client,
    modelRequest: makeRequest(),
    gateway: {
      gatewayUrl: 'https://control.example',
      apiToken: 'server-token',
      fetchImpl: async (url) => { if (String(url).endsWith('/model-run')) dispatched = true; return { ok: false, status: 404, json: async () => ({}), text: async () => '' }; }
    }
  });

  assert.equal(result.status, 409);
  assert.equal(result.duplicate, true);
  assert.equal(dispatched, false);
});

test('model execution records usage and output artifacts', async () => {
  const mock = createSupabaseMock();
  const result = await executeBuilderModelRun({
    supabase: mock.client,
    modelRequest: makeRequest(),
    gateway: {
      gatewayUrl: 'https://control.example',
      apiToken: 'server-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'gpt-selected',
          content: '{"summary":"grounded"}',
          usage: { input_tokens: 10, output_tokens: 5 }
        })
      })
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data.output_artifact_ids, ['artifact-1']);
  const runningWrite = mock.writes.find(write => write.type === 'upsert');
  assert.equal(runningWrite.value.completed_at, null);
  assert.equal(runningWrite.value.error, null);
  assert.deepEqual(runningWrite.value.output_artifact_ids, []);
  assert.deepEqual(runningWrite.value.usage_metadata, {});
  assert.equal(mock.storageWrites[0].type, 'upload');
  const rpc = mock.writes.find(write => write.type === 'rpc');
  assert.equal(rpc.args._artifact_type, 'product_specification');
  assert.equal(rpc.args._model_name, 'gpt-selected');
  assert.deepEqual(rpc.args._usage_metadata, { input_tokens: 10, output_tokens: 5 });
});

test('artifact registration failure removes the unregistered storage object', async () => {
  const mock = createSupabaseMock();
  mock.client.rpc = async () => ({ data: null, error: { message: 'rpc failed' } });

  const result = await persistModelArtifact({
    supabase: mock.client,
    modelRunId: 'run-1',
    modelRequest: makeRequest(),
    gatewayData: { content: 'output', model: 'gpt-selected', usage: {} }
  });

  assert.equal(result.success, false);
  assert.equal(result.error, 'model artifact registration failed');
  assert.equal(mock.storageWrites.at(-1).type, 'remove');
});

test('invalid model output is rejected before artifact upload', async () => {
  const mock = createSupabaseMock();
  const result = await executeBuilderModelRun({
    supabase: mock.client,
    modelRequest: makeRequest(),
    gateway: {
      gatewayUrl: 'https://control.example',
      apiToken: 'server-token',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ model: 'gpt-selected', content: 'invalid' })
      })
    },
    validateOutput: () => { throw new Error('invalid shape'); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.equal(result.error, 'model output failed validation: invalid shape (output starts: invalid)');
  assert.equal(mock.storageWrites.length, 0);
  const update = mock.writes.find(write => write.type === 'update');
  assert.equal(update.value.status, 'failed');
  assert.match(update.value.error, /invalid shape/, 'the validator reason is persisted on the model run');
});
test('model execution walks the in-house-first chain and escalates to OpenAI only when a local provider is stuck', async () => {
  const { selectProviders } = require('../supabase/functions/_shared/builder-model-adapter.js');
  const previousReviewRoute = process.env.BOB_BUILDER_ROUTE_REVIEW;
  process.env.BOB_BUILDER_ROUTE_REVIEW = 'gpu_workstation,ollama,openai';
  let request;
  try {
    request = makeRequest({ workloadKind: 'independent_code_review', modelName: 'gpt-5.4-mini' });
  } finally {
    if (previousReviewRoute === undefined) delete process.env.BOB_BUILDER_ROUTE_REVIEW; else process.env.BOB_BUILDER_ROUTE_REVIEW = previousReviewRoute;
  }
  assert.deepEqual(request.chain, ['gpu_workstation', 'ollama', 'openai']);
  const health = {
    gpu_workstation: { configured: true, healthy: false, models: ['qwen2.5-coder:7b'], ready_model: null },
    ollama: { configured: true, healthy: true, models: ['llama3.1:8b'], ready_model: 'llama3.1:8b' },
    openai: { configured: true, healthy: true, models: ['gpt-5.4', 'gpt-5.4-mini'] }
  };
  // The laptop is off, so the chain starts at the VPS; the author identity is excluded for the reviewer.
  assert.deepEqual(selectProviders(request, { health }), [{ provider: 'ollama', model: 'llama3.1:8b' }, { provider: 'openai', model: 'gpt-5.4-mini' }]);
  assert.deepEqual(selectProviders(request, { health, avoid: [{ provider: 'ollama', model: 'llama3.1:8b' }] }), [{ provider: 'openai', model: 'gpt-5.4-mini' }]);
  // In-house independence: the VPS serves the reviewer from its next installed allowlisted model when
  // its default is the author's; an allowlisted-but-uninstalled alternative is not good enough.
  const vps = { ...health, ollama: { configured: true, healthy: true, models: ['qwen3-coder:30b', 'gpt-oss:20b', 'llama3.1:8b'], installed: ['qwen3-coder:30b', 'llama3.1:8b'], ready_model: 'qwen3-coder:30b' } };
  assert.deepEqual(selectProviders(request, { health: vps, avoid: [{ provider: 'ollama', model: 'qwen3-coder:30b' }] })[0], { provider: 'ollama', model: 'llama3.1:8b' });
  const vpsWithReviewer = { ...vps, ollama: { ...vps.ollama, installed: ['qwen3-coder:30b', 'gpt-oss:20b'] } };
  assert.deepEqual(selectProviders(request, { health: vpsWithReviewer, avoid: [{ provider: 'ollama', model: 'qwen3-coder:30b' }] })[0], { provider: 'ollama', model: 'gpt-oss:20b' });
  assert.deepEqual(selectProviders(request, { health, startAfter: 'ollama' }), [{ provider: 'openai', model: 'gpt-5.4-mini' }]);

  const mock = createSupabaseMock();
  const calls = [];
  const result = await executeBuilderModelRun({
    supabase: mock.client,
    modelRequest: request,
    gateway: {
      gatewayUrl: 'https://control.example',
      apiToken: 'server-token',
      health,
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ provider: body.provider, model: body.model, key: body.idempotency_key });
        if (body.provider === 'ollama') return { ok: false, status: 413, text: async () => JSON.stringify({ error: 'prompt exceeds the ollama context window (16384 tokens)', code: 'context_exceeded' }) };
        return { ok: true, status: 200, text: async () => JSON.stringify({ provider: 'openai', model: 'gpt-5.4-mini', content: '{"verdict":"passed"}', usage: {} }) };
      }
    },
    validateOutput: content => JSON.parse(content)
  });
  assert.equal(result.ok, true);
  assert.equal(result.escalated, true);
  assert.equal(result.provider, 'openai');
  assert.deepEqual(calls.map(c => c.provider), ['ollama', 'openai']);
  assert.equal(calls[0].key, request.idempotency_key, 'the first provider keeps the caller idempotency key');
  assert.equal(calls[1].key, `${request.idempotency_key}::openai`, 'an escalation is its own run record');
  assert.deepEqual(result.attempts.map(a => [a.provider, a.ok, a.status]), [['ollama', false, 413], ['openai', true, 200]]);
  const upserts = mock.writes.filter(w => w.type === 'upsert').map(w => [w.value.provider, w.value.model_name]);
  assert.deepEqual(upserts, [['ollama', 'llama3.1:8b'], ['openai', 'gpt-5.4-mini']]);
});

test('in-house providers get a longer gateway timeout than OpenAI, and an explicit gateway timeout wins', () => {
  const { gatewayTimeoutFor } = require('../supabase/functions/_shared/builder-model-adapter.js');
  assert.equal(gatewayTimeoutFor('openai', {}, {}), 90000);
  // A cold CPU load alone took ~100 s live (job 73560f1c); 90 s read "slow" as "stuck".
  assert.equal(gatewayTimeoutFor('ollama', {}, {}), 420000);
  assert.equal(gatewayTimeoutFor('gpu_workstation', {}, {}), 420000);
  assert.equal(gatewayTimeoutFor('ollama', {}, { BOB_LOCAL_MODEL_TIMEOUT_MS: '300000' }), 300000);
  assert.equal(gatewayTimeoutFor('ollama', { timeoutMs: 15000 }, {}), 15000);
  assert.equal(gatewayTimeoutFor('openai', { timeoutMs: 'nope' }, {}), 90000);
});

test('model gateway retries a dropped connection once and names the cause; timeouts are not retried', async () => {
  let calls = 0;
  const result = await callModelGateway({
    gatewayUrl: 'https://control.example',
    apiToken: 'server-token',
    modelRequest: makeRequest(),
    fetchImpl: async () => {
      calls++;
      if (calls === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return { ok: true, status: 200, text: async () => JSON.stringify({ content: 'hi' }) };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);

  let calls2 = 0;
  const dead = await callModelGateway({
    gatewayUrl: 'https://control.example',
    apiToken: 'server-token',
    modelRequest: makeRequest(),
    fetchImpl: async () => { calls2++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }
  });
  assert.equal(calls2, 2);
  assert.equal(dead.ok, false);
  assert.equal(dead.status, 502);
  assert.equal(dead.error, 'model gateway unavailable (ECONNREFUSED)');

  let calls3 = 0;
  const slow = await callModelGateway({
    gatewayUrl: 'https://control.example',
    apiToken: 'server-token',
    modelRequest: makeRequest(),
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => { calls3++; return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))); }
  });
  assert.equal(calls3, 1, 'a timeout is the model being slow, not the socket dropping');
  assert.equal(slow.ok, false);
  assert.equal(slow.timeout, true);
});

test('restricted data never reaches Ollama Cloud or OpenAI, even when the environment asks for them', () => {
  const pinned = routeBuilderModel({ workloadKind: 'architecture', containsRestrictedData: true, env: { BOB_BUILDER_ROUTE_RESTRICTED: 'ollama_cloud,gpu_workstation,openai' } });
  assert.deepEqual(pinned.chain, ['gpu_workstation']);
  const externalOnly = routeBuilderModel({ workloadKind: 'architecture', containsRestrictedData: true, env: { BOB_BUILDER_ROUTE_RESTRICTED: 'ollama_cloud,openai' } });
  assert.deepEqual(externalOnly.chain, ['ollama', 'gpu_workstation'], 'an all-external pin falls back to local-only, never to an empty or external chain');
});

test('Ollama Cloud sits after in-house compute and before paid OpenAI', () => {
  const chain = routeBuilderModel({ workloadKind: 'frontend_implementation' }).chain;
  assert.ok(chain.indexOf('ollama_cloud') > chain.indexOf('ollama'));
  assert.ok(chain.indexOf('ollama_cloud') < chain.indexOf('openai'));
});
