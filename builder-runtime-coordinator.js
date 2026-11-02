const { runProductAnalyst } = require('./supabase/functions/_shared/builder-product-analyst');
const { runUxDesigner } = require('./supabase/functions/_shared/builder-ux-designer');
const { runFrontendImplementation, reloadFrontendStep } = require('./builder-frontend-orchestrator');
const { runBackendEngineer } = require('./supabase/functions/_shared/builder-backend-engineer');
const { runBackendHandoff } = require('./builder-backend-handoff');
const { runSecurityReview } = require('./builder-security-handoff');
const { startOptionalCodeReview } = require('./supabase/functions/_shared/builder-code-review');
const { runIndependentCodeReview } = require('./supabase/functions/_shared/builder-independent-code-review');
const { runReleaseEngineer } = require('./supabase/functions/_shared/builder-release-engineer');
const { runAgenticEngineer } = require('./builder-agentic-engineer');
const { loadCodeReviewSeed } = require('./builder-artifact-read');
const { recordGenerationFailure, skipLaneWithNothingToDo } = require('./builder-generation-failure');
const { downloadVerifiedArtifact } = require('./builder-frontend-handoff');
const { unwrapPatchArtifact } = require('./supabase/functions/_shared/builder-patch-envelope');
const { EXTERNAL_PROVIDERS } = require('./supabase/functions/_shared/builder-model-adapter');
const { accountVerifierRecoveries } = require('./builder-verifier-recovery');
const { laneFor, normalizeRepoPath } = require('./builder-path-policy');
const { checkImplementationAcceptance } = require('./builder-implementation-acceptance');

const TERMINAL_STATUSES = new Set(['release_ready', 'deployed', 'failed', 'cancelled']);
const APPROVAL_STATUSES = new Set(['specification_ready', 'approval_pending']);
const MAX_BACKEND_ATTEMPTS = 3;
// attempt_count is persisted by the start RPCs, so this ceiling holds across `run` calls: a
// failed step that has already been started this many times is a systemic failure that needs
// a human (fix the cause, then a follow-up job), not another model run. Job 5ba292f4 burned
// eight full engineer runs against a broken worker image before this existed.
const MAX_STEP_ATTEMPTS = Math.max(1, Number(process.env.BOB_BUILDER_MAX_STEP_ATTEMPTS) || 6);
// Bob works the implementation steps as a coding agent (explore → edit → test →
// iterate) unless explicitly switched back to the one-shot engineers.
const AGENTIC_ENABLED = process.env.BOB_BUILDER_AGENTIC !== 'false';

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
  const superseded = new Set(snapshot.artifacts.filter(artifact => artifact.status === 'superseded').map(artifact => artifact.id));
  return snapshot.workerRuns.filter(run => stepIds.has(run.step_id) && run.status === 'completed'
    && !superseded.has(run.patch_artifact_id) && ['frontend-verify', 'backend-verify'].includes(run.profile));
}

function attemptCeilingReached(step) {
  return step?.status === 'failed' && Number(step.attempt_count) >= MAX_STEP_ATTEMPTS;
}

function ownerConfirmedVerifierRetryAtCeiling(snapshot, step) {
  const context = step?.input_context;
  const attempt = Number(context?.owner_patch_retry_attempt_count);
  return step?.step_id === 'frontend_implementation' && step.status === 'failed' && step.retryable === true
    && String(step.error || '').startsWith('Verifier recovery pending: owner-confirmed saved patch verification')
    && typeof context?.owner_patch_retry_receipt === 'string'
    && Number.isInteger(attempt) && attempt === Number(step.attempt_count)
    && typeof context?.patch_artifact_id === 'string' && context.target_sha === snapshot?.job?.target_sha
    && snapshot.artifacts.some(artifact => artifact.id === context.patch_artifact_id
      && artifact.step_id === step.id && artifact.artifact_type === 'code_implementation' && artifact.status === 'final');
}

function stepIsRunnable(step) {
  return step?.status === 'pending' || (step?.status === 'failed' && step.retryable === true && !attemptCeilingReached(step) && !/^Evidence conflict:/.test(step.error || ''));
}

