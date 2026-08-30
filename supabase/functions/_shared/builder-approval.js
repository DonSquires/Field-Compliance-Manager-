function approvalTypeForStatus(status) {
  if (status === 'specification_ready') return 'specification_review';
  if (status === 'approval_pending') return 'release_approval';
  return null;
}

async function requestBuilderApproval(supabase, {
  jobId,
  status,
  artifactIds,
  requestedFromUsers = []
}) {
  if (!supabase || !jobId) throw new Error('supabase and jobId are required');
  const approvalType = approvalTypeForStatus(status);
  if (!approvalType) throw new Error('job is not at an approval gate');
  if (!Array.isArray(artifactIds) || artifactIds.length === 0) {
    throw new Error('at least one review artifact is required');
  }

  const { data, error } = await supabase.rpc('builder_request_approval', {
    _job_id: jobId,
    _approval_type: approvalType,
    _artifact_ids: artifactIds,
    _requested_from_users: requestedFromUsers
  });
  if (error) return { success: false, error: 'approval request failed' };
  return { success: true, approval: data };
}

async function decideBuilderApproval(supabase, {
  approvalId,
  decision,
  comment = null
}) {
  if (!supabase || !approvalId) throw new Error('supabase and approvalId are required');
  if (!['approved', 'rejected'].includes(decision)) {
    throw new Error('decision must be approved or rejected');
  }

  const { data, error } = await supabase.rpc('builder_decide_approval', {
    _approval_id: approvalId,
    _decision: decision,
    _comment: comment
  });
  if (error) return { success: false, error: 'approval decision failed' };
  return { success: true, job: data };
}

module.exports = {
  approvalTypeForStatus,
  requestBuilderApproval,
  decideBuilderApproval
};