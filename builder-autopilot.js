// Bob autopilot: finishes Builder jobs the owner asked for in chat, the way a coding
// agent finishes a task — clear the gates on the requester's recorded instruction,
// keep the bounded runner moving, publish the verified branch, open the pull
// request, and leave a plain-language report for Bob to relay. It never merges,
// deploys, or touches protected paths (those stay human; docs/canon/BOB_DOCTRINE.md §9).
// Owner ruling 2026-09-26: human approval is required for evidential work — a gate on a
// job that touches evidential paths is never cleared by the autopilot; it waits for a person.
const { runBuilderUntilPause, loadBuilderRuntimeSnapshot, implementationRuns } = require('./builder-runtime-coordinator');
const { unwrapPatchArtifact } = require('./supabase/functions/_shared/builder-patch-envelope');
const { evidentialMentions, evidentialPathsIn } = require('./builder-path-policy');

const TERMINAL = new Set(['failed', 'cancelled', 'deployed']);
const GATES = new Set(['specification_ready', 'approval_pending']);
const GATE_LABEL = {
  specification_review: 'the specification gate, before any code is written',
  release_approval: 'the release gate: the change is built and checked, and waits for you before it is published as a pull request'
};

function plain(value, cap = 600) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
}

function describeFiles(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return 'no files';
  return list.length <= 6 ? list.join(', ') : `${list.slice(0, 6).join(', ')} and ${list.length - 6} more`;
}

/**
 * Gather the evidence a reviewer (or a non-coder owner) needs: what Bob changed, what
 * checked it, and what the independent reviewers concluded. Read-only over storage.
 */
async function collectEvidence({ supabase, snapshot }) {
  const download = async (artifact) => {
    if (!artifact?.storage_location?.startsWith('supabase_storage://builder-artifacts/')) return null;
    const { data, error } = await supabase.storage.from('builder-artifacts').download(artifact.storage_location.slice('supabase_storage://builder-artifacts/'.length));
    if (error || !data) return null;
    const text = Buffer.from(await data.arrayBuffer()).toString('utf8');
    try { return JSON.parse(text); } catch { return text; }
  };
  const finalOf = (type, stepIds = null) => snapshot.artifacts.filter((a) => a.artifact_type === type && a.status === 'final' && (!stepIds || stepIds.has(a.step_id)));
  const runs = implementationRuns(snapshot);
  const verifyRun = runs.at(-1) || null;
  const authorArtifact = verifyRun ? snapshot.artifacts.find((a) => a.id === verifyRun.patch_artifact_id) : null;
  const validatedPatch = verifyRun ? snapshot.artifacts.find((a) => Array.isArray(verifyRun.output_artifact_ids) && verifyRun.output_artifact_ids.includes(a.id) && a.artifact_type === 'code_implementation') : null;
  const manifest = verifyRun ? snapshot.artifacts.find((a) => Array.isArray(verifyRun.output_artifact_ids) && verifyRun.output_artifact_ids.includes(a.id) && a.artifact_type === 'changed_file_manifest') : null;
  const stepId = (id) => snapshot.steps.find((s) => s.step_id === id)?.id;
  const security = finalOf('security_review', new Set([stepId('security_review')])).at(-1) || null;
  const review = finalOf('code_review', new Set([stepId('code_review')])).at(-1) || null;
  const releaseNotes = finalOf('release_notes').at(-1) || null;

  const [author, manifestRows, securityReport, reviewReport, release] = await Promise.all([
    authorArtifact ? download(authorArtifact) : null,
    manifest ? download(manifest) : null,
    security ? download(security) : null,
    review ? download(review) : null,
    releaseNotes ? download(releaseNotes) : null,
  ]);
  const envelope = author && typeof author === 'object' && typeof author.patch === 'string' ? author : (typeof author === 'string' ? unwrapPatchArtifact(author).envelope : null);
  const changedFiles = Array.isArray(manifestRows) ? manifestRows.map((row) => row?.path).filter(Boolean) : (envelope?.changed_files ?? []);
  const verifiedRuns = Array.isArray(envelope?.verified_runs) ? envelope.verified_runs.filter((r) => r && typeof r.command === 'string') : [];
  const passingTests = verifiedRuns.filter((r) => /^node --test\b/.test(r.command) && r.exit_code === 0).map((r) => plain(r.command, 160));
  return {
    verifyRun,
    validatedPatchId: validatedPatch?.id ?? null,
    // path + after_sha256 of every file the verified patch changed: the fingerprint of "this change is on main".
    manifestRows: Array.isArray(manifestRows) ? manifestRows.filter((row) => row && typeof row.path === 'string' && typeof row.after_sha256 === 'string') : [],
    summary: plain(envelope?.summary ?? release?.summary ?? '', 1200),
    changedFiles,
    // Prefer what the tool log proves ran; fall back to the author's list only when no log exists (one-shot lanes).
    testsRun: passingTests.length ? passingTests : (verifiedRuns.length ? [] : (Array.isArray(envelope?.tests) ? envelope.tests.map((t) => plain(t, 160)) : [])),
    testsNotRunReason: typeof envelope?.tests_not_run_reason === 'string' ? plain(envelope.tests_not_run_reason, 300) : null,
    followUps: Array.isArray(envelope?.follow_ups) ? envelope.follow_ups.map((t) => plain(t, 300)) : [],
    rollbackNotes: Array.isArray(envelope?.rollback_notes) ? envelope.rollback_notes.map((t) => plain(t, 300)) : [],
    security: securityReport && typeof securityReport === 'object' ? { passed: securityReport.passed === true, counts: securityReport.counts ?? null } : null,
    review: reviewReport && typeof reviewReport === 'object' ? {
      verdict: reviewReport.verdict ?? null,
      summary: plain(reviewReport.summary, 800),
      findings: Array.isArray(reviewReport.findings) ? reviewReport.findings.length : null,
      // The reviewer's actual words: what a review re-open hands back to the author.
      findingList: Array.isArray(reviewReport.findings) ? reviewReport.findings.filter((f) => f && typeof f.message === 'string').map((f) => ({ severity: String(f.severity ?? ''), file: plain(f.file, 160), message: plain(f.message, 700) })) : [],
      testGaps: Array.isArray(reviewReport.test_gaps) ? reviewReport.test_gaps.map((t) => plain(t, 400)) : [],
      model: null,
    } : null,
    releaseNotes: release && typeof release === 'object' ? { notes: Array.isArray(release.release_notes) ? release.release_notes.map((t) => plain(t, 300)) : [], risks: Array.isArray(release.known_risks) ? release.known_risks.map((t) => plain(t, 300)) : [] } : null,
  };
}

