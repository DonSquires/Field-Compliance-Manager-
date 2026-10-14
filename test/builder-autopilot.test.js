const assert = require('node:assert/strict');
const test = require('node:test');

const { autopilotTick, baselineBlock, composeReport, composePullRequestBody, collectEvidence, evaluateVerificationContract, repairJobFor, routineRepairHold, isRepairJob } = require('../builder-autopilot');

const verificationSpecification = {
  workflow_verification: { before: ['preconditions'], during: ['requests and visible states'], after: ['receipt and downstream state'] },
  terrain_verification: {
    schema_checks: ['schema writer'],
    atlas_capability_checks: ['capability state'],
    flow_reach_checks: ['proven call edge'],
    fk_reach_checks: [],
    weak_reference_checks: []
  },
  human_acceptance: {
    role: 'administrator',
    route: '/admin/builder',
    job_to_be_done: 'verify the change',
    steps: ['open the affected workflow'],
    expected_visible_result: 'the corrected state is visible',
    required_states: ['success']
  }
};

// Minimal Supabase stand-in for loadBuilderRuntimeSnapshot + storage downloads.
function fakeSupabase({ job, steps = [], artifacts = [], workerRuns = [], objects = {} }) {
  const table = (rows) => ({
    select() { return this; },
    eq() { return this; },
    order() { return this; },
    single: async () => ({ data: rows[0] ?? null, error: rows.length ? null : { message: 'missing' } }),
    then(resolve) { return resolve({ data: rows, error: null }); },
  });
  return {
    from(name) {
      if (name === 'builder_jobs') return table([job]);
      if (name === 'builder_job_steps') return table(steps);
      if (name === 'builder_artifacts') return table(artifacts);
      if (name === 'builder_worker_runs') return table(workerRuns);
      throw new Error(`unexpected table ${name}`);
    },
    storage: { from: () => ({ download: async (path) => (objects[path] ? { data: { arrayBuffer: async () => Buffer.from(objects[path]) }, error: null } : { data: null, error: { message: 'missing' } }) }) },
  };
}

function actionsRecorder(overrides = {}) {
  const calls = [];
  return {
    calls,
    listPending: async (jobId) => { calls.push(['listPending', jobId]); return overrides.pending ?? []; },
    approve: async (id, comment) => { calls.push(['approve', id, comment]); },
    run: async (jobId) => { calls.push(['run', jobId]); return overrides.run ?? { paused: true, reason: 'waiting_for_human' }; },
    publish: async ({ job, validatedPatchId, bodyFor }) => { calls.push(['publish', job.id, validatedPatchId, bodyFor('bob/job-x', 'deadbeef')]); return { pullRequestUrl: 'https://git.example/pulls/9' }; },
    fail: async (jobId, reason) => { calls.push(['fail', jobId, reason]); },
    record: async (jobId, state, report) => { calls.push(['record', jobId, state, report]); },
  };
}

test('autopilot clears a pending gate on the requester\'s behalf and does nothing else that tick', async () => {
  const job = { id: 'job-1', status: 'specification_ready', autopilot_state: 'driving', autopilot_conversation_id: 'conv-1', title: 'Fix', target_sha: 'a'.repeat(40) };
  const actions = actionsRecorder({ pending: [{ id: 'appr-1', approval_type: 'specification_review', status: 'pending' }] });
  const outcomes = await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-1', outcome: 'gate_cleared', count: 1 }]);
  assert.equal(actions.calls[1][0], 'approve');
  assert.match(actions.calls[1][2], /asked for this change in chat \(conversation conv-1\)/);
  assert.ok(!actions.calls.some(([name]) => name === 'run' || name === 'publish'));
});

test('routine monitor clears a bounded basic fix but holds redesign or broad patches', () => {
  const approval = { approval_type: 'specification_review' };
  const routine = {
    id: 'routine-job',
    autopilot_source: 'routine_monitor',
    repair_risk: 'routine',
    title: 'Routine repair: reports',
    task_description: 'Fix the render failure with the smallest corrective patch.',
  };
  assert.equal(routineRepairHold({ job: routine, approval, evidence: null }), null);
  assert.match(
    routineRepairHold({ job: { ...routine, task_description: 'Redesign the reports page' }, approval, evidence: null }).reasons[0],
    /expanded beyond a basic fix/,
  );
  const release = routineRepairHold({
    job: routine,
    approval: { approval_type: 'release_approval' },
    evidence: { changedFiles: Array.from({ length: 9 }, (_, index) => `file-${index}.ts`) },
  });
  assert.match(release.reasons[0], /more than eight files/);
});

test('main-monitor repairs stay inside the failing guard-test set', () => {
  const job = {
    autopilot_source: 'main_monitor',
    repair_risk: 'routine',
    title: 'Repair red main tests',
    task_description: 'Correct stale source-contract assertions; inspect schema but do not change it.',
    source_main_health_files: ['apps/web/src/lib/example.guard.test.ts'],
  };
  const approval = { approval_type: 'release_approval' };
  assert.equal(routineRepairHold({
    job,
    approval,
    evidence: { changedFiles: ['apps/web/src/lib/example.guard.test.ts'] },
  }), null);
  assert.match(routineRepairHold({
    job,
    approval,
    evidence: { changedFiles: ['apps/web/src/lib/example.guard.test.ts', 'apps/web/src/lib/example.ts'] },
  }).reasons[0], /outside the recorded failing test set/);
  assert.match(routineRepairHold({
    job: { ...job, source_main_health_files: [] },
    approval,
    evidence: { changedFiles: [] },
  }).reasons[0], /outside the recorded failing test set/);
});

