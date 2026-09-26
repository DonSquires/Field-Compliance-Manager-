// Bob autopilot: finishes Builder jobs the owner asked for in chat, the way a coding
// agent finishes a task — clear the gates on the requester's recorded instruction,
// keep the bounded runner moving, publish the verified branch, open the pull
// request, and leave a plain-language report for Bob to relay. It never merges,
// deploys, or touches protected paths (those stay human; docs/canon/BOB_DOCTRINE.md §9).
const { runBuilderUntilPause, loadBuilderRuntimeSnapshot, implementationRuns } = require('./builder-runtime-coordinator');
const { unwrapPatchArtifact } = require('./supabase/functions/_shared/builder-patch-envelope');

const TERMINAL = new Set(['failed', 'cancelled', 'deployed']);
const GATES = new Set(['specification_ready', 'approval_pending']);

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
  return {
    verifyRun,
    validatedPatchId: validatedPatch?.id ?? null,
    summary: plain(envelope?.summary ?? release?.summary ?? '', 1200),
    changedFiles,
    testsRun: Array.isArray(envelope?.tests) ? envelope.tests.map((t) => plain(t, 160)) : [],
    followUps: Array.isArray(envelope?.follow_ups) ? envelope.follow_ups.map((t) => plain(t, 300)) : [],
    rollbackNotes: Array.isArray(envelope?.rollback_notes) ? envelope.rollback_notes.map((t) => plain(t, 300)) : [],
    security: securityReport && typeof securityReport === 'object' ? { passed: securityReport.passed === true, counts: securityReport.counts ?? null } : null,
    review: reviewReport && typeof reviewReport === 'object' ? { verdict: reviewReport.verdict ?? null, summary: plain(reviewReport.summary, 800), findings: Array.isArray(reviewReport.findings) ? reviewReport.findings.length : null, model: null } : null,
    releaseNotes: release && typeof release === 'object' ? { notes: Array.isArray(release.release_notes) ? release.release_notes.map((t) => plain(t, 300)) : [], risks: Array.isArray(release.known_risks) ? release.known_risks.map((t) => plain(t, 300)) : [] } : null,
  };
}

function composeReport({ job, evidence, pullRequestUrl, state, reason }) {
  const lines = [];
  if (state === 'published') {
    lines.push(`Done: "${plain(job.title, 160)}" is built, checked, and waiting for review.`);
    if (evidence.summary) lines.push(`What changed: ${evidence.summary}`);
    lines.push(`Files touched: ${describeFiles(evidence.changedFiles)}.`);
    const checks = [];
    if (evidence.testsRun.length) checks.push(`Bob ran ${evidence.testsRun.length === 1 ? 'the test' : `${evidence.testsRun.length} test commands`} himself (${evidence.testsRun.slice(0, 3).join('; ')})`);
    if (evidence.verifyRun) checks.push('an isolated worker re-applied the change from scratch and it passed');
    if (evidence.security) checks.push(evidence.security.passed ? 'the security scan found nothing' : 'the security scan raised findings (see the pull request)');
    if (evidence.review?.verdict) checks.push(`an independent AI reviewer (a different model from the author) said "${evidence.review.verdict}"${evidence.review.summary ? `: ${evidence.review.summary}` : ''}`);
    if (checks.length) lines.push(`How it was checked: ${checks.join('; ')}.`);
    if (evidence.releaseNotes?.risks?.length) lines.push(`Known risks: ${evidence.releaseNotes.risks.join(' ')}`);
    if (evidence.followUps.length) lines.push(`Bob's notes: ${evidence.followUps.join(' ')}`);
    lines.push(pullRequestUrl ? `Where to review it: ${pullRequestUrl}` : 'The branch is published; the pull request link will follow.');
    lines.push('Nothing is live yet. When you (or your reviewer) merge the pull request, the change ships; until then the app is unchanged.');
  } else if (state === 'blocked') {
    lines.push(`Stopped: "${plain(job.title, 160)}" needs a person.`);
    lines.push(`Why: ${plain(reason, 500) || 'the Builder could not continue'}.`);
    if (evidence?.summary) lines.push(`What Bob had done so far: ${evidence.summary}`);
    lines.push('What to do: open Platform & Settings → Builder for the details, or tell Bob to try again with a changed brief.');
  }
  return {
    state,
    headline: lines[0] ?? '',
    text: lines.join('\n'),
    pull_request_url: pullRequestUrl ?? null,
    changed_files: evidence?.changedFiles ?? [],
    review_verdict: evidence?.review?.verdict ?? null,
    security_passed: evidence?.security?.passed ?? null,
    generated_at: new Date().toISOString(),
  };
}