function composeReport({ job, evidence, pullRequestUrl, state, reason, hold, repair, resumedAs, automerge = null }) {
  const lines = [];
  if (state === 'published') {
    lines.push(`Done: "${plain(job.title, 160)}" is built, checked, and waiting for review.`);
    if (evidence.summary) lines.push(`What changed: ${evidence.summary}`);
    lines.push(`Files touched: ${describeFiles(evidence.changedFiles)}.`);
    const checks = [];
    if (evidence.testsRun.length) checks.push(`Bob ran ${evidence.testsRun.length === 1 ? 'the test' : `${evidence.testsRun.length} test commands`} himself and they passed (${evidence.testsRun.slice(0, 3).join('; ')})`);
    else if (evidence.testsNotRunReason) checks.push(`Bob could not run tests here (${evidence.testsNotRunReason})`);
    if (evidence.verifyRun) checks.push('an isolated worker re-applied the change from scratch and it passed');
    if (evidence.security) checks.push(evidence.security.passed ? 'the security scan found nothing' : 'the security scan raised findings (see the pull request)');
    if (evidence.review?.verdict) checks.push(`an independent AI reviewer (a different model from the author) said "${evidence.review.verdict}"${evidence.review.summary ? `: ${evidence.review.summary}` : ''}`);
    if (checks.length) lines.push(`How it was checked: ${checks.join('; ')}.`);
    if (evidence.releaseNotes?.risks?.length) lines.push(`Known risks: ${evidence.releaseNotes.risks.join(' ')}`);
    if (evidence.followUps.length) lines.push(`Bob's notes: ${evidence.followUps.join(' ')}`);
    lines.push(pullRequestUrl ? `Where to review it: ${pullRequestUrl}` : 'The branch is published; the pull request link will follow.');
    if (automerge?.ok) lines.push('Bob will merge this himself within about ten minutes (every independent check passed and nothing evidential is involved); the release lane then puts it live. If you want it undone, say so and Bob will revert it.');
    else lines.push('Nothing is live yet. When you (or your reviewer) merge the pull request, the change ships; until then the app is unchanged.');
  } else if (state === 'blocked') {
    lines.push(`Stopped: Bob could not finish "${plain(job.title, 160)}" on his own.`);
    lines.push(`Why: ${plain(reason, 500) || 'the Builder could not continue'}.`);
    if (evidence?.summary) lines.push(`What Bob had done so far: ${evidence.summary}`);
    lines.push('What you can do: tell Bob "try again" to start a fresh attempt with what he learned, or describe the change differently. Nothing was published.');
  } else if (state === 'repairing') {
    lines.push(`Paused: "${plain(job.title, 160)}" is waiting while Bob fixes the app's own checks first.`);
    lines.push(`Why: ${plain(reason, 500)}. This is not caused by the change you asked for.`);
    lines.push(`What Bob is doing: he has opened a repair job, "${plain(repair?.title, 160)}", which goes through the same build, test and review steps. When that repair is merged, Bob re-runs your change automatically. Nothing for you to do now.`);
  } else if (state === 'resumed') {
    lines.push(`Resumed: main is fixed, so Bob has started "${plain(job.title, 160)}" again from the current code. You will get a fresh report when it is built and checked.`);
  } else if (state === 'review_reopened') {
    lines.push(`Revising: an independent AI reviewer (a different model from the author) found problems with Bob's attempt at "${plain(job.title, 160)}", so Bob is fixing them in a new attempt.`);
    lines.push(`What the reviewer found: ${plain(reason, 700)}`);
    lines.push('Nothing was published. You will get a fresh report when the revised change is built, checked and reviewed again.');
  } else if (state === 'repair_failed') {
    lines.push(`Stopped: Bob could not fix the app's own failing checks that were blocking "${plain(job.title, 160)}".`);
    lines.push(`Why: ${plain(reason, 500)}.`);
    lines.push('What you can do: tell Bob "try the repair again", or ask him to explain what is failing in plain terms. Nothing was published.');
  } else if (state === 'awaiting_human') {
    lines.push(`Needs your approval: "${plain(job.title, 160)}" touches evidential work, so Bob has paused at ${GATE_LABEL[hold?.gate] ?? 'an approval gate'}.`);
    lines.push(`What is evidential here: ${describeFiles(hold?.files)}.`);
    if (evidence?.summary) lines.push(`What Bob has done so far: ${evidence.summary}`);
    if (evidence?.review?.verdict) lines.push(`An independent AI reviewer (a different model from the author) said "${evidence.review.verdict}"${evidence.review.summary ? `: ${evidence.review.summary}` : ''}.`);
    lines.push('What to do: open Platform & Settings → Builder → this job → Approvals and approve or decline with a note. Bob continues only after your decision; nothing is published or merged before then.');
  }
  return {
    state,
    headline: lines[0] ?? '',
    text: lines.join('\n'),
    pull_request_url: pullRequestUrl ?? null,
    changed_files: evidence?.changedFiles ?? [],
    evidential_files: hold?.files ?? [],
    gate: hold?.gate ?? null,
    review_verdict: evidence?.review?.verdict ?? null,
    security_passed: evidence?.security?.passed ?? null,
    repair_job_id: repair?.id ?? null,
    resumed_as_job_id: resumedAs ?? null,
    generated_at: new Date().toISOString(),
  };
}