test('autopilot runs the bounded runner for a working job and blocks when the attempt ceiling is hit', async () => {
  const job = { id: 'job-2', status: 'implementation_pending', autopilot_state: 'driving', title: 'Fix', target_sha: 'b'.repeat(40) };
  const running = actionsRecorder({ run: { paused: true, reason: 'action_limit' } });
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions: running }), [{ job: 'job-2', outcome: 'advanced', reason: 'action_limit' }]);
  const ceiling = actionsRecorder({ run: { paused: true, reason: 'attempt_ceiling', detail: 'backend_implementation failed 6 times (ceiling 6); last failure: Backend worker verification failed' } });
  ceiling.mainHead = async () => job.target_sha;
  const outcomes = await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions: ceiling });
  assert.equal(outcomes[0].outcome, 'blocked');
  const failed = ceiling.calls.find(([name]) => name === 'fail');
  assert.equal(failed[1], 'job-2');
  assert.match(failed[2], /failed 6 times/);
  const recorded = ceiling.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'blocked');
  assert.match(recorded[3].text, /^Stopped: Bob could not finish "Fix" on his own\./);
  assert.match(recorded[3].text, /failed 6 times/);
  assert.match(recorded[3].text, /What you can do: tell Bob "try again"/);
});

test('autopilot skips a job whose run is already in flight and retries a retryable step failure next tick', async () => {
  const job = { id: 'job-3', status: 'implementation_pending', autopilot_state: 'driving', title: 'Fix', target_sha: 'c'.repeat(40) };
  const busy = actionsRecorder({ run: { skipped: true, already_running: true } });
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions: busy }), [{ job: 'job-3', outcome: 'running' }]);
  const failed = actionsRecorder({ run: { paused: true, reason: 'action_failed', result: { success: false, error: 'Backend worker verification failed' } } });
  const outcomes = await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions: failed });
  assert.deepEqual(outcomes, [{ job: 'job-3', outcome: 'advanced', reason: 'action_failed' }]);
  assert.ok(!failed.calls.some(([name]) => name === 'record'), 'a retryable failure is not reported as blocked');
});

function releaseReadyFixture() {
  const org = '56710c19-d604-4767-9ad8-9c5863b4ceb7';
  const job = { id: 'job-4', organization_id: org, status: 'release_ready', autopilot_state: 'driving', title: "Accept 'go for it' as a yes", task_description: 'brief', target_sha: 'd'.repeat(40), workspace_pull_request_url: null };
  const steps = [
    { id: 's-product', step_id: 'product_analysis', builder_mode: 'product_analyst', status: 'completed' },
    { id: 's-backend', step_id: 'backend_implementation', builder_mode: 'backend_engineer', status: 'completed' },
    { id: 's-security', step_id: 'security_review', builder_mode: 'qa_security_reviewer', status: 'completed' },
    { id: 's-review', step_id: 'code_review', builder_mode: 'code_reviewer', status: 'completed' },
    { id: 's-release', step_id: 'release_prep', builder_mode: 'release_engineer', status: 'completed' },
  ];
  const loc = (name) => `supabase_storage://builder-artifacts/${org}/job-4/${name}`;
  const artifacts = [
    { id: 'spec', step_id: 's-product', artifact_type: 'product_specification', status: 'final', storage_location: loc('spec.json') },
    { id: 'proposal', step_id: 's-backend', artifact_type: 'code_implementation', status: 'final', storage_location: loc('proposal.json') },
    { id: 'validated', step_id: 's-backend', artifact_type: 'code_implementation', status: 'final', storage_location: loc('validated.patch') },
    { id: 'manifest', step_id: 's-backend', artifact_type: 'changed_file_manifest', status: 'final', storage_location: loc('changed-files.json') },
    { id: 'verification', step_id: 's-backend', artifact_type: 'build_logs', status: 'final', storage_location: loc('verification.json') },
    { id: 'security', step_id: 's-security', artifact_type: 'security_review', status: 'final', storage_location: loc('security.json') },
    { id: 'review', step_id: 's-review', artifact_type: 'code_review', status: 'final', storage_location: loc('review.json') },
    { id: 'notes', step_id: 's-release', artifact_type: 'release_notes', status: 'final', storage_location: loc('notes.json') },
  ];
  const workerRuns = [{ id: 'run-ok', step_id: 's-backend', status: 'completed', profile: 'backend-verify', patch_artifact_id: 'proposal', output_artifact_ids: ['verification', 'validated', 'manifest'] }];
  const objects = {
    [`${org}/job-4/spec.json`]: JSON.stringify(verificationSpecification),
    [`${org}/job-4/proposal.json`]: JSON.stringify({ summary: "Added 'go for it' and 'yes please' to the blanket-affirmative check so Bob stops re-asking.", patch: 'diff --git a/x b/x\n', changed_files: ['services/fcm-api/src/bob/verify.js'], tests: ['node --test test/fcm-api-bob-planner.test.js'], rollback_notes: ['Revert the pull request.'], follow_ups: ['I could not run the wider chat suite here.'] }),
    [`${org}/job-4/changed-files.json`]: JSON.stringify([{ path: 'services/fcm-api/src/bob/verify.js' }, { path: 'test/fcm-api-bob-planner.test.js' }]),
    [`${org}/job-4/verification.json`]: JSON.stringify({ succeeded: true, data_path: { checked: true }, checks: [{ command: 'data-path gate: caller-scoped reads vs row-level security (supabase/schema.sql)', status: 0 }, { command: 'node scripts/atlas-refresh.js', status: 0 }] }),
    [`${org}/job-4/security.json`]: JSON.stringify({ passed: true, counts: { critical: 0, high: 0, medium: 0, low: 0 } }),
    [`${org}/job-4/review.json`]: JSON.stringify({ verdict: 'passed', summary: 'Narrow regex change with tests; no auth or data exposure.', findings: [] }),
    [`${org}/job-4/notes.json`]: JSON.stringify({ release_notes: ['Bob accepts more ways of saying yes.'], known_risks: [] }),
  };
  return { job, supabase: fakeSupabase({ job, steps, artifacts, workerRuns, objects }) };
}

