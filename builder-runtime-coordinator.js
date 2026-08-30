const { runProductAnalyst } = require('./supabase/functions/_shared/builder-product-analyst');
const { runUxDesigner } = require('./supabase/functions/_shared/builder-ux-designer');
const { runFrontendImplementation } = require('./builder-frontend-orchestrator');
const { runBackendEngineer } = require('./supabase/functions/_shared/builder-backend-engineer');
const { runBackendHandoff } = require('./builder-backend-handoff');
const { runSecurityReview } = require('./builder-security-handoff');
const { startOptionalCodeReview } = require('./supabase/functions/_shared/builder-code-review');
const { runIndependentCodeReview } = require('./supabase/functions/_shared/builder-independent-code-review');
const { runReleaseEngineer } = require('./supabase/functions/_shared/builder-release-engineer');

const TERMINAL_STATUSES = new Set(['release_ready', 'deployed', 'failed', 'cancelled']);
const APPROVAL_STATUSES = new Set(['specification_ready', 'approval_pending']);

function byStep(snapshot, stepId) {
  return snapshot.steps.find(step => step.step_id === stepId);
}

function artifactsFor(snapshot, stepId, artifactType) {
  const step = byStep(snapshot, stepId);
  return snapshot.artifacts.filter(artifact => artifact.step_id === step?.id && artifact.artifact_type === artifactType && artifact.status === 'final');
}

function implementationRuns(snapshot) {
  const modes = new Set(['frontend_engineer', 'backend_engineer']);
  const stepIds = new Set(snapshot.steps.filter(step => modes.has(step.builder_mode) && step.status === 'completed').map(step => step.id));
  return snapshot.workerRuns.filter(run => stepIds.has(run.step_id) && run.status === 'completed' && ['frontend-verify', 'backend-verify'].includes(run.profile));
}

function stepIsRunnable(step) {
  return step?.status === 'pending' || (step?.status === 'failed' && step.retryable === true);
}

function planBuilderAction(snapshot) {
  const { job } = snapshot;
  if (!job?.id) throw new Error('Builder runtime snapshot is missing a job');
  if (TERMINAL_STATUSES.has(job.status)) return { type: 'terminal', status: job.status };
  if (APPROVAL_STATUSES.has(job.status)) return { type: 'waiting_for_human', status: job.status };
  if (snapshot.workerRuns.some(run => run.status === 'running')) return { type: 'waiting_for_worker' };

  const product = byStep(snapshot, 'product_analysis');
  if (['intake', 'analysis_pending'].includes(job.status) && stepIsRunnable(product)) {
    return { type: 'run_product_analysis', step: product };
  }
  const ux = byStep(snapshot, 'ui_design');
  if (job.status === 'design_pending' && stepIsRunnable(ux)) return { type: 'run_ux_design', step: ux };
  if (job.status === 'design_pending' && ux?.status === 'skipped' && !job.frontend_required && job.backend_required) {
    return { type: 'continue_backend_only', step: ux };
  }
  if (job.status === 'implementation_pending') {
    const frontend = byStep(snapshot, 'frontend_implementation');
    if (stepIsRunnable(frontend)) return { type: 'run_frontend', step: frontend };
    const backend = byStep(snapshot, 'backend_implementation');
    if (stepIsRunnable(backend)) return { type: 'run_backend', step: backend };
  }
  if (job.status === 'testing') return { type: 'run_security_review', step: byStep(snapshot, 'security_review') };
  if (job.status === 'security_review') {
    const security = byStep(snapshot, 'security_review');
    if (security?.status !== 'completed') return { type: 'run_security_review', step: security };
    const review = byStep(snapshot, 'code_review');
    if (stepIsRunnable(review)) {
      if (job.code_review_mode === 'independent_ai') return { type: 'run_independent_review', step: review };
      return { type: 'start_optional_review', step: review, mode: job.code_review_mode || 'none' };
    }
    if (review?.status === 'running') return { type: 'waiting_for_human', status: 'implementation_review' };
    const release = byStep(snapshot, 'release_prep');
    if (stepIsRunnable(release)) return { type: 'run_release', step: release };
  }
  return { type: 'blocked', status: job.status };
}

async function loadBuilderRuntimeSnapshot(supabase, jobId) {
  const [jobResult, stepsResult, artifactsResult, runsResult] = await Promise.all([
    supabase.from('builder_jobs').select('*').eq('id', jobId).single(),
    supabase.from('builder_job_steps').select('*').eq('job_id', jobId).order('ordinal_position'),
    supabase.from('builder_artifacts').select('*').eq('job_id', jobId).order('created_at'),
    supabase.from('builder_worker_runs').select('*').eq('job_id', jobId).order('started_at')
  ]);
  if (jobResult.error || !jobResult.data) throw new Error('Builder job could not be loaded');
  for (const result of [stepsResult, artifactsResult, runsResult]) {
    if (result.error) throw new Error('Builder runtime evidence could not be loaded');
  }
  return { job: jobResult.data, steps: stepsResult.data || [], artifacts: artifactsResult.data || [], workerRuns: runsResult.data || [] };
}

function implementationArtifacts(snapshot) {
  const patches = [];
  const manifests = [];
  const buildLogs = [];
  for (const stepId of ['frontend_implementation', 'backend_implementation']) {
    patches.push(...artifactsFor(snapshot, stepId, 'code_implementation'));
    manifests.push(...artifactsFor(snapshot, stepId, 'changed_file_manifest'));
    buildLogs.push(...artifactsFor(snapshot, stepId, 'build_logs'));
  }
  return { patch: patches, manifest: manifests, buildLogs };
}