function attemptCeilingBlock(job, step) {
  const last = String(step.error || '').replace(/^(generation|repair|baseline): /, '').slice(0, 600);
  return { type: 'blocked', status: job.status, reason: 'attempt_ceiling', step_id: step.step_id, attempts: Number(step.attempt_count) || 0, limit: MAX_STEP_ATTEMPTS, detail: `${step.step_id} failed ${step.attempt_count} times (ceiling ${MAX_STEP_ATTEMPTS})${last ? `; last failure: ${last}` : ''}` };
}

// A failed step nobody may retry (the author declined with a reason) blocks the job with that reason.
function parkedStep(step) {
  return step?.status === 'failed' && step.retryable === false;
}

function parkedStepBlock(job, step) {
  return { type: 'blocked', status: job.status, reason: 'blocked', step_id: step.step_id, detail: String(step.error || `${step.step_id} was declined by the author`).replace(/^(generation|repair|baseline): /, '').slice(0, 1000) };
}

function planBuilderAction(snapshot) {
  const { job } = snapshot;
  if (!job?.id) throw new Error('Builder runtime snapshot is missing a job');
  if (job.autopilot_report?.resumed_as_job_id) return {
    type: 'terminal', status: job.status, reason: 'superseded',
    detail: `This attempt was continued as job ${job.autopilot_report.resumed_as_job_id}; run that job instead.`,
  };
  if (TERMINAL_STATUSES.has(job.status)) return { type: 'terminal', status: job.status };
  if (APPROVAL_STATUSES.has(job.status)) return { type: 'waiting_for_human', status: job.status };
  if (snapshot.workerRuns.some(run => run.status === 'running')) return { type: 'waiting_for_worker' };
  const conflict = snapshot.steps.find(step => step.status === 'failed' && /^Evidence conflict:/.test(step.error || ''));
  if (conflict) return { type: 'blocked', status: job.status, reason: 'evidence_conflict', step_id: conflict.step_id, detail: conflict.error };

  const product = byStep(snapshot, 'product_analysis');
  if (['intake', 'analysis_pending'].includes(job.status) && stepIsRunnable(product)) {
    return { type: 'run_product_analysis', step: product };
  }
  if (['intake', 'analysis_pending'].includes(job.status) && attemptCeilingReached(product)) return attemptCeilingBlock(job, product);
  const ux = byStep(snapshot, 'ui_design');
  if (job.status === 'design_pending' && stepIsRunnable(ux)) return { type: 'run_ux_design', step: ux };
  if (job.status === 'design_pending' && attemptCeilingReached(ux)) return attemptCeilingBlock(job, ux);
  if (job.status === 'design_pending' && ux?.status === 'skipped' && !job.frontend_required && job.backend_required) {
    return { type: 'continue_backend_only', step: ux };
  }
  if (job.status === 'implementation_pending') {
    const frontend = byStep(snapshot, 'frontend_implementation');
    if (ownerConfirmedVerifierRetryAtCeiling(snapshot, frontend)) return { type: 'run_frontend', step: frontend };
    if (stepIsRunnable(frontend)) return { type: 'run_frontend', step: frontend };
    if (attemptCeilingReached(frontend)) return attemptCeilingBlock(job, frontend);
    if (parkedStep(frontend)) return parkedStepBlock(job, frontend);
    const backend = byStep(snapshot, 'backend_implementation');
    if (stepIsRunnable(backend)) return { type: 'run_backend', step: backend };
    if (attemptCeilingReached(backend)) return attemptCeilingBlock(job, backend);
    if (parkedStep(backend)) return parkedStepBlock(job, backend);
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
  // A step still marked running is work in flight, not a dead end. In-process steps
  // (product analysis, UX design) never register a builder_worker_runs row, so the
  // worker check above cannot see them. Reporting `blocked` here is terminal:
  // listAutopilotJobs only re-selects driving/awaiting_human jobs, so a tick that
  // lands while an in-process step is running would park the job forever.
  if (snapshot.steps.some((step) => step?.status === 'running')) return { type: 'waiting_for_worker' };
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
  // Review and release must see exactly one evidence set per verified lane. The reviewed PATCH is
  // the author's artifact (the verify run's input, patch_artifact_id): that id carries the model-run
  // provenance the completion RPC checks (reviewer != author). Manifest and build log are the
  // independent worker's outputs. The agentic engineer also leaves proposal envelopes and transcripts
  // on the same step, which is why "every final artifact on the step" broke the invariant (job 3a4a2d06).
  const runs = implementationRuns(snapshot);
  const authorPatchIds = new Set(runs.map(run => run.patch_artifact_id).filter(Boolean));
  const outputIds = new Set(runs.flatMap(run => Array.isArray(run.output_artifact_ids) ? run.output_artifact_ids : []));
  const anchored = runs.length > 0;
  for (const stepId of ['frontend_implementation', 'backend_implementation']) {
    patches.push(...artifactsFor(snapshot, stepId, 'code_implementation').filter(artifact => !anchored || authorPatchIds.has(artifact.id)));
    manifests.push(...artifactsFor(snapshot, stepId, 'changed_file_manifest').filter(artifact => !anchored || outputIds.has(artifact.id)));
    buildLogs.push(...artifactsFor(snapshot, stepId, 'build_logs').filter(artifact => !anchored || outputIds.has(artifact.id)));
  }
  return { patch: patches, manifest: manifests, buildLogs };
}

async function loadArtifactJson(supabase, artifact) {
  if (!artifact?.storage_location?.startsWith('supabase_storage://builder-artifacts/')) return null;
  const { data, error } = await supabase.storage.from('builder-artifacts').download(artifact.storage_location.slice('supabase_storage://builder-artifacts/'.length));
  if (error || !data) return null;
  const text = Buffer.from(await data.arrayBuffer()).toString('utf8');
  try { return JSON.parse(text); } catch { return text.slice(0, 20000); }
}

// A review re-open names the previous attempt's verified patch in its description
// (builder-autopilot.js reviewReopenSpec): the revision starts from that code, not from main.
const SEED_PATCH = /^Opened by Bob's autopilot from job ([0-9a-f-]{36}) .*\[\[seed_patch:([0-9a-f-]{36})\]\]/i;

async function loadSeedPatch(supabase, job) {
  const match = String(job?.description ?? '').match(SEED_PATCH);
  if (!match || !supabase) return null;
  const [, parentJobId, artifactId] = match;
  try {
    const downloaded = await downloadVerifiedArtifact(supabase, artifactId, parentJobId, 'code_implementation');
    const { patch } = unwrapPatchArtifact(downloaded.bytes);
    if (!patch?.trim()) throw new Error('Review seed is empty');
    return { text: patch, from_job: parentJobId, artifact_id: artifactId };
  } catch {
    throw new Error('Review continuation patch could not be loaded; verify its artifact and checksum before resuming');
  }
}

/** Agentic generation for a lane, shaped like the one-shot engineers' result so handoffs stay unchanged. */
function agenticGenerator(lane, context, extra = {}) {
  return async ({ supabase, gateway, job, step, uxArtifact, productArtifact, requestedFiles, liveContext,
    failureArtifact = extra.failureArtifact, failedPatchArtifact = extra.failedPatchArtifact, startAfterProvider = null }) => {
    const [specification, uxPlan, previousFailure, seedPatch] = await Promise.all([
      productArtifact ? (async () => {
        const { bytes } = await downloadVerifiedArtifact(supabase, productArtifact.id, job.id, 'product_specification');
        return JSON.parse(bytes.toString('utf8'));
      })() : Promise.resolve(extra.specification ?? null),
      uxArtifact ? loadArtifactJson(supabase, uxArtifact) : Promise.resolve(null),
      failureArtifact ? (async () => {
        const downloaded = await downloadVerifiedArtifact(supabase, failureArtifact.id, job.id, 'build_logs');
        return JSON.parse(downloaded.bytes.toString('utf8'));
      })() : Promise.resolve(null),
      failedPatchArtifact
        ? (async () => {
          const downloaded = await downloadVerifiedArtifact(supabase, failedPatchArtifact.id, job.id, 'code_implementation');
          const { patch } = unwrapPatchArtifact(downloaded.bytes);
          if (!patch?.trim()) throw new Error('Repair source patch is empty');
          return { text: patch, from_job: job.id, artifact_id: failedPatchArtifact.id };
        })()
        : job.code_review_revision
          ? loadCodeReviewSeed(supabase, job, step)
          : (extra.loadSeedPatch || loadSeedPatch)(supabase, job)
    ]);
    // An engineer crash is a failed generation (counted against the step's attempt ceiling and recorded
    // with its reason), not a failed run that leaves the step looking untouched.
    const attempt = (previousAttempt = null, startAfter = startAfterProvider) => (extra.runEngineer || runAgenticEngineer)({
      supabase, gateway, job, step, lane,
      sourceDir: context.gitSourceDir || context.sourceDir,
      workspaceRoot: context.workspaceRoot,
      repoRoot: context.repoRoot,
      firewall: context.firewall || null,
      specification, uxPlan, liveContext,
      hints: requestedFiles,
      startAfterProvider: startAfter,
      prepareWorkspace: lane === 'frontend' ? context.prepareWorkspace || null : null,
      previousFailure: previousFailure ? { failure_evidence: previousFailure, failed_patch_artifact_id: failedPatchArtifact?.id ?? null } : null,
      previousAttempt,
      seedPatch,
      inputArtifactIds: [productArtifact?.id, uxArtifact?.id, failureArtifact?.id].filter(Boolean)
    }).catch((error) => ({ ok: false, error: `engineer crashed: ${String(error instanceof Error ? error.message : error).slice(0, 500)}` }));
    let generation = await attempt();
    // The author spent its turns reading a large seam and edited nothing (job 118731bd). That is not
    // "nothing to do": give it one more run that starts from the map the first run built, so the
    // owner is not asked to say "try again" for a failure Bob can absorb himself. Two such runs in a
    // row park the step with both facts (no_change → not retried six more times).
    if (generation.budget_exhausted && generation.resume_hints) {
      const second = await attempt(generation.resume_hints);
      generation = { ...second, attempts: 2, first_attempt: { turns: generation.turns, conclusion: String(generation.error || '').slice(0, 300) } };
      // Two full in-house budgets spent reading with no edit means the task is beyond that model
      // (live jobs 0c388688, 26ef7a12, e710f032: qwen2.5-coder:7b, 60 turns × 2, zero edits each).
      // Hand it once to the outsourced tier when the routing chain allows it, starting from the map.
      const pastInHouse = outsourcedEscalationPoint(second);
      if ((second.budget_exhausted || second.no_change) && pastInHouse) {
        const third = await attempt(second.resume_hints || generation.resume_hints, pastInHouse);
        if (third.ok && third.patch_artifact?.id) return { ...third, attempts: 3, escalated_after_in_house_budget: true, first_attempt: generation.first_attempt };
        return { ...third, attempts: 3, no_change: true, error: `two in-house attempts ran out of turns without an edit; escalated attempt (${third.routing?.provider || 'outsourced'}): ${String(third.error || '').slice(0, 600)}` };
      }
      if (generation.budget_exhausted || generation.no_change) generation = { ...generation, no_change: true, error: `Two author attempts produced no patch; second attempt: ${String(second.error || '').slice(0, 600)}` };
    }
    return generation;
  };
}

// The last in-house provider in the routing chain, when an outsourced provider follows it. Restricted
// (local-only) chains have none, so their data never leaves the house on an escalation.
function outsourcedEscalationPoint(generation) {
  const provider = generation?.routing?.provider;
  const chain = Array.isArray(generation?.routing?.chain) ? generation.routing.chain : [];
  const firstExternal = chain.findIndex((item) => EXTERNAL_PROVIDERS.has(item));
  if (!provider || EXTERNAL_PROVIDERS.has(provider) || firstExternal < 0) return null;
  const inHouse = chain.slice(0, firstExternal);
  return inHouse.length ? inHouse[inHouse.length - 1] : null;
}

// A local (in-house) author that fails is "stuck": the next attempt resumes the chain past it.
function escalationPoint(generation) {
  const provider = generation?.routing?.provider;
  return provider && provider !== 'openai' ? provider : null;
}

// The patch a lost verifier was checking (builder_recover_expired_worker_runs keeps the step's
// input_context): verify it again rather than spend an author run on a patch nobody rejected.
function resumablePatchArtifact(snapshot, step) {
  if (!step || step.status !== 'failed' || step.retryable !== true || !/lease expired|^Verifier recovery pending/i.test(String(step.error || ''))) return null;
  const patchId = step.input_context?.patch_artifact_id;
  if (!patchId) return null;
  const artifact = (snapshot?.artifacts || []).find((item) => item.id === patchId && item.artifact_type === 'code_implementation' && item.status === 'final');
  return artifact || null;
}

function failedImplementationEvidence(snapshot, step) {
  if (step?.status !== 'failed' || !step.retryable || resumablePatchArtifact(snapshot, step)) return {};
  const run = snapshot.workerRuns.filter(item => item.step_id === step.id && item.status === 'failed'
    && (!step.input_context?.patch_artifact_id || item.patch_artifact_id === step.input_context.patch_artifact_id)).at(-1);
  if (!run) return {};
  const failedPatchArtifact = snapshot.artifacts.find(item => item.id === run.patch_artifact_id && item.artifact_type === 'code_implementation' && item.status === 'final');
  const failureArtifact = snapshot.artifacts.find(item => run.output_artifact_ids?.includes(item.id) && item.artifact_type === 'build_logs' && item.status === 'final');
  if (!failedPatchArtifact || !failureArtifact) throw new Error('Failed implementation is missing its patch or verification evidence; cannot restart authoring');
  return { failedPatchArtifact, failureArtifact };
}

// Runners that died with their lease (redeploy, crash) must not hold a job for ever. Best-effort.
async function recoverExpiredWorkerRuns(supabase, logger = console, { includeActive = false, reason = null } = {}) {
  if (!supabase || typeof supabase.rpc !== 'function') return 0;
  try {
    const { data, error } = await supabase.rpc('builder_recover_expired_worker_runs', { _include_active: includeActive === true, _reason: reason });
    if (error) { logger?.warn?.(`[builder] expired worker runs not recovered: ${error.message}`); return 0; }
    if (Number(data) > 0) logger?.warn?.(`[builder] recovered ${data} ${includeActive ? 'orphaned' : 'expired'} verification run(s)`);
    return Number(data) || 0;
  } catch (error) {
    logger?.warn?.(`[builder] expired worker runs not recovered: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
}

async function runBackendImplementation(input) {
  const agentic = AGENTIC_ENABLED && input.context?.workspaceRoot;
  const generate = agentic ? agenticGenerator('backend', input.context, input.priorFailure) : runBackendEngineer;
  let generation = input.resumePatchArtifact ? { ok: true, patch_artifact: input.resumePatchArtifact, routing: { provider: 'resumed' } } : await generate(input);
  if (agentic && (!generation.ok || !generation.patch_artifact?.id) && escalationPoint(generation)) {
    generation = await generate({ ...input, startAfterProvider: escalationPoint(generation) });
  }
  if (!generation.ok || !generation.patch_artifact?.id) {
    if (await skipLaneWithNothingToDo(input, generation)) return { success: true, skipped: true, phase: 'generation', result: generation };
    await recordGenerationFailure(input, generation, 'generation');
    return { success: false, phase: 'generation', result: generation };
  }
  let patchArtifact = generation.patch_artifact;
  let infrastructureRetries = 0;
  for (let attempt = 1; attempt <= (agentic ? MAX_BACKEND_ATTEMPTS : 1); attempt += 1) {
    const verification = await runBackendHandoff({ ...input, patchArtifact });
    if (verification.success || !agentic) return { ...verification, attempts: attempt, patch_artifact: patchArtifact, routing: generation.routing };
    // The verifier failed, not the patch (OOM, killed, timed out): same patch again, once, no repair.
    if (verification.infrastructure_failure) {
      const currentStep = await (input.reloadStep || reloadFrontendStep)(input.supabase, input.step.id, input.job.id);
      if (!currentStep.retryable) return { ...verification, success: false, phase: 'infrastructure', attempts: attempt, patch_artifact: patchArtifact };
      if (infrastructureRetries < 1) { infrastructureRetries += 1; continue; }
      return { ...verification, success: false, phase: 'infrastructure', attempts: attempt, patch_artifact: patchArtifact };
    }
    // The repository is red at the pinned commit: park with the reason; no repair can pass.
    if (verification.baseline_failure) {
      return { ...verification, success: false, phase: 'baseline', attempts: attempt, error: verification.baseline_reason };
    }
    if (attempt >= MAX_BACKEND_ATTEMPTS) return { ...verification, success: false, phase: 'repair_limit', attempts: attempt };
    const failureArtifact = verification.failure_artifact || verification.artifacts?.[0];
    if (!failureArtifact?.id) return { success: false, phase: 'evidence', attempts: attempt, patch_artifact: patchArtifact, error: 'verification failure artifact is missing' };
    // Feed the independent worker's failure evidence back to Bob and let him repair; an in-house author
    // that failed verification hands the repair to the next provider in the chain.
    generation = await generate({ ...input, failureArtifact, failedPatchArtifact: patchArtifact, startAfterProvider: escalationPoint(generation) });
    if (!generation.ok || !generation.patch_artifact?.id) {
      await recordGenerationFailure(input, generation, 'repair');
      return { success: false, phase: 'repair', attempts: attempt, result: generation };
    }
    patchArtifact = generation.patch_artifact;
    infrastructureRetries = 0;
  }
  return { success: false, phase: 'verification', attempts: MAX_BACKEND_ATTEMPTS };
}

async function executeBuilderAction({ snapshot, action, supabase, gateway, context, handlers = {} }) {
  let acceptance = null;
  if (['start_optional_review', 'run_independent_review', 'run_release'].includes(action.type)) {
    acceptance = await (handlers.acceptance || checkImplementationAcceptance)({ supabase, snapshot });
    if (!acceptance.passed && !(action.type === 'start_optional_review' && snapshot.job.code_review_mode === 'human')) {
      return { success: false, phase: 'acceptance', error: `Whole-job acceptance incomplete: ${acceptance.blockers.join(' ').slice(0, 3000)}`, acceptance };
    }
  }
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
  if (snapshot.job.autopilot_source === 'main_monitor' && ['run_frontend', 'run_backend'].includes(action.type)) {
    const artifact = artifactsFor(snapshot, 'product_analysis', 'product_specification').at(-1);
    if (!artifact) throw new Error('Main-health implementation requires its validated product specification');
    const { bytes } = await downloadVerifiedArtifact(supabase, artifact.id, snapshot.job.id, 'product_specification');
    const specification = JSON.parse(bytes.toString('utf8'));
    const requirements = specification.delivery_requirements;
    if (!Array.isArray(requirements) || !requirements.length
      || requirements.some(requirement => !Array.isArray(requirement.source_scope) || !requirement.source_scope.length
        || requirement.source_scope.some(file => typeof file !== 'string' || !normalizeRepoPath(file)))) {
      throw new Error('Main-health specification has no valid implementation scope');
    }
    const lane = action.type === 'run_frontend' ? 'frontend' : 'backend';
    const files = [...new Set(requirements.flatMap(requirement => requirement.source_scope))];
    if (!files.some(file => laneFor(file) === lane)) {
      const siblingMode = lane === 'frontend' ? 'backend_engineer' : 'frontend_engineer';
      const sibling = snapshot.steps.find(step => step.builder_mode === siblingMode);
      if (!sibling || !['pending', 'completed'].includes(sibling.status)) {
        throw new Error('Cannot skip an unused repair lane without a sibling implementation');
      }
      const { error } = await supabase.rpc('builder_skip_implementation_step', {
        _job_id: snapshot.job.id, _step_id: action.step.id, _builder_mode: action.step.builder_mode,
        _reason: `Validated specification ${artifact.id} assigns this repair to the ${lane === 'frontend' ? 'backend' : 'frontend'} lane only: ${files.join(', ')}`,
      });
      if (error) throw new Error(`Unused repair lane could not be recorded: ${error.message}`);
      return { success: true, skipped: true, phase: 'specification_scope', specification_artifact_id: artifact.id };
    }
  }
  if (action.type === 'continue_backend_only') {
    const { data, error } = await supabase.rpc('builder_continue_backend_only_job', { _job_id: snapshot.job.id });
    if (error) throw new Error('Backend-only job could not advance');
    return { success: true, job: data };
  }
  if (action.type === 'run_product_analysis') {
    const priorFailure = action.step.status === 'failed' && action.step.error
      ? `Correct the previous Product Analyst validation failure without weakening repository grounding: ${String(action.step.error).replace(/\s+/g, ' ').slice(0, 1200)}`
      : null;
    return run.product({
      ...common,
      repositoryContext: context.repositoryContext,
      constraints: [...(Array.isArray(context.constraints) ? context.constraints : []), ...(priorFailure ? [priorFailure] : [])],
      requestedFromUsers: context.requestedFromUsers
    });
  }
  if (action.type === 'run_ux_design') {
    const priorFailure = action.step.status === 'failed' && action.step.error
      ? `Correct the previous UX Designer validation failure without weakening repository grounding: ${String(action.step.error).replace(/\s+/g, ' ').slice(0, 1200)}`
      : null;
    return run.ux({
      ...common,
      specificationArtifact: artifactsFor(snapshot, 'product_analysis', 'product_specification').at(-1),
      repositoryContext: context.designContext,
      constraints: priorFailure ? [priorFailure] : []
    });
  }
  if (action.type === 'run_frontend') {
    const agentic = AGENTIC_ENABLED && context.workspaceRoot && !handlers.frontend;
    const generator = agentic ? agenticGenerator('frontend', context, failedImplementationEvidence(snapshot, action.step)) : undefined;
    const resumePatchArtifact = resumablePatchArtifact(snapshot, action.step);
    const siblingCompleted = byStep(snapshot, 'backend_implementation')?.status === 'completed';
    return run.frontend({ ...common, siblingCompleted, productArtifact: artifactsFor(snapshot, 'product_analysis', 'product_specification').at(-1), uxArtifact: artifactsFor(snapshot, 'ui_design', 'ui_design_plan').at(-1), sourceDir: context.sourceDir, requestedFiles: context.frontendFiles, workerImage: context.workerImage, runnerId: context.runnerId, liveContext: context.liveContext, ...(resumePatchArtifact ? { resumePatchArtifact } : {}), ...(generator ? { generate: generator, repair: generator } : {}) });
  }
  if (action.type === 'run_backend') return run.backend({ ...common, context, priorFailure: failedImplementationEvidence(snapshot, action.step), siblingCompleted: byStep(snapshot, 'frontend_implementation')?.status === 'completed', productArtifact: artifactsFor(snapshot, 'product_analysis', 'product_specification').at(-1), sourceDir: context.sourceDir, requestedFiles: context.backendFiles, workerImage: context.workerImage, runnerId: context.runnerId, liveContext: context.liveContext, resumePatchArtifact: resumablePatchArtifact(snapshot, action.step) });
  const implementation = implementationArtifacts(snapshot);
  const runs = implementationRuns(snapshot);
  const securityArtifact = artifactsFor(snapshot, 'security_review', 'security_review').at(-1);
  if (action.type === 'run_security_review') return run.security({ ...common, securityStep: action.step, implementationWorkerRunIds: runs.map(item => item.id), sourceDir: context.sourceDir, workerImage: context.workerImage, runnerId: context.runnerId });
  if (action.type === 'start_optional_review') return run.optionalReview(supabase, { jobId: snapshot.job.id, stepId: action.step.id, artifactIds: [...implementation.patch, ...implementation.manifest, ...implementation.buildLogs, securityArtifact].filter(Boolean).map(item => item.id), requestedFromUsers: context.requestedFromUsers });
  if (action.type === 'run_independent_review') return run.independentReview({ ...common, artifacts: { ...implementation, security: securityArtifact }, reviewerModelName: context.reviewerModelName, acceptance });
  if (action.type === 'run_release') return run.release({ ...common, artifacts: { ...implementation, securityReview: securityArtifact, codeReview: artifactsFor(snapshot, 'code_review', 'code_review').at(-1) }, securityWorkerRunId: snapshot.workerRuns.filter(item => item.profile === 'security-review' && item.status === 'completed').at(-1)?.id, requestedFromUsers: context.requestedFromUsers });
  return action;
}

async function advanceBuilderJob({ supabase, gateway, jobId, context, handlers, loadSnapshot = loadBuilderRuntimeSnapshot }) {
  await recoverExpiredWorkerRuns(supabase);
  await accountVerifierRecoveries(supabase, jobId);
  let snapshot = await loadSnapshot(supabase, jobId);
  const correction = snapshot.job.code_review_revision;
  const requiredSkippedIds = snapshot.steps.filter(step =>
    step.status === 'skipped' && (
      (step.step_id === 'frontend_implementation' && snapshot.job.frontend_required === true)
      || (step.step_id === 'backend_implementation' && snapshot.job.backend_required === true)
    )).map(step => step.step_id);
  if (snapshot.job.status === 'implementation_pending' && correction?.approval_id
    && !Array.isArray(correction.reopened_required_lanes) && requiredSkippedIds.length) {
    if (!supabase || typeof supabase.rpc !== 'function') {
      throw new Error('Required implementation lanes cannot be recovered without the Builder service client');
    }
    const { error } = await supabase.rpc('builder_reopen_required_implementation_lanes', { _job_id: jobId });
    if (error) throw new Error(`Required implementation lanes could not be reopened: ${error.message}`);
    const reopenedSnapshot = await loadSnapshot(supabase, jobId);
    const stillSkipped = requiredSkippedIds.filter(stepId =>
      reopenedSnapshot.steps.find(step => step.step_id === stepId)?.status !== 'pending');
    if (stillSkipped.length) {
      throw new Error(`Required implementation lane recovery was not persisted: ${stillSkipped.join(', ')}`);
    }
    snapshot = reopenedSnapshot;
  }
  const action = planBuilderAction(snapshot);
  if (snapshot.job.status === 'security_review' && byStep(snapshot, 'code_review')?.status === 'blocked') {
    const report = await (handlers?.acceptance || checkImplementationAcceptance)({ supabase, snapshot });
    if (!report.passed) return { advanced: false, action: { type: 'blocked', reason: 'acceptance_incomplete',
      detail: `Whole-job acceptance incomplete: ${report.blockers.join(' ').slice(0, 3000)}` }, snapshot };
  }
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
    if (!outcome.advanced) return { paused: true, reason: outcome.action.reason || outcome.action.type, detail: outcome.action.detail, history, snapshot: outcome.snapshot };
    if (outcome.result?.ok === false || outcome.result?.success === false) {
      if (outcome.result.phase === 'acceptance') {
        return { paused: true, reason: 'acceptance_incomplete', detail: outcome.result.error, history, result: outcome.result };
      }
      return { paused: true, reason: 'action_failed', history, result: outcome.result };
    }
  }
  return { paused: true, reason: 'action_limit', history };
}

module.exports = {
  MAX_STEP_ATTEMPTS,
  failedImplementationEvidence,
  attemptCeilingReached,
  AGENTIC_ENABLED,
  MAX_BACKEND_ATTEMPTS,
  agenticGenerator,
  loadSeedPatch,
  artifactsFor,
  implementationRuns,
  implementationArtifacts,
  stepIsRunnable,
  planBuilderAction,
  recoverExpiredWorkerRuns,
  loadBuilderRuntimeSnapshot,
  runBackendImplementation,
  executeBuilderAction,
  advanceBuilderJob,
  runBuilderUntilPause
};