const assert = require('node:assert/strict');
const test = require('node:test');

const { ORPHAN_RETENTION_MS, jobHygieneDecision, historicalHealthResolution } = require('../builder-job-hygiene');

const mainSha = 'a'.repeat(40);
const oldSha = 'b'.repeat(40);
const base = {
  id: 'job-1',
  status: 'analysis_pending',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
};

test('Builder hygiene retires a nonterminal job Bob already recorded done', () => {
  assert.deepEqual(jobHygieneDecision({ ...base, autopilot_state: 'done' }, {}), {
    outcome: 'completed_autopilot',
    reason: 'Bob had already recorded this job as done; its nonterminal queue status was stale.',
  });
});

test('Builder hygiene retires an old workspace-free health repair only after current main passes', () => {
  const job = { ...base, autopilot_source: 'main_monitor', source_main_health_sha: oldSha, autopilot_state: 'awaiting_human' };
  assert.equal(jobHygieneDecision(job, { currentMainSha: mainSha, currentMainHealthPassed: false }), null);
  assert.equal(jobHygieneDecision(job, { currentMainSha: oldSha, currentMainHealthPassed: true }), null);
  assert.equal(jobHygieneDecision(job, { currentMainSha: mainSha, currentMainHealthPassed: true }).outcome, 'superseded_main_health');
});

test('Builder hygiene never retires active execution, workspaces, pull requests, or live human gates', () => {
  assert.equal(jobHygieneDecision({ ...base, autopilot_state: 'done' }, { activeExecution: true }), null);
  assert.equal(jobHygieneDecision({ ...base, autopilot_state: 'done', workspace_branch: 'bob/job-safe' }), null);
  assert.equal(jobHygieneDecision({ ...base, autopilot_state: 'done', workspace_pull_request_url: 'https://example.test/pull/1' }), null);
  assert.equal(jobHygieneDecision({ ...base, autopilot_state: 'awaiting_human' }, { pendingApproval: true }), null);
});

test('Builder hygiene gives an unowned manual job a seven-day quiet period', () => {
  const now = Date.parse('2026-10-15T00:00:00.000Z');
  assert.equal(jobHygieneDecision(base, { now: Date.parse(base.updated_at) + ORPHAN_RETENTION_MS - 1 }), null);
  assert.equal(jobHygieneDecision(base, { now, pendingApproval: true }), null);
  assert.equal(jobHygieneDecision(base, { now }).outcome, 'inactive_orphan');
});

test('historical health resolution needs a newer green main and the original tests, without reopening status', () => {
  const job = { ...base, status: 'failed', autopilot_source: 'main_monitor', autopilot_state: 'blocked',
    source_main_health_sha: oldSha, source_main_health_files: ['test/repair.test.js'] };
  const context = { currentMainSha: mainSha, currentMainHealthPassed: true, verifiedFiles: ['test/repair.test.js'] };
  assert.equal(historicalHealthResolution(job, context).outcome, 'resolved_historical_main_health');
  assert.equal(job.status, 'failed');
  assert.equal(historicalHealthResolution({ ...job, status: 'cancelled' }, context).outcome, 'resolved_historical_main_health');
  for (const change of [
    { status: 'deployed' }, { status: 'building' }, { autopilot_source: 'routine_monitor' },
    { autopilot_state: 'done' }, { workspace_branch: 'bob/job-live' }, { workspace_pull_request_url: 'https://example.test/pr/1' },
    { source_main_health_sha: mainSha }, { source_main_health_files: ['../test/repair.test.js'] },
    { source_main_health_files: [] }, { source_main_health_files: ['test/missing.test.js'] },
  ]) assert.equal(historicalHealthResolution({ ...job, ...change }, context), null);
  assert.equal(historicalHealthResolution(job, { ...context, currentMainHealthPassed: false }), null);
  assert.equal(historicalHealthResolution(job, { ...context, activeExecution: true }), null);
});
