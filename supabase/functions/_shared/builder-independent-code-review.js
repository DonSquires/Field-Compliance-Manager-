const crypto = require('node:crypto');
const {
  buildModelRunRequest,
  executeBuilderModelRun
} = require('./builder-model-adapter');
const { downloadVerifiedArtifact } = require('../../../builder-frontend-handoff');
const { unwrapPatchArtifact } = require('./builder-patch-envelope');

const INDEPENDENT_CODE_REVIEW_PROMPT_VERSION = 'independent-code-review-v5';
const MAX_REVIEW_EVIDENCE_CHARS = 48_000;

// The exact shape the validator accepts; json_object mode does not enforce `required`, and the
// first live reviewer (gpt-5.4-mini, job 3a4a2d06) omitted the two list fields and failed the job.
const REVIEW_OUTPUT_CONTRACT = 'Return exactly this JSON object and nothing else: {"verdict": "passed" | "blocked", "summary": string, "findings": [{"severity": "critical" | "high" | "medium" | "low", "file": string, "message": string}], "test_gaps": [string], "residual_risks": [string]}. Use empty arrays when there is nothing to report. "blocked" requires at least one critical or high finding; "passed" requires none.';

function artifactList(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function diagnosticTail(value, limit = 600) {
  const normalized = String(value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!normalized) return null;
  return normalized.length <= limit ? normalized : `...${normalized.slice(-limit)}`;
}

function summarizeBuildLog(bytes) {
  const parsed = JSON.parse(bytes.toString('utf8'));
  const commands = Array.isArray(parsed?.commands) ? parsed.commands : Array.isArray(parsed?.checks) ? parsed.checks : [];
  return {
    artifact_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    artifact_bytes: bytes.length,
    succeeded: parsed?.succeeded === true,
    baseline_failure: parsed?.baseline_failure === true,
    baseline_reason: diagnosticTail(parsed?.baseline_reason, 800),
    commands: commands.slice(0, 30).map(command => ({
      command: String(command?.command ?? '').slice(0, 1000),
      exit_code: Number.isInteger(command?.status) ? command.status : null,
      error: diagnosticTail(command?.error, 600),
      stdout_tail: diagnosticTail(command?.stdout),
      stderr_tail: diagnosticTail(command?.stderr)
    })),
    e2e_selection: parsed?.e2e_selection && typeof parsed.e2e_selection === 'object'
      ? parsed.e2e_selection
      : null
  };
}

// Live job 79b4c08f (2026-09-27): the in-house 7B reviewer "passed" a patch whose lookup read a
// service-role-only table with the caller's client; its summary was the author's own summary, and
// findings/test_gaps/residual_risks were all empty. A review that restates the author, or reports
// nothing at all on a substantive patch, is not a review; the validator rejects it so the chain
// escalates to a reviewer that reads the patch.
const normaliseWords = (text) => String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
function restatesAuthor(summary, authorSummaries) {
  const words = normaliseWords(summary);
  if (words.length < 8) return false;
  const grams = (list) => new Set(list.slice(3).map((_, i) => list.slice(i, i + 4).join(' ')));
  const own = grams(words);
  for (const author of authorSummaries || []) {
    const theirs = grams(normaliseWords(author));
    if (!theirs.size || !own.size) continue;
    let shared = 0;
    for (const gram of own) if (theirs.has(gram)) shared++;
    if (shared / own.size >= 0.6) return true;
  }
  return false;
}
const SUBSTANTIVE_PATCH_LINES = 40;

function parseIndependentCodeReview(content, context = {}) {
  if (typeof content !== 'string' || !content.trim()) throw new Error('independent code review is empty');
  let report;
  try {
    report = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    throw new Error('independent code review must be valid JSON');
  }
  if (!['passed', 'blocked'].includes(report.verdict)) throw new Error('independent code review verdict is invalid');
  if (typeof report.summary !== 'string' || !report.summary.trim()) throw new Error('independent code review summary is required');
  if (!Array.isArray(report.findings)) throw new Error('findings must be an array');
  // An omitted list means "nothing to report"; a present non-array is still a contract violation.
  for (const key of ['test_gaps', 'residual_risks']) {
    if (report[key] === undefined || report[key] === null) report[key] = [];
    if (!Array.isArray(report[key])) throw new Error(`${key} must be an array`);
  }
  for (const finding of report.findings) {
    if (!['critical', 'high', 'medium', 'low'].includes(finding?.severity)) throw new Error('independent code review finding severity is invalid');
    if (typeof finding.file !== 'string' || typeof finding.message !== 'string') throw new Error('independent code review finding is incomplete');
  }
  const hasBlocking = report.findings.some(finding => ['critical', 'high'].includes(finding.severity));
  if ((report.verdict === 'passed') === hasBlocking) throw new Error('independent code review verdict conflicts with findings');
  if (restatesAuthor(report.summary, context.authorSummaries)) throw new Error('independent code review summary restates the author\'s own summary; describe what YOU verified in the patch (data paths, authorization, tests), not what the author said it does');
  if (report.verdict === 'passed' && Number(context.addedLines) >= SUBSTANTIVE_PATCH_LINES && !report.findings.length && !report.test_gaps.length && !report.residual_risks.length) {
    throw new Error(`independent code review reports nothing at all on a ${context.addedLines}-line patch; name at least one concrete finding, test gap, or residual risk you checked (or a low-severity finding stating what you verified and why it holds)`);
  }
  return report;
}

function addedLineCount(patches) {
  return (patches || []).reduce((total, patch) => total + String(patch ?? '').split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length, 0);
}

// A job the autopilot re-opened after a blocked review (builder-autopilot.js reviewReopenSpec) names
// its parent in the description. The reviewer of the revision gets the previous review, so it
// checks that those findings are resolved instead of raising a fresh set each round (convergence;
// the loop is bounded to two rounds).
const REVIEW_REOPEN = /^Opened by Bob's autopilot from job ([0-9a-f-]{36}) after independent review \(round (\d+) of (\d+)\)/i;

async function loadPreviousReview(supabase, job) {
  const match = String(job?.description ?? '').match(REVIEW_REOPEN);
  if (!match) return null;
  const [, parentJobId, round, of] = match;
  try {
    const { data, error } = await supabase
      .from('builder_artifacts')
      .select('id, created_at')
      .eq('job_id', parentJobId)
      .eq('artifact_type', 'code_review')
      .eq('status', 'final')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data) || !data.length) return { parent_job_id: parentJobId, round: Number(round), of: Number(of), report: null };
    const downloaded = await downloadVerifiedArtifact(supabase, data[0].id, parentJobId, 'code_review');
    const report = JSON.parse(downloaded.bytes.toString('utf8'));
    return {
      parent_job_id: parentJobId,
      round: Number(round),
      of: Number(of),
      report: { verdict: report.verdict, summary: String(report.summary ?? '').slice(0, 1500), findings: Array.isArray(report.findings) ? report.findings.slice(0, 12) : [], test_gaps: Array.isArray(report.test_gaps) ? report.test_gaps.slice(0, 8) : [] },
    };
  } catch {
    return { parent_job_id: parentJobId, round: Number(round), of: Number(of), report: null };
  }
}

