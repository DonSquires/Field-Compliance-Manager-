async function setCodeReviewPolicy(supabase, jobId, mode) {
  if (!['none', 'human', 'independent_ai'].includes(mode)) throw new Error('unsupported code review mode');
  const { data, error } = await supabase.rpc('builder_set_code_review_policy', {
    _job_id: jobId,
    _mode: mode
  });
  if (error) return { success: false, error: 'code review policy could not be set' };
  return { success: true, job: data };
}

async function startOptionalCodeReview(supabase, input) {
  const { data, error } = await supabase.rpc('builder_start_code_review', {
    _job_id: input.jobId,
    _step_id: input.stepId,
    _reviewed_artifact_ids: input.artifactIds,
    _requested_from_users: input.requestedFromUsers || []
  });
  if (error) return { success: false, error: 'optional code review could not be started' };
  return { success: true, review: data };
}

async function decideHumanCodeReview(supabase, approvalId, decision, comment = null) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('invalid human code review decision');
  const { data, error } = await supabase.rpc('builder_decide_human_code_review', {
    _approval_id: approvalId,
    _decision: decision,
    _comment: comment
  });
  if (error) return { success: false, error: 'human code review decision failed' };
  return { success: true, job: data };
}

module.exports = {
  setCodeReviewPolicy,
  startOptionalCodeReview,
  decideHumanCodeReview
};