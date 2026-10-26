'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadCodeReviewSeed, downloadVerifiedArtifact } = require('../builder-artifact-read');
const { implementationRuns, implementationArtifacts, agenticGenerator, planBuilderAction } = require('../builder-runtime-coordinator');
const { taskPacket } = require('../builder-agentic-engineer');
const { buildFrontendEngineerPrompt } = require('../supabase/functions/_shared/builder-frontend-engineer');
const { buildBackendEngineerPrompt } = require('../supabase/functions/_shared/builder-backend-engineer');
const { buildRepairPrompt } = require('../supabase/functions/_shared/builder-frontend-repair');

const patch = 'diff --git a/lib/x.js b/lib/x.js\n--- a/lib/x.js\n+++ b/lib/x.js\n@@ -1 +1 @@\n-old\n+new\n';
const revision = { approval_id: 'old-approval', feedback: 'Inspect real reader integration; mocks hid the defect.', seed_patch_ids: { backend_implementation: 'old-patch' } };
const job = { id: 'job', code_review_revision: revision };
const step = { id: 'backend-step', step_id: 'backend_implementation', builder_mode: 'backend_engineer' };
function db({ status = 'superseded', stepId = step.id, checksum = crypto.createHash('sha256').update(patch).digest('hex') } = {}) {
  const query = { select: () => query, eq: () => query, single: async () => ({ data: {
    id: 'old-patch', job_id: job.id, step_id: stepId, artifact_type: 'code_implementation', status,
    checksum, storage_location: 'supabase_storage://builder-artifacts/org/job/patch',
  } }) };
  return { from: () => query, storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => Buffer.from(patch) } }) }) } };
}

test('only the confirmed same-lane correction seed may load superseded evidence; checksums still apply', async () => {
  const seed = await loadCodeReviewSeed(db(), job, step);
  assert.equal(seed.text, patch);
  assert.equal(seed.artifact_id, 'old-patch');
  assert.equal(await loadCodeReviewSeed(null, {}, step), null);
  await assert.rejects(downloadVerifiedArtifact(db(), 'old-patch', job.id, 'code_implementation'), /unavailable/);
  await assert.rejects(loadCodeReviewSeed(db({ stepId: 'other-step' }), job, step), /different implementation step/);
  await assert.rejects(loadCodeReviewSeed(db({ checksum: '0'.repeat(64) }), job, step), /integrity/);
  await assert.rejects(loadCodeReviewSeed(db(), job, { ...step, step_id: 'frontend_implementation' }), /no seed/);
});

test('agentic and one-shot implementation/repair packets retain the complete confirmed correction', () => {
  assert.deepEqual(JSON.parse(taskPacket({ job, lane: 'backend' })).confirmed_code_review_corrections, revision);
  for (const build of [buildFrontendEngineerPrompt, buildBackendEngineerPrompt, buildRepairPrompt]) {
    const packet = JSON.parse(build({ sourceContext: {}, codeReviewRevision: revision, previousImplementation: patch }).userPrompt);
    assert.deepEqual(packet.confirmed_code_review_corrections, revision);
  }
});

test('agentic correction receives the verified retained patch, not the completed previous checkpoint as fresh output', async () => {
  let input;
  const generate = agenticGenerator('backend', { workspaceRoot: '/ws' }, {
    runEngineer: async value => { input = value; return { ok: true, patch_artifact: { id: 'corrected' } }; },
  });
  const result = await generate({ supabase: db(), job, step });
  assert.equal(input.seedPatch.text, patch);
  assert.equal(input.job.code_review_revision.approval_id, 'old-approval');
  assert.equal(result.patch_artifact.id, 'corrected');
});

test('a lane reopened by the correction authors from the pinned target; other missing or bad seeds still fail', async () => {
  const frontend = { id: 'frontend-step', step_id: 'frontend_implementation', builder_mode: 'frontend_engineer' };
  const reopened = { ...job, code_review_revision: { ...revision, reopened_required_lanes: ['frontend_implementation'] } };
  assert.equal(await loadCodeReviewSeed(db(), reopened, frontend), null);
  assert.equal(await loadCodeReviewSeed(db(), reopened, { ...frontend, step_id: undefined }), null);
  await assert.rejects(loadCodeReviewSeed(db(), job, frontend), /no seed/);
  await assert.rejects(loadCodeReviewSeed(db({ checksum: '0'.repeat(64) }), reopened, step), /integrity/);
  assert.equal((await loadCodeReviewSeed(db(), reopened, step)).artifact_id, 'old-patch');

  let input;
  const generate = agenticGenerator('frontend', { workspaceRoot: '/ws' }, {
    runEngineer: async value => { input = value; return { ok: true, patch_artifact: { id: 'fresh-frontend' } }; },
  });
  const result = await generate({ supabase: db(), job: reopened, step: frontend });
  assert.equal(input.seedPatch, null);
  assert.deepEqual(input.job.code_review_revision.reopened_required_lanes, ['frontend_implementation']);
  assert.equal(result.patch_artifact.id, 'fresh-frontend');
  await assert.rejects(agenticGenerator('frontend', { workspaceRoot: '/ws' }, {
    runEngineer: async () => ({ ok: true }),
  })({ supabase: db(), job, step: frontend }), /no seed/);
});

test('superseded implementation runs cannot enter fresh security, review or release evidence', () => {
  const state = {
    job: { id: 'job', status: 'implementation_pending' },
    steps: [{ ...step, status: 'pending' }],
    artifacts: [{ id: 'old-patch', step_id: step.id, artifact_type: 'code_implementation', status: 'superseded' }],
    workerRuns: [{ id: 'old-run', step_id: step.id, profile: 'backend-verify', patch_artifact_id: 'old-patch', status: 'completed' }],
  };
  assert.equal(planBuilderAction(state).type, 'run_backend');
  state.steps[0].status = 'completed';
  state.artifacts.push({ id: 'new-patch', step_id: step.id, artifact_type: 'code_implementation', status: 'final' });
  state.workerRuns.push({ id: 'new-run', step_id: step.id, profile: 'backend-verify', patch_artifact_id: 'new-patch', status: 'completed' });
  assert.deepEqual(implementationRuns(state).map(run => run.id), ['new-run']);
  assert.deepEqual(implementationArtifacts(state).patch.map(item => item.id), ['new-patch']);
});
