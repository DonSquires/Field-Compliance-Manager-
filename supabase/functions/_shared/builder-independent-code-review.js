const {
  buildModelRunRequest,
  executeBuilderModelRun
} = require('./builder-model-adapter');
const { downloadVerifiedArtifact } = require('../../../builder-frontend-handoff');

const INDEPENDENT_CODE_REVIEW_PROMPT_VERSION = 'independent-code-review-v1';

function parseIndependentCodeReview(content) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('independent code review is empty');
  let report;
  try {
    report = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new Error('independent code review must be valid JSON');
  }
  if (!['passed', 'blocked'].includes(report.verdict)) throw new Error('independent code review verdict is invalid');
  if (typeof report.summary !== 'string' || !report.summary.trim()) throw new Error('independent code review summary is required');
  for (const key of ['findings', 'test_gaps', 'residual_risks']) {
    if (!Array.isArray(report[key])) throw new Error(`${key} must be an array`);
  }
  for (const finding of report.findings) {
    if (!['critical', 'high', 'medium', 'low'].includes(finding?.severity)) throw new Error('independent code review finding severity is invalid');
    if (typeof finding.file !== 'string' || typeof finding.message !== 'string') throw new Error('independent code review finding is incomplete');
  }
  const hasBlocking = report.findings.some(finding => ['critical', 'high'].includes(finding.severity));
  if ((report.verdict === 'passed') === hasBlocking) throw new Error('independent code review verdict conflicts with findings');
  return report;
}

async function loadCodeReviewEvidence({ supabase, job, artifacts }) {
  const [patch, manifest, buildLogs, security] = await Promise.all([
    downloadVerifiedArtifact(supabase, artifacts.patch.id, job.id, 'code_implementation'),
    downloadVerifiedArtifact(supabase, artifacts.manifest.id, job.id, 'changed_file_manifest'),
    downloadVerifiedArtifact(supabase, artifacts.buildLogs.id, job.id, 'build_logs'),
    downloadVerifiedArtifact(supabase, artifacts.security.id, job.id, 'security_review')
  ]);
  return {
    patch: patch.bytes.toString('utf8'),
    manifest: JSON.parse(manifest.bytes.toString('utf8')),
    buildLogs: JSON.parse(buildLogs.bytes.toString('utf8')),
    security: JSON.parse(security.bytes.toString('utf8'))
  };
}

async function startCodeReview(supabase, jobId, stepId, artifactIds, requestedFromUsers = []) {
  const { data, error } = await supabase.rpc('builder_start_code_review', {
    _job_id: jobId,
    _step_id: stepId,
    _reviewed_artifact_ids: artifactIds,
    _requested_from_users: requestedFromUsers
  });
  if (error) return { success: false, error: 'optional code review could not be started' };
  return { success: true, ...data };
}

async function completeIndependentCodeReview(supabase, input) {
  const { data, error } = await supabase.rpc('builder_complete_independent_code_review', {
    _job_id: input.jobId,
    _step_id: input.stepId,
    _reviewer_model_run_id: input.modelRunId,
    _review_artifact_id: input.artifactId,
    _verdict: input.verdict
  });
  if (error) return { success: false, error: 'independent code review could not be completed' };
  return { success: true, job: data };
}

async function runIndependentCodeReview({
  supabase,
  gateway,
  job,
  step,
  artifacts,
  reviewerModelName,
  loadEvidence = loadCodeReviewEvidence,
  startReview = startCodeReview,
  executeModelRun = executeBuilderModelRun,
  completeReview = completeIndependentCodeReview
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha || job.code_review_mode !== 'independent_ai') {
    throw new Error('independent AI review job is required');
  }
  if (!step?.id || step.step_id !== 'code_review' || step.builder_mode !== 'code_reviewer') throw new Error('code review step is required');
  if (!reviewerModelName) throw new Error('independent reviewer model is required');
  const artifactIds = [artifacts.patch.id, artifacts.manifest.id, artifacts.buildLogs.id, artifacts.security.id];
  const started = await startReview(supabase, job.id, step.id, artifactIds);
  if (!started.success) return { ok: false, status: 409, error: started.error };
  const evidence = await loadEvidence({ supabase, job, artifacts });
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'code_reviewer',
    workloadKind: 'independent_code_review',
    promptVersion: INDEPENDENT_CODE_REVIEW_PROMPT_VERSION,
    modelName: reviewerModelName,
    systemPrompt: [
      'You are an independent coding AI reviewer for Field Compliance Manager.',
      'Review correctness, regressions, tenant isolation, authorization assumptions, data exposure, and missing tests.',
      'You can recommend passed or blocked. You have no approval, merge, deployment, or code-modification authority.',
      'Use only the verified patch, manifest, build logs, and security report. Return JSON only.'
    ].join(' '),
    userPrompt: JSON.stringify(evidence),
    inputArtifactIds: artifactIds,
    outputSchema: { type: 'object', required: ['verdict', 'summary', 'findings', 'test_gaps', 'residual_risks'] }
  });
  const result = await executeModelRun({ supabase, gateway, modelRequest, validateOutput: parseIndependentCodeReview });
  if (!result.ok) return { ...result, review: null };
  const completion = await completeReview(supabase, {
    jobId: job.id,
    stepId: step.id,
    modelRunId: result.model_run_id,
    artifactId: result.artifact.id,
    verdict: result.validated_output.verdict
  });
  if (!completion.success) return { ...result, ok: false, status: 503, error: completion.error };
  return { ...result, review: result.validated_output, job: completion.job };
}

module.exports = {
  INDEPENDENT_CODE_REVIEW_PROMPT_VERSION,
  parseIndependentCodeReview,
  loadCodeReviewEvidence,
  startCodeReview,
  completeIndependentCodeReview,
  runIndependentCodeReview
};