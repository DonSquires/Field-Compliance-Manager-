const assert = require('node:assert/strict');
const test = require('node:test');

const {
  approvalTypeForStatus,
  requestBuilderApproval,
  decideBuilderApproval
} = require('../supabase/functions/_shared/builder-approval.js');

test('approval type maps only persisted gate states', () => {
  assert.equal(approvalTypeForStatus('specification_ready'), 'specification_review');
  assert.equal(approvalTypeForStatus('approval_pending'), 'release_approval');
  assert.equal(approvalTypeForStatus('testing'), null);
});

test('approval request uses the guarded RPC with reviewed artifacts', async () => {
  let call;
  const supabase = {
    rpc: async (name, args) => {
      call = { name, args };
      return { data: { id: 'approval-1' }, error: null };
    }
  };
  const result = await requestBuilderApproval(supabase, {
    jobId: 'job-1',
    status: 'specification_ready',
    artifactIds: ['artifact-1'],
    requestedFromUsers: ['user-1']
  });

  assert.equal(result.success, true);
  assert.equal(call.name, 'builder_request_approval');
  assert.deepEqual(call.args, {
    _job_id: 'job-1',
    _approval_type: 'specification_review',
    _artifact_ids: ['artifact-1'],
    _requested_from_users: ['user-1']
  });
});

test('approval request rejects non-gate states before RPC dispatch', async () => {
  let called = false;
  const supabase = { rpc: async () => { called = true; } };
  await assert.rejects(
    requestBuilderApproval(supabase, { jobId: 'job-1', status: 'testing', artifactIds: ['artifact-1'] }),
    /not at an approval gate/
  );
  assert.equal(called, false);
});

test('approval decision uses the authenticated guarded RPC', async () => {
  let call;
  const supabase = {
    rpc: async (name, args) => {
      call = { name, args };
      return { data: { id: 'job-1', status: 'release_ready' }, error: null };
    }
  };
  const result = await decideBuilderApproval(supabase, {
    approvalId: 'approval-1',
    decision: 'approved',
    comment: 'Reviewed'
  });

  assert.equal(result.success, true);
  assert.equal(call.name, 'builder_decide_approval');
  assert.deepEqual(call.args, {
    _approval_id: 'approval-1',
    _decision: 'approved',
    _comment: 'Reviewed'
  });
});