async function runBackendImplementation(input) {
  const generation = await runBackendEngineer(input);
  if (!generation.ok || !generation.patch_artifact?.id) return { success: false, phase: 'generation', result: generation };
  return runBackendHandoff({ ...input, patchArtifact: generation.patch_artifact });
}

async function executeBuilderAction({ snapshot, action, supabase, gateway, context, handlers = {} }) {
  const run = {
    product: handlers.product || runProductAnalyst,
    ux: handlers.ux || runUxDesigner,
    frontend: handlers.frontend || runFrontendImplementation,
    backend: handlers.backend || runBackendImplementation,
    security: handlers.security || runSecurityReview,
    optionalReview: handlers.optionalReview || startOptionalCodeReview,
    independentReview: handlers.independentReview || runIndependentCodeReview,
    release: handlers.release || runReleaseEngineer
  };
  const common = { supabase, gateway, job: snapshot.job, step: action.step };
  if (action.type === 'continue_backend_only') {
    const { data, error } = await supabase.rpc('builder_continue_backend_only_job', { _job_id: snapshot.job.id });
    if (error) throw new Error('Backend-only job could not advance');
    return { success: true, job: data };
  }
  if (action.type === 'run_product_analysis') return run.product({ ...common, repositoryContext: context.repositoryContext, constraints: context.constraints, requestedFromUsers: context.requestedFromUsers });
  if (action.type === 'run_ux_design') return run.ux({ ...common, specificationArtifact: artifactsFor(snapshot, 'product_analysis', 'product_specification').at(-1), repositoryContext: context.designContext });
  if (action.type === 'run_frontend') return run.frontend({ ...common, uxArtifact: artifactsFor(snapshot, 'ui_design', 'ui_design_plan').at(-1), sourceDir: context.sourceDir, requestedFiles: context.frontendFiles, workerImage: context.workerImage, runnerId: context.runnerId });
  if (action.type === 'run_backend') return run.backend({ ...common, productArtifact: artifactsFor(snapshot, 'product_analysis', 'product_specification').at(-1), sourceDir: context.sourceDir, requestedFiles: context.backendFiles, workerImage: context.workerImage, runnerId: context.runnerId });
  const implementation = implementationArtifacts(snapshot);
  const runs = implementationRuns(snapshot);
  const securityArtifact = artifactsFor(snapshot, 'security_review', 'security_review').at(-1);
  if (action.type === 'run_security_review') return run.security({ ...common, securityStep: action.step, implementationWorkerRunIds: runs.map(item => item.id), sourceDir: context.sourceDir, workerImage: context.workerImage, runnerId: context.runnerId });
  if (action.type === 'start_optional_review') return run.optionalReview(supabase, { jobId: snapshot.job.id, stepId: action.step.id, artifactIds: [...implementation.patch, ...implementation.manifest, ...implementation.buildLogs, securityArtifact].filter(Boolean).map(item => item.id), requestedFromUsers: context.requestedFromUsers });
  if (action.type === 'run_independent_review') return run.independentReview({ ...common, artifacts: { ...implementation, security: securityArtifact }, reviewerModelName: context.reviewerModelName });
  if (action.type === 'run_release') return run.release({ ...common, artifacts: { ...implementation, securityReview: securityArtifact, codeReview: artifactsFor(snapshot, 'code_review', 'code_review').at(-1) }, securityWorkerRunId: snapshot.workerRuns.filter(item => item.profile === 'security-review' && item.status === 'completed').at(-1)?.id, requestedFromUsers: context.requestedFromUsers });
  return action;
}

async function advanceBuilderJob({ supabase, gateway, jobId, context, handlers, loadSnapshot = loadBuilderRuntimeSnapshot }) {
  const snapshot = await loadSnapshot(supabase, jobId);
  const action = planBuilderAction(snapshot);
  if (['terminal', 'waiting_for_human', 'waiting_for_worker', 'blocked'].includes(action.type)) return { advanced: false, action, snapshot };
  const result = await executeBuilderAction({ snapshot, action, supabase, gateway, context, handlers });
  return { advanced: true, action, result };
}

async function runBuilderUntilPause({
  supabase,
  gateway,
  jobId,
  context,
  handlers,
  loadSnapshot = loadBuilderRuntimeSnapshot,
  maxActions = 8
}) {
  const limit = Math.max(1, Math.min(Number(maxActions) || 1, 8));
  const history = [];
  for (let index = 0; index < limit; index += 1) {
    const outcome = await advanceBuilderJob({ supabase, gateway, jobId, context, handlers, loadSnapshot });
    history.push({ action: outcome.action, advanced: outcome.advanced });
    if (!outcome.advanced) return { paused: true, reason: outcome.action.type, history, snapshot: outcome.snapshot };
    if (outcome.result?.ok === false || outcome.result?.success === false) {
      return { paused: true, reason: 'action_failed', history, result: outcome.result };
    }
  }
  return { paused: true, reason: 'action_limit', history };
}

module.exports = {
  artifactsFor,
  implementationRuns,
  implementationArtifacts,
  stepIsRunnable,
  planBuilderAction,
  loadBuilderRuntimeSnapshot,
  runBackendImplementation,
  executeBuilderAction,
  advanceBuilderJob,
  runBuilderUntilPause
};