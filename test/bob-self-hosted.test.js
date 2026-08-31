const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildSelfHostedPlan, runSelfHostedBuildLoop } = require('../bob-self-hosted');

test('self-hosted Bob builds an assessment-first plan from the repo state', () => {
  const assessment = {
    fileCount: 12,
    packages: [
      { file: 'package.json', scripts: ['test', 'build'], dependencies: ['react'] },
      { file: 'apps/web/package.json', scripts: ['lint'], dependencies: [] }
    ],
    compose: [{ file: 'docker-compose.yml', services: ['api', 'web'] }],
    supabaseEdgeFunctions: ['bob-test']
  };

  const plan = buildSelfHostedPlan(assessment);
  assert.equal(plan.mode, 'self_hosted_bob');
  assert.equal(plan.readOnly, true);
  assert.deepEqual(plan.profiles, ['assessment', 'test', 'build', 'lint', 'security-review', 'playwright-visual-check']);
  assert.ok(plan.steps.every(step => step.type === 'verification'));
  assert.equal(plan.steps[0].profile, 'assessment');
  assert.equal(plan.steps.at(-1).profile, 'playwright-visual-check');
});

test('self-hosted Bob runs the planned verification loop with injected worker results', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-self-hosted-'));
  const calls = [];
  const result = await runSelfHostedBuildLoop({
    rootDir: '/workspace',
    artifactDir,
    profiles: ['assessment', 'test'],
    workerImage: 'fcm/bob-worker:test',
    execute: async options => {
      calls.push(options.profile);
      return { status: 'succeeded', exitCode: 0, profile: options.profile, stdout: 'ok', stderr: '' };
    },
    assessmentFactory: () => ({
      fileCount: 2,
      packages: [{ file: 'package.json', scripts: ['test'], dependencies: [] }],
      compose: [],
      supabaseEdgeFunctions: []
    })
  });

  assert.equal(result.mode, 'self_hosted_bob');
  assert.equal(result.steps.length, 2);
  assert.deepEqual(calls, ['assessment', 'test']);
  assert.equal(result.steps[0].status, 'succeeded');
  await fs.rm(artifactDir, { recursive: true, force: true });
});

test('self-hosted browser checks receive the live app URL in the worker environment', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-self-hosted-browser-'));
  const seen = [];
  const result = await runSelfHostedBuildLoop({
    rootDir: '/workspace',
    artifactDir,
    profiles: ['playwright-visual-check'],
    workerImage: 'fcm/bob-worker:test',
    appUrl: 'https://app.example.com',
    execute: async options => {
      seen.push(options.env?.BOB_APP_URL || options.appUrl || null);
      return { status: 'succeeded', exitCode: 0, profile: options.profile, stdout: 'ok', stderr: '' };
    },
    assessmentFactory: () => ({
      fileCount: 1,
      packages: [],
      compose: [],
      supabaseEdgeFunctions: []
    })
  });

  assert.equal(result.steps[0].status, 'succeeded');
  assert.deepEqual(seen, ['https://app.example.com']);
  await fs.rm(artifactDir, { recursive: true, force: true });
});

test('multi-target browser matrix validates multiple URLs in one assessment', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-self-hosted-matrix-'));
  const seen = [];
  const result = await runSelfHostedBuildLoop({
    rootDir: '/workspace',
    artifactDir,
    profiles: ['playwright-visual-check'],
    workerImage: 'fcm/bob-worker:test',
    appUrls: ['https://app.example.com', 'https://app.example.com/health'],
    execute: async options => {
      seen.push(options.env?.BOB_APP_URL || null);
      return { status: 'succeeded', exitCode: 0, profile: options.profile, stdout: 'ok', stderr: '' };
    },
    assessmentFactory: () => ({
      fileCount: 1,
      packages: [],
      compose: [],
      supabaseEdgeFunctions: []
    })
  });

  assert.equal(result.steps.length, 2);
  assert.ok(result.steps.some(s => s.profile === 'playwright-visual-check:https://app.example.com'));
  assert.ok(result.steps.some(s => s.profile === 'playwright-visual-check:https://app.example.com/health'));
  assert.deepEqual(seen, ['https://app.example.com', 'https://app.example.com/health']);
  await fs.rm(artifactDir, { recursive: true, force: true });
});