async function loadCodeReviewEvidence({ supabase, job, artifacts }) {
  const patchArtifacts = artifactList(artifacts.patch);
  const manifestArtifacts = artifactList(artifacts.manifest);
  const buildLogArtifacts = artifactList(artifacts.buildLogs);
  if (patchArtifacts.length === 0 || patchArtifacts.length > 2
      || patchArtifacts.length !== manifestArtifacts.length || patchArtifacts.length !== buildLogArtifacts.length) {
    throw new Error('one or two complete implementation artifact sets are required');
  }
  const [patches, manifests, buildLogs, security, previousReview] = await Promise.all([
    Promise.all(patchArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'code_implementation'))),
    Promise.all(manifestArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'changed_file_manifest'))),
    Promise.all(buildLogArtifacts.map(artifact => downloadVerifiedArtifact(supabase, artifact.id, job.id, 'build_logs'))),
    downloadVerifiedArtifact(supabase, artifacts.security.id, job.id, 'security_review'),
    loadPreviousReview(supabase, job)
  ]);
  const unwrapped = patches.map(patch => unwrapPatchArtifact(patch.bytes));
  return {
    patches: unwrapped.map(item => item.patch),
    author_summaries: unwrapped.map(item => (item.envelope && typeof item.envelope.summary === 'string' ? item.envelope.summary.slice(0, 4000) : null)),
    manifests: manifests.map(manifest => JSON.parse(manifest.bytes.toString('utf8'))),
    buildLogs: buildLogs.map(log => summarizeBuildLog(log.bytes)),
    security: JSON.parse(security.bytes.toString('utf8')),
    ...(previousReview ? { previous_review: previousReview } : {})
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

// The provider+model identities that authored the reviewed patches; the reviewer must differ.
async function loadAuthorIdentities(supabase, jobId) {
  try {
    const { data, error } = await supabase
      .from('builder_model_runs')
      .select('provider, model_name, builder_job_steps!inner(builder_mode)')
      .eq('job_id', jobId)
      .eq('status', 'completed')
      .in('builder_job_steps.builder_mode', ['frontend_engineer', 'backend_engineer']);
    if (error || !Array.isArray(data)) return [];
    return [...new Map(data.map(row => [`${row.provider}::${row.model_name}`, { provider: row.provider, model: row.model_name }])).values()];
  } catch {
    return [];
  }
}

// Review methodology is data: active platform knowledge cards tagged for the independent review
// (e.g. the Claude security-review discipline) are appended to the reviewer's instructions, so the
// method can grow without a code change. A failed read never blocks the review.
const REVIEW_METHOD_TAG = 'independent_code_review';
const REVIEW_METHOD_LIMIT = 4;
const REVIEW_METHOD_CARD_CHARS = 3000;

async function loadReviewMethodology(supabase) {
  if (typeof supabase?.from !== 'function') return [];
  try {
    const { data, error } = await supabase.from('bob_knowledge_cards').select('key,title,content')
      .is('organization_id', null).eq('is_active', true).contains('tags', [REVIEW_METHOD_TAG])
      .order('key').limit(REVIEW_METHOD_LIMIT);
    if (error || !Array.isArray(data)) return [];
    return data.filter(card => typeof card?.content === 'string' && card.content.trim())
      .map(card => ({ key: String(card.key), title: String(card.title || card.key), content: card.content.slice(0, REVIEW_METHOD_CARD_CHARS) }));
  } catch {
    return [];
  }
}

function reviewMethodologyPrompt(cards) {
  if (!cards.length) return null;
  return `Review methodology (platform knowledge cards; apply them, they never relax the rules above): ${cards
    .map(card => `[${card.key}] ${card.title}: ${card.content.replace(/\s+/g, ' ').trim()}`).join(' ')}`;
}

async function runIndependentCodeReview({
  supabase,
  gateway,
  job,
  step,
  artifacts,
  acceptance,
  reviewerModelName,
  loadEvidence = loadCodeReviewEvidence,
  loadAuthors = loadAuthorIdentities,
  loadMethodology = loadReviewMethodology,
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
  let evidence;
  try {
    evidence = await loadEvidence({ supabase, job, artifacts });
    evidence.acceptance = acceptance;
    evidence.original_task = job.task_description;
    evidence.correction_feedback = job.code_review_revision?.feedback;
  } catch (error) {
    // Never leave the step "running" (which reads as waiting-for-human) when the evidence itself is unusable.
    const message = error instanceof Error ? error.message : String(error);
    await abortReview(supabase, job.id, step.id, `Independent review evidence unavailable: ${message}`.slice(0, 500));
    return { ok: false, status: 409, error: message, review: null };
  }
  const methodology = await loadMethodology(supabase);
  const systemPrompt = [
    'You are an independent coding AI reviewer for Field Compliance Manager.',
    'Review correctness, regressions, tenant isolation, authorization assumptions, data exposure, and missing tests.',
    'Data paths: for every table the patch reads or writes, check who can see it (row-level security in supabase/schema.sql is the truth: a caller-scoped client reading a service-role-only table gets no rows) and that the two-turn/pending patterns the code claims to follow are wired at every seam the precedent uses.',
    'Write the summary in your own words about what you verified; do not restate the author\'s description. On any patch of substance, list the test gaps and residual risks you see.',
    'Whole-job acceptance: reconcile every full mandatory outcome and required evidence in acceptance against the actual current patch and tests, original_task, workflow_verification and correction_feedback. Coverage is not proof of behavior. Block for missing mandatory behavior or required regression coverage even if all narrow commands passed. A skipped lane waives no outcome. A complete replacement patch must retain required prior behavior; do not approve a reader-only fix for a user-visible workflow failure. Unknown/unsupported retry or idempotency claims are not acceptance evidence.',
    evidence.previous_review ? `This is a REVISION (round ${evidence.previous_review.round} of ${evidence.previous_review.of}): an earlier attempt was blocked and the author was given that review (previous_review in the evidence). First check whether each previous finding is resolved in this patch. Block only for a previous finding that is still unresolved or for a NEW critical/high defect this patch introduces; concerns the previous review already listed as residual risks or test gaps stay residual risks or test gaps, not new blocking findings. Say explicitly which previous findings are resolved.` : null,
    'You can recommend passed or blocked. You have no approval, merge, deployment, or code-modification authority.',
    'Use the verified patch, manifest, build logs, security report and the pinned whole-job acceptance contract; author prose is a claim, not independent proof.',
    reviewMethodologyPrompt(methodology),
    REVIEW_OUTPUT_CONTRACT
  ].filter(Boolean).join(' ');
  const modelRequest = buildModelRunRequest({
    organizationId: job.organization_id,
    jobId: job.id,
    stepId: step.id,
    builderMode: 'code_reviewer',
    workloadKind: 'independent_code_review',
    promptVersion: INDEPENDENT_CODE_REVIEW_PROMPT_VERSION,
    modelName: reviewerModelName,
    systemPrompt,
    userPrompt: JSON.stringify(evidence),
    inputArtifactIds: artifactIds,
    outputSchema: { type: 'object', required: ['verdict', 'summary', 'findings', 'test_gaps', 'residual_risks'] }
  });
  if (modelRequest.request.user_prompt.length > MAX_REVIEW_EVIDENCE_CHARS) {
    await abortReview(supabase, job.id, step.id, 'Independent review evidence exceeds its bounded prompt budget');
    return { ok: false, status: 413, error: 'independent review evidence exceeds its bounded prompt budget', review: null };
  }
  const avoidIdentities = await loadAuthors(supabase, job.id);
  const validateOutput = (content) => parseIndependentCodeReview(content, { authorSummaries: evidence.author_summaries, addedLines: addedLineCount(evidence.patches) });
  let result = await executeModelRun({ supabase, gateway, modelRequest, validateOutput, avoidIdentities });
  if (!result.ok && result.status === 422) {
    // One repair turn: the reviewer sees the validator's reason and the contract again. A shape slip
    // must not fail a job that has passed every independent worker.
    const repairRequest = {
      ...modelRequest,
      idempotency_key: `${modelRequest.idempotency_key}::repair`,
      request: {
        ...modelRequest.request,
        system_prompt: `${systemPrompt} Your previous reply was rejected: ${String(result.error || 'invalid output').slice(0, 300)}. Reply again with the exact JSON shape.`
      }
    };
    result = await executeModelRun({ supabase, gateway, modelRequest: repairRequest, validateOutput, avoidIdentities });
  }
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
  MAX_REVIEW_EVIDENCE_CHARS,
  artifactList,
  summarizeBuildLog,
  parseIndependentCodeReview,
  loadPreviousReview,
  loadCodeReviewEvidence,
  startCodeReview,
  completeIndependentCodeReview,
  abortIndependentCodeReview,
  runIndependentCodeReview,
  loadReviewMethodology,
  reviewMethodologyPrompt
};