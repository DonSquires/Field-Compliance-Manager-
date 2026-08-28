const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorkflowClient } = require('../supabase-workflow-client');

test('remote workflow client forwards authenticated RPC payloads', async () => {
  const calls = [];
  const client = createWorkflowClient({
    url: 'https://example.supabase.co/',
    serviceRoleKey: 'server-only-test-key',
    mode: 'remote',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ id: 'job-1', state: 'draft' }); }
      };
    }
  });

  const result = await client.transitionJobState({
    job_id: 'job-1',
    to_state: 'verify_pending',
    actor_type: 'system',
    reason: 'runner completed'
  });

  assert.deepEqual(result, { id: 'job-1', state: 'draft' });
  assert.equal(calls[0].url, 'https://example.supabase.co/functions/v1/wf-transition-job-state');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer server-only-test-key');
  assert.equal(calls[0].options.headers.apikey, 'server-only-test-key');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    job_id: 'job-1',
    to_state: 'verify_pending',
    actor_type: 'system',
    reason: 'runner completed'
  });
});

test('remote workflow mode fails closed without server credentials', () => {
  assert.throws(() => createWorkflowClient({ mode: 'remote' }), /SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/);
});