test('autopilot publishes a release-ready job with an explanatory pull request and a plain-language report', async () => {
  const { job, supabase } = releaseReadyFixture();
  const actions = actionsRecorder();
  const outcomes = await autopilotTick({ supabase, jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-4', outcome: 'published', url: 'https://git.example/pulls/9' }]);
  const publish = actions.calls.find(([name]) => name === 'publish');
  assert.equal(publish[2], 'validated', 'the worker-validated diff is what gets committed');
  const prBody = publish[3];
  assert.match(prBody, /## What this changes/);
  assert.match(prBody, /Added 'go for it' and 'yes please'/);
  assert.match(prBody, /Independent worker \(`backend-verify`\).*\*\*passed\*\*/);
  assert.match(prBody, /Security scan: \*\*passed\*\*/);
  assert.match(prBody, /Independent AI code review.*\*\*passed\*\*/);
  assert.match(prBody, /Bob does not merge or deploy/);
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'published');
  const report = recorded[3];
  assert.match(report.text, /^Done: "Accept 'go for it' as a yes" is built, checked, and waiting for review\./);
  assert.match(report.text, /What changed: Added 'go for it'/);
  assert.match(report.text, /Files touched: services\/fcm-api\/src\/bob\/verify\.js, test\/fcm-api-bob-planner\.test\.js\./);
  assert.match(report.text, /Bob ran the test himself/);
  assert.match(report.text, /an independent AI reviewer \(a different model from the author\) said "passed"/);
  assert.match(report.text, /Where to review it: https:\/\/git\.example\/pulls\/9/);
  assert.match(report.text, /Nothing is live yet/);
  assert.equal(report.pull_request_url, 'https://git.example/pulls/9');
  assert.equal(report.review_verdict, 'passed');
  assert.equal(report.security_passed, true);
});

test('autopilot records a directly merged main-health repair as complete', async () => {
  const { job, supabase } = releaseReadyFixture();
  const actions = actionsRecorder();
  actions.publish = async () => ({ pullRequestUrl: 'https://github.com/owner/repo/pull/17', merged: true, mergeSha: 'e'.repeat(40) });
  const outcomes = await autopilotTick({ supabase, jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-4', outcome: 'merged', url: 'https://github.com/owner/repo/pull/17' }]);
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'published');
  assert.equal(recorded[3].merged, true);
  assert.equal(recorded[3].merge_sha, 'e'.repeat(40));
  assert.match(recorded[3].text, /Bob repaired the failing checks/);
});

test('autopilot resumes an interrupted eligible publication instead of parking its recorded PR', async () => {
  const { job, supabase } = releaseReadyFixture();
  Object.assign(job, {
    autopilot_requested_by: 'user-1',
    autopilot_source: 'main_monitor',
    autopilot_state: 'published',
    autopilot_report: { merged: false },
    workspace_pull_request_url: 'https://github.com/owner/repo/pull/26',
  });
  const actions = actionsRecorder();
  actions.publish = async ({ validatedPatchId, automerge }) => {
    actions.calls.push(['publish', job.id, validatedPatchId, automerge]);
    return { pullRequestUrl: job.workspace_pull_request_url, merged: true, mergeSha: 'e'.repeat(40) };
  };
  const previous = process.env.BOB_AUTOPILOT_AUTOMERGE;
  process.env.BOB_AUTOPILOT_AUTOMERGE = 'true';
  let outcomes;
  try {
    outcomes = await autopilotTick({ supabase, jobs: [job], actions });
  } finally {
    if (previous === undefined) delete process.env.BOB_AUTOPILOT_AUTOMERGE;
    else process.env.BOB_AUTOPILOT_AUTOMERGE = previous;
  }
  assert.deepEqual(outcomes, [{ job: 'job-4', outcome: 'merged', url: job.workspace_pull_request_url }]);
  const publish = actions.calls.find(([name]) => name === 'publish');
  assert.equal(publish[2], 'validated');
  assert.equal(publish[3].ok, true);
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[3].merged, true);
  assert.equal(recorded[3].merge_sha, 'e'.repeat(40));
});

test('autopilot marks a merged job deployed only after production and live verification', async () => {
  const { job, supabase } = releaseReadyFixture();
  Object.assign(job, {
    autopilot_state: 'published',
    workspace_pull_request_url: 'https://github.com/owner/repo/pull/17',
    autopilot_report: { merged: true, merge_sha: 'e'.repeat(40) },
  });
  const actions = actionsRecorder();
  actions.verifyRelease = async () => ({
    status: 'success',
    source_sha: 'e'.repeat(40),
    target_url: 'https://app.example.test',
    live_verified: true,
  });
  actions.markDeployed = async (jobId, release) => { actions.calls.push(['markDeployed', jobId, release]); };
  const outcomes = await autopilotTick({ supabase, jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-4', outcome: 'deployed', url: 'https://app.example.test' }]);
  assert.ok(actions.calls.some(([name]) => name === 'markDeployed'));
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'done');
  assert.equal(recorded[3].deployment.live_verified, true);
  assert.match(recorded[3].text, /^Live: Bob built, independently verified, merged, deployed, and checked/);
});

test('autopilot keeps a merged job pending until production deployment exists', async () => {
  const job = {
    id: 'job-pending-release',
    status: 'release_ready',
    autopilot_state: 'published',
    workspace_pull_request_url: 'https://github.com/owner/repo/pull/18',
    autopilot_report: { merged: true, merge_sha: 'f'.repeat(40) },
  };
  const actions = actionsRecorder();
  actions.verifyRelease = async () => ({ status: 'pending' });
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions }), [{
    job: 'job-pending-release',
    outcome: 'deploying',
    merge_sha: 'f'.repeat(40),
  }]);
  assert.ok(!actions.calls.some(([name]) => name === 'record' || name === 'fail'));
});

test('autopilot records a blocked report for a job that ended terminally without a pull request', async () => {
  const job = { id: 'job-5', status: 'failed', last_error: 'Independent AI review retry limit reached', autopilot_state: 'driving', title: 'Fix', target_sha: 'e'.repeat(40) };
  const actions = actionsRecorder();
  const outcomes = await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-5', outcome: 'blocked' }]);
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'blocked');
  assert.match(recorded[3].text, /Why: Independent AI review retry limit reached/);
});