// Owner ruling 2026-09-27: the owner cannot review code and the coding agent is leaving, so a change that
// passed every independent check merges itself. Env-gated (BOB_AUTOPILOT_AUTOMERGE=true) and narrow:
// worker-verified, security scan clean, the strongest reviewer passed with an ENGAGED review (no
// critical/high, at least one gap or risk named on a substantive change), requested in chat, and no
// evidential path touched (those still wait for a person). The bridge merges on the marker.
const AUTOMERGE_MARK = '<!-- bob-automerge: yes -->';

function automergeEligible({ job, evidence, env = process.env }) {
  if (String(env.BOB_AUTOPILOT_AUTOMERGE || '').toLowerCase() !== 'true') return { ok: false, reason: 'auto-merge is off (BOB_AUTOPILOT_AUTOMERGE)' };
  if (!job?.autopilot_requested_by) return { ok: false, reason: 'not requested by a person in chat' };
  if (!evidence?.verifyRun) return { ok: false, reason: 'no independent worker verification' };
  if (evidence.security?.passed !== true) return { ok: false, reason: 'security scan did not pass' };
  const review = evidence.review;
  if (review?.verdict !== 'passed') return { ok: false, reason: 'independent review did not pass' };
  if ((review.findingList || []).some((f) => ['critical', 'high'].includes(f.severity))) return { ok: false, reason: 'review has critical/high findings' };
  const files = evidence.changedFiles || [];
  if (!files.length) return { ok: false, reason: 'no changed files' };
  const evidential = evidentialPathsIn(files);
  if (evidential.length) return { ok: false, reason: `evidential paths need a person: ${evidential.slice(0, 3).join(', ')}` };
  return { ok: true, reason: 'worker-verified, security clean, independent review passed, no evidential paths' };
}

