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

test('model routing keeps low-risk preprocessing local', () => {
  assert.equal(routeBuilderModel({ workloadKind: 'repository_summary' }).provider, 'ollama');
});

test('model routing sends complex builder work to OpenAI', () => {
  assert.equal(routeBuilderModel({ workloadKind: 'architecture' }).provider, 'openai');
});

test('model routing keeps restricted data local regardless of workload', () => {
  const route = routeBuilderModel({ workloadKind: 'architecture', containsRestrictedData: true });
  assert.equal(route.provider, 'ollama');
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
      fetchImpl: async () => { dispatched = true; }
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
      fetchImpl: async () => { dispatched = true; }
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
      fetchImpl: async () => { dispatched = true; }
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
  assert.equal(result.error, 'model output failed validation');
  assert.equal(mock.storageWrites.length, 0);
  const update = mock.writes.find(write => write.type === 'update');
  assert.equal(update.value.status, 'failed');
});