test('a job the independent reviewer blocked is re-opened with the findings folded into the brief, twice at most (live job 019d2088)', async () => {
  const org = '56710c19-d604-4767-9ad8-9c5863b4ceb7';
  const base = { organization_id: org, project_id: 'proj-1', status: 'failed', last_error: 'Independent AI code review found blocking defects', autopilot_state: 'driving', autopilot_requested_by: 'user-1', autopilot_conversation_id: 'conv-9', title: 'Redo chat cancel_builder_job tool', task_description: 'Symptom: … Required behaviour: (3) the same two-turn confirmation as laptop_shell, including the planner RESUME block.', target_sha: 'f'.repeat(40), frontend_required: false, backend_required: true, code_review_mode: 'independent_ai' };
  const steps = [{ id: 's-review', step_id: 'code_review', builder_mode: 'code_reviewer', status: 'failed' }, { id: 's-backend', step_id: 'backend_implementation', builder_mode: 'backend_engineer', status: 'completed' }];
  const artifacts = [
    { id: 'review', step_id: 's-review', artifact_type: 'code_review', status: 'final', storage_location: `supabase_storage://builder-artifacts/${org}/job-r/review.json` },
    { id: 'proposal', step_id: 's-backend', artifact_type: 'code_implementation', status: 'final', storage_location: `supabase_storage://builder-artifacts/${org}/job-r/proposal.json` },
    { id: 'validated', step_id: 's-backend', artifact_type: 'code_implementation', status: 'final', storage_location: `supabase_storage://builder-artifacts/${org}/job-r/validated.patch` },
  ];
  const workerRuns = [{ id: 'run-ok', step_id: 's-backend', status: 'completed', profile: 'backend-verify', patch_artifact_id: 'proposal', output_artifact_ids: ['validated'] }];
  const objects = { [`${org}/job-r/review.json`]: JSON.stringify({ verdict: 'blocked', summary: 'The pending cancellation is persisted and reloaded but never wired into the planner continuation path.', findings: [{ severity: 'high', file: 'supabase/functions/onspace-ai-chat/index.ts', message: 'The new builder_cancellation_pending kind has no corresponding planner RESUME wiring, so a bare "yes" is not routed back to cancel_builder_job.' }], test_gaps: ['No test covers the affirmative turn routing back to the tool.'], residual_risks: [] }) };

  // Round 1: the failed job is re-opened; the new brief carries the finding, the round marker and the seed patch.
  const job = { ...base, id: 'job-r', description: null };
  const actions = actionsRecorder();
  const created = [];
  actions.createJob = async (spec) => { created.push(spec); return { id: 'job-r2' }; };
  const outcomes = await autopilotTick({ supabase: fakeSupabase({ job, steps, artifacts, workerRuns, objects }), jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-r', outcome: 'review_reopened', resumed_as: 'job-r2' }]);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, job.title);
  assert.equal(created[0].parentJobId, 'job-r');
  assert.equal(created[0].requestedBy, 'user-1');
  assert.equal(created[0].conversationId, 'conv-9');
  assert.match(created[0].taskDescription, /^Symptom: …/);
  assert.match(created[0].taskDescription, /INDEPENDENT REVIEW OF THE PREVIOUS ATTEMPT \(job job-r\) BLOCKED IT/);
  assert.match(created[0].taskDescription, /- \[high\] supabase\/functions\/onspace-ai-chat\/index\.ts: The new builder_cancellation_pending kind has no corresponding planner RESUME wiring/);
  assert.match(created[0].taskDescription, /Test gaps the reviewer named:\n- No test covers the affirmative turn/);
  assert.match(created[0].taskDescription, /START FROM THE PREVIOUS ATTEMPT: its verified change is applied to your worktree/);
  assert.equal(created[0].description, "Opened by Bob's autopilot from job job-r after independent review (round 1 of 2) [[seed_patch:validated]]");
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'done');
  assert.match(recorded[3].text, /^Revising: an independent AI reviewer .* found problems with Bob's attempt/);
  assert.match(recorded[3].text, /What the reviewer found: The new builder_cancellation_pending kind/);
  assert.equal(recorded[3].resumed_as_job_id, 'job-r2');
  assert.equal(recorded[3].repair_outcome, 'review_reopened');

  // Round 2 fails too: re-opened once more (round 2 of 2). Without a verified patch there is no seed.
  const second = { ...base, id: 'job-r2', description: "Opened by Bob's autopilot from job job-r after independent review (round 1 of 2) [[seed_patch:validated]]" };
  const actions2 = actionsRecorder();
  const created2 = [];
  actions2.createJob = async (spec) => { created2.push(spec); return { id: 'job-r3' }; };
  assert.equal((await autopilotTick({ supabase: fakeSupabase({ job: second, steps: steps.slice(0, 1), artifacts: artifacts.slice(0, 1), objects }), jobs: [second], actions: actions2 }))[0].outcome, 'review_reopened');
  assert.match(created2[0].description, /round 2 of 2\)$/);
  assert.doesNotMatch(created2[0].taskDescription, /START FROM THE PREVIOUS ATTEMPT/);

  // Round 3 would exceed the bound: blocked, in plain language, with the reviewer's words.
  const third = { ...base, id: 'job-r3', description: "Opened by Bob's autopilot from job job-r2 after independent review (round 2 of 2)" };
  const actions3 = actionsRecorder();
  actions3.createJob = async () => { throw new Error('must not re-open a third time'); };
  const out3 = await autopilotTick({ supabase: fakeSupabase({ job: third, steps, artifacts, objects }), jobs: [third], actions: actions3 });
  assert.deepEqual(out3, [{ job: 'job-r3', outcome: 'blocked' }]);
  const blocked = actions3.calls.find(([name]) => name === 'record');
  assert.equal(blocked[2], 'blocked');
  assert.match(blocked[3].text, /after 2 attempts the independent reviewer still blocks it: The new builder_cancellation_pending kind/);

  // Other terminal failures are untouched by this path.
  const other = { ...base, id: 'job-o', last_error: 'Independent AI review retry limit reached' };
  const actions4 = actionsRecorder();
  actions4.createJob = async () => { throw new Error('not a review block'); };
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job: other }), jobs: [other], actions: actions4 }), [{ job: 'job-o', outcome: 'blocked' }]);
});