function composePullRequestBody({ job, evidence, branchName, headSha, automerge = null }) {
  const md = [];
  md.push('## What this changes');
  md.push(evidence.summary || plain(job.task_description, 1500) || '(no summary recorded)');
  md.push('');
  md.push(`**Files:** ${evidence.changedFiles.map((f) => `\`${f}\``).join(', ') || 'n/a'}`);
  md.push('');
  md.push('## How it was verified');
  if (evidence.testsRun.length) md.push(`- Author ran and passed: ${evidence.testsRun.map((t) => `\`${t}\``).join(', ')}`);
  else if (evidence.testsNotRunReason) md.push(`- Author could not run tests: ${evidence.testsNotRunReason}`);
  if (evidence.verifyRun) md.push(`- Independent worker (\`${evidence.verifyRun.profile}\`) re-applied the patch in an isolated container: **passed**`);
  if (evidence.security) md.push(`- Security scan: **${evidence.security.passed ? 'passed' : 'findings'}**${evidence.security.counts ? ` (critical ${evidence.security.counts.critical ?? 0}, high ${evidence.security.counts.high ?? 0}, medium ${evidence.security.counts.medium ?? 0}, low ${evidence.security.counts.low ?? 0})` : ''}`);
  if (evidence.review?.verdict) md.push(`- Independent AI code review (different model from the author): **${evidence.review.verdict}** — ${evidence.review.summary || 'no summary'}`);
  if (evidence.releaseNotes?.notes?.length) { md.push(''); md.push('## Release notes'); for (const note of evidence.releaseNotes.notes) md.push(`- ${note}`); }
  if (evidence.releaseNotes?.risks?.length) { md.push(''); md.push('## Known risks'); for (const risk of evidence.releaseNotes.risks) md.push(`- ${risk}`); }
  if (evidence.rollbackNotes.length) { md.push(''); md.push('## Rollback'); for (const note of evidence.rollbackNotes) md.push(`- ${note}`); }
  if (evidence.followUps.length) { md.push(''); md.push("## Author's notes"); for (const note of evidence.followUps) md.push(`- ${note}`); }
  md.push('');
  md.push('## Provenance');
  md.push(`- Builder job \`${job.id}\`, pinned to \`${job.target_sha}\``);
  md.push(`- Branch \`${branchName}\` at \`${headSha}\``);
  if (automerge?.ok) {
    md.push(`- Opened by Bob Builder. Auto-merge: Bob merges this himself (${automerge.reason}); the release lane then puts it live and Bob reports in chat. Revert the merge commit to undo it.`);
    md.push(AUTOMERGE_MARK);
  } else {
    md.push('- Opened by Bob Builder for human review. Bob does not merge or deploy; nothing changes in the app until a person merges this.');
  }
  return md.join('\n');
}

/**
 * The evidential-work hold for one pending gate: paths named in the brief always count; at the
 * release gate the files the verified patch actually changed count too. Null means Bob may clear it.
 */
function evidentialHold({ job, approval, evidence }) {
  const mentioned = evidentialMentions(`${job.title ?? ''}\n${job.task_description ?? ''}`);
  const changed = approval.approval_type === 'release_approval' ? evidentialPathsIn(evidence?.changedFiles) : [];
  const files = [...new Set([...changed, ...mentioned])].sort();
  return files.length ? { gate: approval.approval_type, files } : null;
}

/**
 * Drive one autopilot job one tick forward. `actions` is injected so the loop can be
 * exercised without a live control plane: { listPending, approve, run, publish, record,
 * createJob?, loadJob?, changeLanded? }.
 */
const REPAIR_TITLE_PREFIX = 'Repair main: ';

/** A block whose cause is the repository being red at the pinned commit (not the job's own change). */
function baselineBlock(reason) {
  const text = String(reason ?? '');
  const match = text.match(/repository red at the pinned commit:\s*(.+)$/is);
  if (!match) return null;
  const detail = match[1].trim();
  const files = [...new Set((detail.match(/[\w./-]+\.(?:test|spec|guard\.test)\.[cm]?[jt]sx?/g) || []))].slice(0, 8);
  return { reason: detail.slice(0, 600), files };
}

function isRepairJob(job) {
  return String(job?.title ?? '').startsWith(REPAIR_TITLE_PREFIX);
}

const REOPEN_MARK = "Opened by Bob's autopilot from job ";

/** A job the autopilot itself opened again from an earlier one (one automatic re-open per brief). */
function isReopenedJob(job) {
  return String(job?.description ?? '').startsWith(REOPEN_MARK);
}

