const {
  buildModelRunRequest,
  executeBuilderModelRun
} = require('./builder-model-adapter');
const { downloadVerifiedArtifact } = require('../../../builder-frontend-handoff');

const INDEPENDENT_CODE_REVIEW_PROMPT_VERSION = 'independent-code-review-v1';

function artifactList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

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
  const patchArtifacts = artifactList(artifacts.patch);
  const manifestArtifacts = artifactList(artifacts.manifest);
  const buildLogArtifacts = artifactList(artifacts.buildLogs);
  if (patchArtifacts.length === 0 || patchArtifacts.length > 2
      || patchArtifacts.length !== manifestArtifacts.length || patchArtifacts.length !== buildLogArtifacts.length) {
    throw new Error('one or two complete implementation artifact sets are required');
  }
  const [patches, manifests, buildLogs, security] = await Promise.all([
    Promise.all(patchArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'code_implementation'))),
    Promise.all(manifestArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'changed_file_manifest'))),
    Promise.all(buildLogArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'build_logs'))),
    downloadVerifiedArtifact(supabase, artifacts.security.id, job.id, 'security_review')
  ]);
  return {
    patches: patches.map(patch => patch.bytes.toString('utf8')),
    manifests: manifests.map(manifest => JSON.parse(manifest.bytes.toString('utf8'))),
    buildLogs: buildLogs.map(log => JSON.parse(log.bytes.toString('utf8'))),
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

async function abortIndependentCodeReview(supabase, jobId, stepId, reason) {
  const { error } = await supabase.rpc('builder_abort_independent_code_review', {
    _job_id: jobId,
    _step_id: stepId,
    _reason: reason
  });
  return { success: !error };
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
  completeReview = completeIndependentCodeReview,
  abortReview = abortIndependentCodeReview
}) {
  if (!job?.id || !job?.organization_id || !job?.target_sha || job.code_review_mode !== 'independent_ai') {
    throw new Error('independent AI review job is required');
  }
  if (!step?.id || step.step_id !== 'code_review' || step.builder_mode !== 'code_reviewer') throw new Error('code review step is required');
  if (!reviewerModelName) throw new Error('independent reviewer model is required');
  const artifactIds = [
    ...artifactList(artifacts.patch).map(artifact => artifact.id),
    ...artifactList(artifacts.manifest).map(artifact => artifact.id),
    ...artifactList(artifacts.buildLogs).map(artifact => artifact.id),
    artifacts.security.id
  ];
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
  if (!result.ok) {
    await abortReview(supabase, job.id, step.id, result.error || 'Independent reviewer failed');
    return { ...result, review: null };
  }
  const completion = await completeReview(supabase, {
    jobId: job.id,
    stepId: step.id,
    modelRunId: result.model_run_id,
    artifactId: result.artifact.id,
    verdict: result.validated_output.verdict
  });
  if (!completion.success) {
    await abortReview(supabase, job.id, step.id, completion.error);
    return { ...result, ok: false, status: 503, error: completion.error };
  }
  return { ...result, review: result.validated_output, job: completion.job };
}

module.exports = {
  INDEPENDENT_CODE_REVIEW_PROMPT_VERSION,
  artifactList,
  parseIndependentCodeReview,
  loadCodeReviewEvidence,
  startCodeReview,
  completeIndependentCodeReview,
  abortIndependentCodeReview,
  runIndependentCodeReview
};