test('auto-merge is env-gated and narrow: every independent check clean, requested in chat, nothing evidential; the PR body carries the marker and the report says so', async () => {
  const { automergeEligible, AUTOMERGE_MARK } = require('../builder-autopilot');
  const job = { id: 'job-am', autopilot_requested_by: 'user-1', title: 'Fix', target_sha: 'a'.repeat(40), task_description: 'brief' };
  const clean = { verifyRun: { profile: 'backend-verify' }, verificationContract: { passed: true, failures: [], worker_verified: true, atlas_verified: true, glass_verified: true, schema_verified: true }, security: { passed: true, counts: {} }, review: { verdict: 'passed', summary: 'checked the data path', findings: 1, findingList: [{ severity: 'low', file: 'x', message: 'nit' }], testGaps: ['none named'] }, changedFiles: ['services/fcm-api/src/bob/verify.js'], testsRun: [], followUps: [], rollbackNotes: [], summary: 's' };
  assert.equal(automergeEligible({ job, evidence: clean, env: {} }).ok, false, 'off by default');
  const on = { BOB_AUTOPILOT_AUTOMERGE: 'true' };
  assert.equal(automergeEligible({ job, evidence: clean, env: on }).ok, true);
  assert.equal(automergeEligible({ job: { ...job, autopilot_requested_by: null }, evidence: clean, env: on }).ok, false, 'not asked for in chat');
  const mainHealthJob = {
    ...job,
    autopilot_requested_by: null,
    autopilot_source: 'main_monitor',
    repair_risk: 'routine',
    source_main_health_files: ['apps/web/src/lib/example.guard.test.ts'],
  };
  const mainHealthEvidence = {
    ...clean,
    verifyRun: { profile: 'main-health' },
    changedFiles: ['apps/web/src/lib/example.guard.test.ts'],
  };
  assert.equal(automergeEligible({ job: mainHealthJob, evidence: mainHealthEvidence, env: on }).ok, true, 'bounded main-health repair is eligible without a human requester');
  assert.match(automergeEligible({ job: mainHealthJob, evidence: { ...mainHealthEvidence, changedFiles: [...mainHealthEvidence.changedFiles, 'apps/web/src/lib/example.ts'] }, env: on }).reason, /outside the failing source-guard set/);
  assert.equal(automergeEligible({ job: { ...mainHealthJob, source_main_health_files: [] }, evidence: mainHealthEvidence, env: on }).ok, false, 'missing failing-file provenance blocks auto-merge');
  assert.equal(automergeEligible({ job, evidence: { ...clean, verifyRun: null }, env: on }).ok, false, 'no worker verification');
  assert.equal(automergeEligible({ job, evidence: { ...clean, security: { passed: false } }, env: on }).ok, false, 'security findings');
  assert.equal(automergeEligible({ job, evidence: { ...clean, review: { ...clean.review, verdict: 'blocked' } }, env: on }).ok, false, 'review blocked');
  assert.equal(automergeEligible({ job, evidence: { ...clean, verificationContract: { passed: false, failures: ['glass missing'] } }, env: on }).ok, false, 'verification contract incomplete');
  assert.equal(automergeEligible({ job, evidence: { ...clean, review: { ...clean.review, findingList: [{ severity: 'high', file: 'x', message: 'bad' }] } }, env: on }).ok, false, 'a high finding on a passed review still blocks');
  assert.match(automergeEligible({ job, evidence: { ...clean, changedFiles: ['apps/mobile/src/screens/Evidence.tsx'] }, env: on }).reason, /evidential paths need a person/);
  const eligible = automergeEligible({ job, evidence: clean, env: on });
  const body = composePullRequestBody({ job, evidence: clean, branchName: 'bob/job-am', headSha: 'deadbeef', automerge: eligible });
  assert.ok(body.includes(AUTOMERGE_MARK));
  assert.match(body, /Auto-merge: Bob merges this himself/);
  assert.doesNotMatch(composePullRequestBody({ job, evidence: clean, branchName: 'b', headSha: 'd' }), /bob-automerge/);
  const report = composeReport({ job, evidence: clean, pullRequestUrl: 'https://git.example/pulls/1', state: 'published', automerge: eligible });
  assert.match(report.text, /Bob will merge this himself within about ten minutes/);
  assert.match(composeReport({ job, evidence: clean, pullRequestUrl: 'u', state: 'published' }).text, /Nothing is live yet/);
  assert.match(composeReport({ job: mainHealthJob, evidence: mainHealthEvidence, pullRequestUrl: 'https://github.com/org/repo/pull/1', state: 'merged' }).text, /Bob repaired the failing checks/);
});

test('verification contract requires product, schema/data-path, and human-glass evidence', () => {
  const backend = evaluateVerificationContract({
    changedFiles: ['supabase/functions/example/index.ts'],
    specification: verificationSpecification,
    verification: { succeeded: true, data_path: { checked: true }, checks: [{ command: 'node scripts/atlas-refresh.js', status: 0 }] },
    verifyRun: { profile: 'backend-verify' }
  });
  assert.equal(backend.passed, true);

  const web = evaluateVerificationContract({
    changedFiles: ['apps/web/src/pages/ExamplePage.tsx'],
    specification: verificationSpecification,
    verification: { succeeded: true, commands: [{ command: 'npm run test:e2e --prefix apps/web', status: 0 }, { command: 'node scripts/atlas-refresh.js', status: 0 }] },
    verifyRun: { profile: 'frontend-verify' }
  });
  assert.equal(web.passed, true);

  const missing = evaluateVerificationContract({
    changedFiles: ['apps/web/src/pages/ExamplePage.tsx'],
    specification: {},
    verification: { succeeded: true, commands: [] },
    verifyRun: { profile: 'frontend-verify' }
  });
  assert.equal(missing.passed, false);
  assert.match(missing.failures.join(' '), /product specification/);
  assert.match(missing.failures.join(' '), /Playwright/);
});