// The independent reviewer blocked the change. That is the normal author -> review -> revise loop
// of a coding agent, not a stop: the same brief goes again with the reviewer's findings folded in,
// at most REVIEW_ROUNDS times per brief (job 019d2088, 2026-09-27: a correct high finding —
// the planner RESUME block was missing — ended the job as "Bob could not finish on his own").
const REVIEW_ROUNDS = 2;
const REVIEW_BLOCK = /independent ai code review found blocking defects/i;
const REVIEW_ROUND_MARK = /after independent review \(round (\d+) of \d+\)/i;

function reviewRound(job) {
  const match = String(job?.description ?? '').match(REVIEW_ROUND_MARK);
  return match ? Number(match[1]) : 0;
}

function reviewBlock(job) {
  return REVIEW_BLOCK.test(String(job?.last_error ?? ''));
}

/** The same brief with the reviewer's findings appended, for a fresh job pinned to the current main. */
function reviewReopenSpec(job, review, seedPatchId = null) {
  const round = reviewRound(job) + 1;
  const findings = (review?.findingList ?? []).map((f) => `- [${f.severity || 'finding'}] ${f.file ? `${f.file}: ` : ''}${f.message}`);
  const gaps = (review?.testGaps ?? []).slice(0, 6).map((t) => `- ${t}`);
  const taskDescription = [
    String(job.task_description ?? '').trim(),
    '',
    `INDEPENDENT REVIEW OF THE PREVIOUS ATTEMPT (job ${job.id}) BLOCKED IT. This attempt must fix every finding below; treat each as a required behaviour, and add a test for each where the layer allows.`,
    review?.summary ? `Reviewer's summary: ${review.summary}` : null,
    findings.length ? `Findings:\n${findings.join('\n')}` : null,
    gaps.length ? `Test gaps the reviewer named:\n${gaps.join('\n')}` : null,
    // Round 2 of job f233ec31 (2026-09-27) started from main without the previous attempt's code and
    // shipped a patch that only touched the control room: the revision must build on the earlier work.
    seedPatchId ? `START FROM THE PREVIOUS ATTEMPT: its verified change is applied to your worktree before you begin (git_diff shows it). Revise that code to resolve the findings; do not rebuild it from scratch and do not remove it.` : null,
  ].filter((line) => line !== null).join('\n');
  return {
    ...reopenSpec(job),
    taskDescription: taskDescription.slice(0, 12000),
    description: `${REOPEN_MARK}${job.id} after independent review (round ${round} of ${REVIEW_ROUNDS})${seedPatchId ? ` [[seed_patch:${seedPatchId}]]` : ''}`,
  };
}

/** The brief for the job that fixes main, bound to the same requester and conversation as the blocked job. */
function repairJobFor(job, baseline) {
  const web = baseline.files.some((f) => f.startsWith('src/') || f.startsWith('apps/web/')) || /--prefix apps\/web/.test(baseline.reason);
  const files = baseline.files.map((f) => (f.startsWith('apps/') ? f : `apps/web/${f}`));
  const title = `${REPAIR_TITLE_PREFIX}${files.length ? `${files.length} failing ${files.length === 1 ? 'check' : 'checks'} (${files.map((f) => f.split('/').pop()).slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''})` : 'failing checks'}`.slice(0, 200);
  const description = [
    'Symptom: the repository\'s own verification fails on main at the pinned commit, without any pending change applied. This blocked another Builder job that is not the cause.',
    `Evidence (from the isolated verifier, unpatched tree): ${baseline.reason}`,
    files.length ? `Files implicated: ${files.join(', ')}. Read each failing test and the source it asserts on; decide whether the test is stale (the code moved on) or the code regressed, and fix the true cause. Guard tests that assert exact source text usually need the assertion brought back to what the source now says.` : 'Files implicated: identify the failing test files from the verifier command output first.',
    'Acceptance test: the failing command passes in the isolated verifier with no other tests newly failing; changes are limited to what the failing checks require.',
    'Out of scope: unrelated refactors, changing behaviour the failing tests do not cover, deleting tests to make them pass.',
    `Origin: opened automatically by Bob's autopilot for job ${job.id} ("${String(job.title ?? '').slice(0, 120)}"), which re-runs when this repair is merged.`,
  ].join('\n');
  return {
    parentJobId: job.id,
    organizationId: job.organization_id,
    projectId: job.project_id,
    title,
    taskDescription: description,
    frontendRequired: web,
    backendRequired: !web,
    codeReviewMode: 'independent_ai',
    requestedBy: job.autopilot_requested_by,
    conversationId: job.autopilot_conversation_id ?? null,
  };
}

