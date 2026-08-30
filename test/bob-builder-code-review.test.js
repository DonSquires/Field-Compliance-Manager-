const assert = require('node:assert/strict');
const test = require('node:test');

const { setCodeReviewPolicy, startOptionalCodeReview, decideHumanCodeReview } = require('../supabase/functions/_shared/builder-code-review');

test('code review policy uses the authenticated policy RPC', async () => {
  let call;
  const supabase = { rpc: async (name, args) => { call = { name, args }; return { data: { code_review_mode: 'independent_ai' }, error: null }; } };
  const result = await setCodeReviewPolicy(supabase, 'job-1', 'independent_ai');
  assert.equal(result.success, true);
  assert.deepEqual(call, { name: 'builder_set_code_review_policy', args: { _job_id: 'job-1', _mode: 'independent_ai' } });
});

test('optional review start snapshots verified evidence', async () => {
  let call;
  const supabase = { rpc: async (name, args) => { call = { name, args }; return { data: { mode: 'human' }, error: null }; } };
  await startOptionalCodeReview(supabase, { jobId: 'job-1', stepId: 'step-1', artifactIds: ['a', 'b'], requestedFromUsers: ['user-1'] });
  assert.equal(call.name, 'builder_start_code_review');
  assert.deepEqual(call.args._reviewed_artifact_ids, ['a', 'b']);
});

test('human code review decision uses its dedicated authenticated RPC', async () => {
  let call;
  const supabase = { rpc: async (name, args) => { call = { name, args }; return { data: { code_review_status: 'passed' }, error: null }; } };
  const result = await decideHumanCodeReview(supabase, 'approval-1', 'approved', 'Reviewed');
  assert.equal(result.success, true);
  assert.equal(call.name, 'builder_decide_human_code_review');
});