test('report and pull-request composers degrade honestly when evidence is thin', () => {
  const evidence = { changedFiles: [], testsRun: [], followUps: [], rollbackNotes: [], summary: '', verifyRun: null, security: null, review: null, releaseNotes: null };
  const report = composeReport({ job: { title: 'T' }, evidence, pullRequestUrl: null, state: 'published' });
  assert.match(report.text, /Files touched: no files\./);
  assert.match(report.text, /The branch is published; the pull request link will follow\./);
  assert.doesNotMatch(report.text, /How it was checked/);
  const body = composePullRequestBody({ job: { id: 'j', target_sha: 'f'.repeat(40), task_description: 'brief text' }, evidence, branchName: 'bob/job-j', headSha: 'abc' });
  assert.match(body, /brief text/);
  assert.match(body, /\*\*Files:\*\* n\/a/);
});

// Owner ruling 2026-09-26: human approval is required for evidential work.
test('autopilot holds the specification gate for a human when the brief names evidential work, and resumes after the decision', async () => {
  const job = { id: 'job-6', status: 'specification_ready', autopilot_state: 'driving', autopilot_conversation_id: 'conv-6', title: 'Parking notice PDF shows the wrong plate', task_description: 'Symptom: supabase/functions/generate-parking-notice/index.ts prints the previous vehicle plate. Change: read the plate from the observation row.', target_sha: 'f'.repeat(40) };
  const actions = actionsRecorder({ pending: [{ id: 'appr-6', approval_type: 'specification_review', status: 'pending' }] });
  const outcomes = await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-6', outcome: 'awaiting_human', gate: 'specification_review', files: ['supabase/functions/generate-parking-notice/index.ts'] }]);
  assert.ok(!actions.calls.some(([name]) => name === 'approve'), 'the autopilot never clears an evidential gate');
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'awaiting_human');
  assert.match(recorded[3].text, /^Needs your approval: "Parking notice PDF shows the wrong plate" touches evidential work, so Bob has paused at the specification gate/);
  assert.match(recorded[3].text, /What is evidential here: supabase\/functions\/generate-parking-notice\/index\.ts\./);
  assert.match(recorded[3].text, /Bob continues only after your decision/);
  assert.equal(recorded[3].gate, 'specification_review');
  assert.deepEqual(recorded[3].evidential_files, ['supabase/functions/generate-parking-notice/index.ts']);

  // Still held while the same gate is pending: nothing happens.
  const waiting = { ...job, autopilot_state: 'awaiting_human', autopilot_report: recorded[3] };
  const idle = actionsRecorder({ pending: [{ id: 'appr-6', approval_type: 'specification_review', status: 'pending' }] });
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job: waiting }), jobs: [waiting], actions: idle }), [{ job: 'job-6', outcome: 'awaiting_human', gate: 'specification_review' }]);
  assert.deepEqual(idle.calls.map(([name]) => name), ['listPending']);

  // The human approved the specification: the job moved on and the autopilot resumes driving.
  const approved = { ...waiting, status: 'design_pending' };
  const resumed = actionsRecorder({ run: { paused: true, reason: 'action_limit' } });
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job: approved }), jobs: [approved], actions: resumed }), [{ job: 'job-6', outcome: 'advanced', reason: 'action_limit' }]);
  assert.deepEqual(resumed.calls[0], ['record', 'job-6', 'driving', null]);
  assert.equal(resumed.calls[1][0], 'run');
});

test('autopilot holds the release gate when the verified patch touched evidential files, even if the brief did not say so', async () => {
  const { job, supabase } = releaseReadyFixture();
  const held = { ...job, status: 'approval_pending' };
  const supabaseWithEvidentialManifest = (() => {
    const base = supabase;
    const original = base.storage.from;
    base.storage.from = () => ({ download: async (path) => (path.endsWith('changed-files.json')
      ? { data: { arrayBuffer: async () => Buffer.from(JSON.stringify([{ path: 'services/fcm-api/src/bob/verify.js' }, { path: 'supabase/functions/generate-noise-evidence-package/index.ts' }])) }, error: null }
      : original().download(path)) });
    return base;
  })();
  const actions = actionsRecorder({ pending: [{ id: 'appr-7', approval_type: 'release_approval', status: 'pending' }] });
  const outcomes = await autopilotTick({ supabase: supabaseWithEvidentialManifest, jobs: [held], actions });
  assert.deepEqual(outcomes, [{ job: 'job-4', outcome: 'awaiting_human', gate: 'release_approval', files: ['supabase/functions/generate-noise-evidence-package/index.ts'] }]);
  assert.ok(!actions.calls.some(([name]) => name === 'approve' || name === 'publish'));
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.match(recorded[3].text, /paused at the release gate/);
  assert.match(recorded[3].text, /What Bob has done so far: Added 'go for it'/);
  assert.match(recorded[3].text, /independent AI reviewer .* said "passed"/);
});

test('autopilot still clears the release gate itself for non-evidential work', async () => {
  const { job, supabase } = releaseReadyFixture();
  const gated = { ...job, status: 'approval_pending' };
  const actions = actionsRecorder({ pending: [{ id: 'appr-8', approval_type: 'release_approval', status: 'pending' }] });
  assert.deepEqual(await autopilotTick({ supabase, jobs: [gated], actions }), [{ job: 'job-4', outcome: 'gate_cleared', count: 1 }]);
  assert.match(actions.calls.find(([name]) => name === 'approve')[2], /No evidential paths are involved/);
});