/** The same brief again, for a fresh job pinned to the current main. */
function reopenSpec(job) {
  return {
    parentJobId: job.id,
    organizationId: job.organization_id,
    projectId: job.project_id,
    title: job.title,
    taskDescription: job.task_description,
    frontendRequired: job.frontend_required === true,
    backendRequired: job.backend_required === true,
    codeReviewMode: job.code_review_mode || 'independent_ai',
    requestedBy: job.autopilot_requested_by,
    conversationId: job.autopilot_conversation_id ?? null,
  };
}

/** A job parked behind a repair: re-open it on current main once the repair's files are on main; report a failed repair plainly. */
async function resumeAfterRepair({ supabase, job, actions, log }) {
  const repairId = job.autopilot_report.repair_job_id;
  const repair = typeof actions.loadJob === 'function' ? await actions.loadJob(repairId) : null;
  if (!repair) return { job: job.id, outcome: 'waiting_for_repair', repair_job: repairId };
  if (TERMINAL.has(repair.status) || repair.autopilot_state === 'blocked') {
    const reason = repair.last_error || repair.autopilot_report?.headline || `the repair job ended as ${repair.status}`;
    await actions.record(job.id, 'blocked', { ...composeReport({ job, state: 'repair_failed', reason }), repair_job_id: repairId, repair_outcome: 'failed' });
    log({ job: job.id, repair_failed: repairId });
    return { job: job.id, outcome: 'repair_failed', repair_job: repairId };
  }
  if (repair.status !== 'release_ready' || !repair.workspace_pull_request_url || typeof actions.changeLanded !== 'function') {
    return { job: job.id, outcome: 'waiting_for_repair', repair_job: repairId };
  }
  const snapshot = await loadBuilderRuntimeSnapshot(supabase, repair.id).catch(() => null);
  const evidence = snapshot ? await collectEvidence({ supabase, snapshot }).catch(() => null) : null;
  if (!evidence?.manifestRows?.length || !(await actions.changeLanded(evidence.manifestRows))) {
    return { job: job.id, outcome: 'waiting_for_repair', repair_job: repairId };
  }
  const reopened = await actions.createJob(reopenSpec(job));
  await actions.record(job.id, 'done', { ...composeReport({ job, state: 'resumed', resumedAs: reopened.id }), repair_job_id: repairId, repair_outcome: 'landed' });
  log({ job: job.id, resumed_as: reopened.id, after_repair: repairId });
  return { job: job.id, outcome: 'resumed', resumed_as: reopened.id };
}