function composePullRequestBody({ job, evidence, branchName, headSha }) {
  const md = [];
  md.push('## What this changes');
  md.push(evidence.summary || plain(job.task_description, 1500) || '(no summary recorded)');
  md.push('');
  md.push(`**Files:** ${evidence.changedFiles.map((f) => `\`${f}\``).join(', ') || 'n/a'}`);
  md.push('');
  md.push('## How it was verified');
  if (evidence.testsRun.length) md.push(`- Author ran: ${evidence.testsRun.map((t) => `\`${t}\``).join(', ')}`);
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
  md.push('- Opened by Bob Builder for human review. Bob does not merge or deploy; nothing changes in the app until a person merges this.');
  return md.join('\n');
}

/**
 * Drive one autopilot job one tick forward. `actions` is injected so the loop can be
 * exercised without a live control plane: { listPending, approve, run, publish, record }.
 */
async function autopilotTick({ supabase, jobs, actions, log = () => {} }) {
  const outcomes = [];
  for (const job of jobs) {
    try {
      if (TERMINAL.has(job.status)) {
        if (job.autopilot_state !== 'blocked' && job.autopilot_state !== 'done') {
          const snapshot = await loadBuilderRuntimeSnapshot(supabase, job.id).catch(() => null);
          const evidence = snapshot ? await collectEvidence({ supabase, snapshot }).catch(() => null) : null;
          await actions.record(job.id, 'blocked', composeReport({ job, evidence: evidence || { changedFiles: [], testsRun: [], followUps: [], rollbackNotes: [] }, state: 'blocked', reason: job.last_error || `the job ended as ${job.status}` }));
          outcomes.push({ job: job.id, outcome: 'blocked' });
        }
        continue;
      }
      if (GATES.has(job.status)) {
        const pending = await actions.listPending(job.id);
        for (const approval of pending) {
          await actions.approve(approval.id, `Cleared by Bob autopilot: the requester asked for this change in chat (conversation ${job.autopilot_conversation_id ?? 'n/a'}). ${approval.approval_type === 'release_approval' ? 'Publishing the branch as a pull request for human review; no merge or deployment.' : 'Proceeding to implementation on the approved brief.'}`);
          log({ job: job.id, cleared: approval.approval_type });
        }
        outcomes.push({ job: job.id, outcome: 'gate_cleared', count: pending.length });
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
        const published = await actions.publish({ job, evidence, validatedPatchId: evidence.validatedPatchId, bodyFor: (branchName, headSha) => composePullRequestBody({ job, evidence, branchName, headSha }) });
        await actions.record(job.id, 'published', composeReport({ job, evidence, pullRequestUrl: published.pullRequestUrl, state: 'published' }));
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
    .select('id, organization_id, title, task_description, status, target_sha, last_error, workspace_branch, workspace_head_sha, workspace_published_head_sha, workspace_pull_request_url, autopilot_requested_by, autopilot_conversation_id, autopilot_state, autopilot_updated_at')
    .not('autopilot_requested_by', 'is', null)
    .in('autopilot_state', ['driving'])
    .order('autopilot_updated_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error('autopilot jobs could not be listed');
  return data || [];
}

async function listPendingApprovals(supabase, jobId) {
  const { data, error } = await supabase.from('builder_approvals').select('id, approval_type, status').eq('job_id', jobId).eq('status', 'pending');
  if (error) throw new Error('pending approvals could not be listed');
  return data || [];
}

module.exports = { autopilotTick, collectEvidence, composeReport, composePullRequestBody, listAutopilotJobs, listPendingApprovals, TERMINAL, GATES };