test('a job blocked by a red main opens a repair job for the same requester instead of asking a person to fix it', async () => {
  const detail = 'repository red at the pinned commit: npm run test --prefix apps/web -- --pool=threads also fails on the pinned commit without this patch (the repository is red at the target commit: src/pages/FinanceBureauPage.guard.test.ts, src/pages/NzscvSupplierPage.guard.test.ts); not caused by this change';
  const baseline = baselineBlock(detail);
  assert.deepEqual(baseline.files, ['src/pages/FinanceBureauPage.guard.test.ts', 'src/pages/NzscvSupplierPage.guard.test.ts']);
  assert.deepEqual(baselineBlock(`baseline: ${detail}`), baseline);
  assert.equal(baselineBlock('backend_implementation failed 6 times (ceiling 6)'), null);
  const job = { id: 'job-r', organization_id: 'org-1', project_id: 'proj-1', status: 'implementation_pending', autopilot_state: 'driving', autopilot_requested_by: 'user-1', autopilot_conversation_id: 'conv-1', title: 'Add Cancel control', task_description: 'brief', frontend_required: true, backend_required: false, target_sha: 'c'.repeat(40) };
  const repairSpec = repairJobFor(job, baseline);
  assert.equal(repairSpec.title, 'Repair main: 2 failing checks (FinanceBureauPage.guard.test.ts, NzscvSupplierPage.guard.test.ts)');
  assert.equal(repairSpec.frontendRequired, true);
  assert.equal(repairSpec.backendRequired, false);
  assert.equal(repairSpec.requestedBy, 'user-1');
  assert.match(repairSpec.taskDescription, /apps\/web\/src\/pages\/FinanceBureauPage\.guard\.test\.ts/);
  assert.match(repairSpec.taskDescription, /Acceptance test: the failing command passes/);
  assert.equal(isRepairJob({ title: repairSpec.title }), true);

  // Main has moved past the pinned commit: the checks may already be fixed, so the same brief is
  // tried again on current main before any repair is opened.
  const moved = actionsRecorder({ run: { paused: true, reason: 'blocked', detail } });
  moved.mainHead = async () => 'd'.repeat(40);
  const reopened = [];
  moved.createJob = async (spec) => { reopened.push(spec); return { id: 'job-r2' }; };
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions: moved }), [{ job: 'job-r', outcome: 'resumed', resumed_as: 'job-r2' }]);
  assert.equal(reopened[0].title, 'Add Cancel control');
  assert.equal(moved.calls.find(([name]) => name === 'record')[3].repair_outcome, 'main_moved');

  const actions = actionsRecorder({ run: { paused: true, reason: 'blocked', detail } });
  actions.mainHead = async () => job.target_sha;
  const created = [];
  actions.createJob = async (spec) => { created.push(spec); return { id: 'job-repair', title: spec.title }; };
  const outcomes = await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions });
  assert.deepEqual(outcomes, [{ job: 'job-r', outcome: 'repairing', repair_job: 'job-repair' }]);
  assert.equal(created.length, 1);
  const recorded = actions.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'blocked');
  assert.equal(recorded[3].state, 'repairing');
  assert.equal(recorded[3].repair_job_id, 'job-repair');
  assert.match(recorded[3].text, /^Paused: "Add Cancel control" is waiting while Bob fixes the app's own checks first\./);
  assert.match(recorded[3].text, /not caused by the change you asked for/);
  assert.match(recorded[3].text, /Nothing for you to do now\./);

  // A repair job that is itself blocked by a red main does not open another repair (no loops).
  const repairJob = { ...job, id: 'job-repair', title: repairSpec.title };
  const again = actionsRecorder({ run: { paused: true, reason: 'blocked', detail } });
  again.createJob = async () => { throw new Error('must not recurse'); };
  const loopOutcome = await autopilotTick({ supabase: fakeSupabase({ job: repairJob }), jobs: [repairJob], actions: again });
  assert.equal(loopOutcome[0].outcome, 'blocked');
});