async function autopilotTick({ supabase, jobs, actions, log = () => {} }) {
  const outcomes = [];
  for (const job of jobs) {
    try {
      // Waiting on a repair of main (owner ruling 2026-09-27: Bob does the coding; nobody is asked to fix main).
      if (job.autopilot_state === 'blocked' && job.autopilot_report?.repair_job_id && !job.autopilot_report?.resumed_as_job_id && !job.autopilot_report?.repair_outcome) {
        outcomes.push(await resumeAfterRepair({ supabase, job, actions, log }));
        continue;
      }
      if (TERMINAL.has(job.status)) {
        if (job.autopilot_state !== 'blocked' && job.autopilot_state !== 'done') {
          const snapshot = await loadBuilderRuntimeSnapshot(supabase, job.id).catch(() => null);
          const evidence = snapshot ? await collectEvidence({ supabase, snapshot }).catch(() => null) : null;
          if (job.status === 'failed' && reviewBlock(job) && reviewRound(job) < REVIEW_ROUNDS && typeof actions.createJob === 'function') {
            const reopened = await actions.createJob(reviewReopenSpec(job, evidence?.review, evidence?.validatedPatchId ?? null));
            const said = evidence?.review?.findingList?.length ? evidence.review.findingList.map((f) => f.message).join(' ') : (evidence?.review?.summary || job.last_error);
            await actions.record(job.id, 'done', { ...composeReport({ job, evidence, state: 'review_reopened', reason: said, resumedAs: reopened.id }), repair_outcome: 'review_reopened' });
            log({ job: job.id, review_reopened_as: reopened.id, round: reviewRound(job) + 1 });
            outcomes.push({ job: job.id, outcome: 'review_reopened', resumed_as: reopened.id });
            continue;
          }
          const reason = job.status === 'failed' && reviewBlock(job) && evidence?.review?.findingList?.length
            ? `after ${REVIEW_ROUNDS} attempts the independent reviewer still blocks it: ${evidence.review.findingList.map((f) => f.message).join(' ')}`
            : (job.last_error || `the job ended as ${job.status}`);
          await actions.record(job.id, 'blocked', composeReport({ job, evidence: evidence || { changedFiles: [], testsRun: [], followUps: [], rollbackNotes: [] }, state: 'blocked', reason }));
          outcomes.push({ job: job.id, outcome: 'blocked' });
        }
        continue;
      }
      if (job.autopilot_state === 'awaiting_human') {
        // Still at the held gate: the decision is the human's; nothing to do this tick.
        const heldGate = job.autopilot_report?.gate ?? null;
        const stillHeld = GATES.has(job.status) && (await actions.listPending(job.id)).some((approval) => approval.approval_type === heldGate);
        if (stillHeld) { outcomes.push({ job: job.id, outcome: 'awaiting_human', gate: heldGate }); continue; }
        // The human decided and the job moved on: resume driving (the report stays as history).
        await actions.record(job.id, 'driving', null);
        job.autopilot_state = 'driving';
        log({ job: job.id, resumed: job.status });
      }
      if (GATES.has(job.status)) {
        const pending = await actions.listPending(job.id);
        let evidence = null;
        let hold = null;
        let cleared = 0;
        for (const approval of pending) {
          if (approval.approval_type === 'release_approval' && !evidence) {
            const snapshot = await loadBuilderRuntimeSnapshot(supabase, job.id).catch(() => null);
            evidence = snapshot ? await collectEvidence({ supabase, snapshot }).catch(() => null) : null;
          }
          hold = hold || evidentialHold({ job, approval, evidence });
          if (hold) continue;
          await actions.approve(approval.id, `Cleared by Bob autopilot: the requester asked for this change in chat (conversation ${job.autopilot_conversation_id ?? 'n/a'}). ${approval.approval_type === 'release_approval' ? 'Publishing the branch as a pull request for human review; no merge or deployment.' : 'Proceeding to implementation on the approved brief.'} No evidential paths are involved.`);
          cleared += 1;
          log({ job: job.id, cleared: approval.approval_type });
        }
        if (hold) {
          await actions.record(job.id, 'awaiting_human', composeReport({ job, evidence, state: 'awaiting_human', hold }));
          log({ job: job.id, awaiting_human: hold.gate, evidential: hold.files.slice(0, 6) });
          outcomes.push({ job: job.id, outcome: 'awaiting_human', gate: hold.gate, files: hold.files });
          continue;
        }
        outcomes.push({ job: job.id, outcome: 'gate_cleared', count: cleared });
        continue;
      }
      if (job.status === 'release_ready') {
        if (job.workspace_pull_request_url) {
          if (job.autopilot_state !== 'published') {
            const snapshot = await loadBuilderRuntimeSnapshot(supabase, job.id);
            const evidence = await collectEvidence({ supabase, snapshot });
            await actions.record(job.id, 'published', composeReport({ job, evidence, pullRequestUrl: job.workspace_pull_request_url, state: 'published' }));
          }
          outcomes.push({ job: job.id, outcome: 'published' });
          continue;
        }
        const snapshot = await loadBuilderRuntimeSnapshot(supabase, job.id);
        const evidence = await collectEvidence({ supabase, snapshot });
        if (!evidence.validatedPatchId) throw new Error('no verified patch artifact to publish');
        const automerge = automergeEligible({ job, evidence });
        const published = await actions.publish({ job, evidence, validatedPatchId: evidence.validatedPatchId, bodyFor: (branchName, headSha) => composePullRequestBody({ job, evidence, branchName, headSha, automerge }) });
        await actions.record(job.id, 'published', { ...composeReport({ job, evidence, pullRequestUrl: published.pullRequestUrl, state: 'published', automerge }), automerge: automerge.ok });
        log({ job: job.id, published: published.pullRequestUrl });
        outcomes.push({ job: job.id, outcome: 'published', url: published.pullRequestUrl });
        continue;
      }
      const run = await actions.run(job.id);
      if (run?.skipped) { outcomes.push({ job: job.id, outcome: 'running' }); continue; }
      const blockedReason = run?.reason === 'attempt_ceiling' ? run.detail : run?.reason === 'blocked' ? (run.detail || 'the Builder is blocked') : run?.reason === 'action_failed' ? (run.result?.error || run.result?.detail || 'a Builder step failed') : null;
      if (blockedReason && run?.reason !== 'action_failed') {
        const snapshot = await loadBuilderRuntimeSnapshot(supabase, job.id).catch(() => null);
        const evidence = snapshot ? await collectEvidence({ supabase, snapshot }).catch(() => null) : null;
        const baseline = baselineBlock(blockedReason);
        const mainHead = typeof actions.mainHead === 'function' ? await actions.mainHead().catch(() => null) : null;
        const mainMoved = Boolean(mainHead && job.target_sha && mainHead !== job.target_sha);
        // Main has moved past the pinned commit (someone may already have fixed the checks, or the
        // failures were the verifier's): try the same brief once on the current main before anything
        // else. A job that is itself an automatic re-open is not re-opened again.
        if ((baseline || run?.reason === 'attempt_ceiling') && mainMoved && !isRepairJob(job) && !isReopenedJob(job) && typeof actions.createJob === 'function') {
          const reopened = await actions.createJob(reopenSpec(job));
          await actions.record(job.id, 'done', { ...composeReport({ job, state: 'resumed', resumedAs: reopened.id }), repair_outcome: 'main_moved' });
          log({ job: job.id, resumed_as: reopened.id, reason: `${baseline ? 'red baseline' : 'attempt ceiling'} at an older commit; main has moved` });
          outcomes.push({ job: job.id, outcome: 'resumed', resumed_as: reopened.id });
          continue;
        }
        if (baseline && !isRepairJob(job) && typeof actions.createJob === 'function') {
          const repair = await actions.createJob(repairJobFor(job, baseline));
          await actions.record(job.id, 'blocked', composeReport({ job, evidence, state: 'repairing', reason: baseline.reason, repair }));
          log({ job: job.id, repair_job: repair.id, reason: baseline.reason.slice(0, 200) });
          outcomes.push({ job: job.id, outcome: 'repairing', repair_job: repair.id });
          continue;
        }
        await actions.record(job.id, 'blocked', composeReport({ job, evidence: evidence || { changedFiles: [], testsRun: [], followUps: [], rollbackNotes: [] }, state: 'blocked', reason: blockedReason }));
        outcomes.push({ job: job.id, outcome: 'blocked', reason: blockedReason });
        continue;
      }
      // action_failed on a retryable step is retried on the next tick; the attempt ceiling turns it into a block.
      outcomes.push({ job: job.id, outcome: 'advanced', reason: run?.reason ?? null });
    } catch (error) {
      log({ job: job.id, error: String(error instanceof Error ? error.message : error).slice(0, 300) });
      outcomes.push({ job: job.id, outcome: 'error', error: String(error instanceof Error ? error.message : error).slice(0, 300) });
    }
  }
  return outcomes;
}

