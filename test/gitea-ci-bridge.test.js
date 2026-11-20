'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'deploy', 'gitea-ci', 'fcm-gitea-ci-bridge.mjs')).href);

test('mirror only fast-forwards GitHub main and stops on divergence', async () => {
  const { mirrorAction } = await load();
  assert.deepEqual(mirrorAction({ giteaSha: 'a', githubSha: 'a', githubIsAncestor: true }), { action: 'none' });
  assert.deepEqual(mirrorAction({ giteaSha: 'b', githubSha: 'a', githubIsAncestor: true }), { action: 'fast-forward' });
  const stop = mirrorAction({ giteaSha: 'bbbbbbbbbb', githubSha: 'cccccccccc', githubIsAncestor: false });
  assert.equal(stop.action, 'stop');
  assert.match(stop.reason, /not an ancestor/);
  assert.equal(mirrorAction({ giteaSha: null, githubSha: 'a', githubIsAncestor: true }).action, 'skip');
});

test('main counts as passed only when every verification job last reported success', async () => {
  const { jobStates, mainPassed } = await load();
  const s = (job, status, at, event = 'push') => ({ context: `PR verification / ${job} (${event})`, status, updated_at: at });
  const statuses = [
    s('Runtime and migration inventory', 'pending', '2026-11-21T01:00:00Z'),
    s('Runtime and migration inventory', 'success', '2026-11-21T01:30:00Z'),
    s('Web types, build and unit tests', 'success', '2026-11-21T01:10:00Z'),
    { context: 'Publish workload containers / publish (push)', status: 'failure', updated_at: '2026-11-21T01:10:00Z' },
  ];
  assert.equal(mainPassed(jobStates(statuses)), false, 'browser job has not reported');
  statuses.push(s('Offline browser workflows', 'success', '2026-11-21T01:40:00Z'));
  assert.equal(mainPassed(jobStates(statuses)), true);
  statuses.push(s('Offline browser workflows', 'failure', '2026-11-21T02:00:00Z'));
  assert.equal(mainPassed(jobStates(statuses)), false, 'latest rerun failed');
});

test('bridge reads tokens from systemd credentials and never hands them to child processes', async (t) => {
  const { readSecret, childEnv } = await load();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-cred-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'github-token'), 'from-file\n');
  assert.equal(readSecret('github-token', 'GITHUB_TOKEN', { CREDENTIALS_DIRECTORY: dir, GITHUB_TOKEN: 'from-env' }), 'from-file');
  assert.equal(readSecret('gitea-token', 'GITEA_TOKEN', { CREDENTIALS_DIRECTORY: dir, GITEA_TOKEN: 'env-only' }), 'env-only');
  assert.throws(() => readSecret('gitea-token', 'GITEA_TOKEN', { CREDENTIALS_DIRECTORY: dir }), /required/);
  assert.deepEqual(childEnv({ PATH: '/bin', GITHUB_TOKEN: 'a', GITEA_TOKEN: 'b', CREDENTIALS_DIRECTORY: dir }), { PATH: '/bin' });
});

test('bridge scrubs tokens from log output', async () => {
  const { scrub } = await load();
  assert.equal(scrub('fatal: auth ghp_SECRET for tokenX', ['ghp_SECRET', 'tokenX', '']), 'fatal: auth <token> for <token>');
});