test('a job waiting on a repair is re-opened on current main once the repair has landed, or reported plainly if the repair failed', async () => {
  const waiting = { id: 'job-w', organization_id: 'org-1', project_id: 'proj-1', status: 'implementation_pending', autopilot_state: 'blocked', autopilot_requested_by: 'user-1', autopilot_conversation_id: 'conv-1', title: 'Add Cancel control', task_description: 'brief', frontend_required: true, backend_required: false, code_review_mode: 'independent_ai', target_sha: 'c'.repeat(40), autopilot_report: { state: 'repairing', repair_job_id: 'job-repair' } };
  const manifest = JSON.stringify([{ path: 'apps/web/src/pages/FinanceBureauPage.guard.test.ts', before_sha256: 'a'.repeat(64), after_sha256: 'b'.repeat(64) }]);
  const repairSnapshot = {
    job: { id: 'job-repair', status: 'release_ready' },
    steps: [{ id: 's-fe', step_id: 'frontend_implementation', builder_mode: 'frontend_engineer', status: 'completed' }],
    artifacts: [{ id: 'art-manifest', artifact_type: 'changed_file_manifest', status: 'final', storage_location: 'supabase_storage://builder-artifacts/m.json' }, { id: 'art-patch', artifact_type: 'code_implementation', status: 'final', storage_location: 'supabase_storage://builder-artifacts/p.patch' }],
    workerRuns: [{ id: 'run-1', profile: 'frontend-verify', status: 'completed', step_id: 's-fe', output_artifact_ids: ['art-manifest', 'art-patch'], patch_artifact_id: 'art-author' }],
  };
  const supabase = fakeSupabase({ job: repairSnapshot.job, steps: repairSnapshot.steps, artifacts: repairSnapshot.artifacts, workerRuns: repairSnapshot.workerRuns, objects: { 'm.json': manifest } });

  // 1) Repair published but not yet on main: keep waiting.
  const pending = actionsRecorder();
  pending.loadJob = async () => ({ id: 'job-repair', status: 'release_ready', workspace_pull_request_url: 'https://git.example/pulls/12' });
  pending.changeLanded = async () => false;
  pending.createJob = async () => { throw new Error('too early'); };
  assert.deepEqual(await autopilotTick({ supabase, jobs: [waiting], actions: pending }), [{ job: 'job-w', outcome: 'waiting_for_repair', repair_job: 'job-repair' }]);
  assert.ok(!pending.calls.some(([name]) => name === 'record'));

  // 2) Landed: the original brief is opened again on current main and the old job is closed out.
  const landed = actionsRecorder();
  landed.loadJob = pending.loadJob;
  const landedRows = [];
  landed.changeLanded = async (rows) => { landedRows.push(rows); return true; };
  const created = [];
  landed.createJob = async (spec) => { created.push(spec); return { id: 'job-w2' }; };
  assert.deepEqual(await autopilotTick({ supabase, jobs: [waiting], actions: landed }), [{ job: 'job-w', outcome: 'resumed', resumed_as: 'job-w2' }]);
  assert.deepEqual(landedRows[0].map((r) => [r.path, r.after_sha256]), [['apps/web/src/pages/FinanceBureauPage.guard.test.ts', 'b'.repeat(64)]]);
  assert.equal(created[0].title, 'Add Cancel control');
  assert.equal(created[0].taskDescription, 'brief');
  assert.equal(created[0].requestedBy, 'user-1');
  const recorded = landed.calls.find(([name]) => name === 'record');
  assert.equal(recorded[2], 'done');
  assert.equal(recorded[3].resumed_as_job_id, 'job-w2');
  assert.equal(recorded[3].repair_outcome, 'landed');
  assert.match(recorded[3].text, /^Resumed: main is fixed, so Bob has started "Add Cancel control" again/);

  // 3) The repair itself failed: say so plainly, once.
  const failed = actionsRecorder();
  failed.loadJob = async () => ({ id: 'job-repair', status: 'implementation_pending', autopilot_state: 'blocked', last_error: 'frontend_implementation failed 3 times' });
  assert.deepEqual(await autopilotTick({ supabase, jobs: [waiting], actions: failed }), [{ job: 'job-w', outcome: 'repair_failed', repair_job: 'job-repair' }]);
  const failedRecord = failed.calls.find(([name]) => name === 'record');
  assert.equal(failedRecord[3].repair_outcome, 'failed');
  assert.match(failedRecord[3].text, /^Stopped: Bob could not fix the app's own failing checks/);
});

test('at the attempt ceiling a job pinned behind main is re-opened once on current main; a re-opened job is not re-opened again', async () => {
  const job = { id: 'job-c', organization_id: 'org-1', project_id: 'proj-1', status: 'implementation_pending', autopilot_state: 'driving', autopilot_requested_by: 'user-1', title: 'Add Cancel control', task_description: 'brief', frontend_required: true, backend_required: false, target_sha: 'c'.repeat(40) };
  const actions = actionsRecorder({ run: { paused: true, reason: 'attempt_ceiling', detail: 'frontend_implementation failed 7 times (ceiling 6); last failure: Frontend worker lease expired (runner lost); the same patch is verified again' } });
  actions.mainHead = async () => 'e'.repeat(40);
  const created = [];
  actions.createJob = async (spec) => { created.push(spec); return { id: 'job-c2' }; };
  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions }), [{ job: 'job-c', outcome: 'resumed', resumed_as: 'job-c2' }]);
  assert.equal(created[0].taskDescription, 'brief');
  const reopened = { ...job, id: 'job-c2', description: "Opened by Bob's autopilot from job job-c.", target_sha: 'e'.repeat(40) };
  const again = actionsRecorder({ run: { paused: true, reason: 'attempt_ceiling', detail: 'frontend_implementation failed 6 times (ceiling 6); last failure: Frontend worker verification failed' } });
  again.mainHead = async () => 'f'.repeat(40);
  again.createJob = async () => { throw new Error('one automatic re-open per brief'); };
  const outcome = await autopilotTick({ supabase: fakeSupabase({ job: reopened }), jobs: [reopened], actions: again });
  assert.equal(outcome[0].outcome, 'blocked');
  assert.match(again.calls.find(([name]) => name === 'record')[3].text, /What you can do: tell Bob "try again"/);
});

test('main-monitor jobs preserve their non-human provenance when reopened on a new main SHA', async () => {
  const job = {
    id: 'main-health-job',
    organization_id: 'org-1',
    project_id: 'proj-1',
    status: 'implementation_pending',
    autopilot_state: 'driving',
    autopilot_source: 'main_monitor',
    autopilot_requested_by: null,
    source_main_health_sha: 'a'.repeat(40),
    source_main_health_files: ['apps/web/src/lib/example.guard.test.ts'],
    title: 'Repair main guard test',
    task_description: 'Fix the stale assertion.',
    frontend_required: true,
    backend_required: false,
    target_sha: 'a'.repeat(40),
  };
  const actions = actionsRecorder({ run: { paused: true, reason: 'blocked', detail: 'repository red at the pinned commit: apps/web/src/lib/example.guard.test.ts' } });
  actions.mainHead = async () => 'b'.repeat(40);
  const opened = [];
  actions.createJob = async (spec) => { opened.push(spec); return { id: 'main-health-job-retry' }; };

  assert.deepEqual(await autopilotTick({ supabase: fakeSupabase({ job }), jobs: [job], actions }), [
    { job: 'main-health-job', outcome: 'resumed', resumed_as: 'main-health-job-retry' },
  ]);
  assert.equal(opened[0].requestedBy, null);
  assert.equal(opened[0].autopilotSource, 'main_monitor');
  assert.equal(opened[0].sourceMainHealthSha, 'a'.repeat(40));
  assert.deepEqual(opened[0].sourceMainHealthFiles, ['apps/web/src/lib/example.guard.test.ts']);
});