async function listAutopilotJobs(supabase, limit = 5) {
  const { data, error } = await supabase
    .from('builder_jobs')
    .select('id, organization_id, project_id, title, description, task_description, status, target_sha, last_error, frontend_required, backend_required, code_review_mode, workspace_branch, workspace_head_sha, workspace_published_head_sha, workspace_pull_request_url, autopilot_requested_by, autopilot_conversation_id, autopilot_state, autopilot_report, autopilot_updated_at')
    .not('autopilot_requested_by', 'is', null)
    .in('autopilot_state', ['driving', 'awaiting_human'])
    .order('autopilot_updated_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error('autopilot jobs could not be listed');
  // Jobs parked behind a repair of main are re-checked each tick until the repair lands or fails.
  const { data: waiting, error: waitingError } = await supabase
    .from('builder_jobs')
    .select('id, organization_id, project_id, title, description, task_description, status, target_sha, last_error, frontend_required, backend_required, code_review_mode, workspace_branch, workspace_head_sha, workspace_published_head_sha, workspace_pull_request_url, autopilot_requested_by, autopilot_conversation_id, autopilot_state, autopilot_report, autopilot_updated_at')
    .not('autopilot_requested_by', 'is', null)
    .eq('autopilot_state', 'blocked')
    .not('autopilot_report->>repair_job_id', 'is', null)
    .is('autopilot_report->>resumed_as_job_id', null)
    .is('autopilot_report->>repair_outcome', null)
    .order('autopilot_updated_at', { ascending: true })
    .limit(limit);
  if (waitingError) throw new Error('autopilot jobs waiting on a repair could not be listed');
  return [...(data || []), ...(waiting || [])];
}

async function listPendingApprovals(supabase, jobId) {
  const { data, error } = await supabase.from('builder_approvals').select('id, approval_type, status').eq('job_id', jobId).eq('status', 'pending');
  if (error) throw new Error('pending approvals could not be listed');
  return data || [];
}

module.exports = { AUTOMERGE_MARK, automergeEligible, autopilotTick, baselineBlock, collectEvidence, composeReport, composePullRequestBody, evidentialHold, isRepairJob, isReopenedJob, listAutopilotJobs, listPendingApprovals, repairJobFor, TERMINAL, GATES };
