'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crossLaneNoChange, skipLaneWithNothingToDo } = require('../builder-generation-failure');

test('explicit sibling routing and the observed protected-lane response reach the sibling, never the same lane', async () => {
  const calls = [];
  const input = { job: { id: 'job' }, step: { id: 'step', builder_mode: 'frontend_engineer' },
    supabase: { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; } } };
  for (const generation of [
    { no_change: true, no_change_lane: 'backend', no_change_file: 'builder-chat-session.js', error: 'The fix belongs in builder-chat-session.js' },
    { no_change: true, error: 'Two author attempts produced no patch; second attempt: Protected lane boundary: the required fix lives in `builder-chat-session.js` (backend lane), while this turn is restricted to `apps/web/` frontend files only.' },
  ]) {
    assert.equal(await skipLaneWithNothingToDo(input, generation), true);
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.name === 'builder_skip_implementation_step'));
  assert.match(calls[1].args._reason, /belongs to the backend lane/);
  for (const generation of [
    { no_change: true, no_change_lane: 'frontend', error: 'No changes' },
    { no_change: true, no_change_lane: 'other', error: 'No changes' },
    { no_change: true, no_change_lane: 'backend', no_change_file: 'Dockerfile', error: 'Protected deployment change' },
    { no_change: true, no_change_lane: 'backend', no_change_file: 'apps/web/src/example.tsx', error: 'Still frontend' },
    { no_change: false, no_change_lane: 'backend', error: 'budget exhausted' },
    { no_change: true, error: 'Turn budget exhausted without source evidence' },
    { no_change: true, error: 'Protected lane boundary: file is protected; no authorized lane' },
    { no_change: true, error: 'builder-chat-session.js is outside the backend lane' },
    { no_change: true, error: 'Dockerfile is outside the frontend lane' },
    { no_change: true, error: 'node_modules/@supabase/supabase-js/dist/main/index.js is outside the frontend lane' },
    { no_change: true, error: '`/tmp/private.js` is outside the frontend lane' },
    { no_change: true, error: '`../outside.js` is outside the frontend lane' },
  ]) assert.equal(await skipLaneWithNothingToDo(input, generation), false);
  assert.equal(calls.length, 2);
  assert.equal(crossLaneNoChange({ no_change_lane: 'frontend', no_change_file: 'apps/web/src/example.tsx' }, 'backend_engineer'), true);
});

test('retained recovery seed is freshly verified before frontend completion; verification failure cannot skip', async () => {
  const { runFrontendImplementation } = require('../builder-frontend-orchestrator');
  for (const success of [true, false]) {
    const calls = [];
    const result = await runFrontendImplementation({
      supabase: { rpc: () => assert.fail('seeded no-change must not skip or count generation failure') },
      job: { id: 'job' }, step: { id: 'front', builder_mode: 'frontend_engineer' },
      generate: async () => ({ ok: true, patch_artifact: { id: 'fresh-retained-proposal' },
        proposal: { retained_seed_artifact_id: 'reviewed-seed', acceptance_evidence: [] } }),
      handoff: async input => { calls.push(input.patchArtifact.id); return { success, artifacts: [{ id: 'fresh-verification' }] }; },
      reloadStep: async () => ({ retryable: false }),
    });
    assert.deepEqual(calls, ['fresh-retained-proposal']);
    assert.equal(result.success, success);
    if (success) assert.deepEqual(result.verification_artifacts, [{ id: 'fresh-verification' }]);
    else assert.equal(result.phase, 'verification');
  }
});
