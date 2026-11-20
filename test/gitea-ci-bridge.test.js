'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'deploy', 'gitea-ci', 'fcm-gitea-ci-bridge.mjs')).href);
const repo = 'DonSquires/Field-Compliance-Manager-';
const pr = (number, ref, sha, full = repo) => ({ number, head: { ref, sha, repo: full ? { full_name: full } : null } });

test('bridge mirrors main and same-repository PR heads, never forks or unsafe names', async () => {
  const { desiredBranches } = await load();
  const branches = desiredBranches([
    pr(554, 'feat/rate-cards-20261117', 'aaa'),
    pr(600, 'patch-1', 'bbb', 'someone/fork'),
    pr(601, 'deleted-fork', 'ccc', null),
    pr(602, 'bad..ref', 'ddd'),
    pr(603, 'main', 'eee'),
    pr(604, 'x;rm -rf', 'fff'),
  ], repo, 'm1');
  assert.deepEqual([...branches.entries()], [
    ['main', { sha: 'm1', pr: null }],
    ['feat/rate-cards-20261117', { sha: 'aaa', pr: 554 }],
  ]);
});

test('bridge maps the latest Gitea Actions job statuses to gitea-ci contexts', async () => {
  const { jobStatuses } = await load();
  const jobs = jobStatuses([
    { context: 'PR verification / Runtime and migration inventory (push)', status: 'pending', updated_at: '2026-11-21T01:00:00Z', target_url: 'https://git/x/1' },
    { context: 'PR verification / Runtime and migration inventory (push)', status: 'success', updated_at: '2026-11-21T01:30:00Z', description: 'Successful in 20m', target_url: 'https://git/x/1' },
    { context: 'PR verification / Web types, build and unit tests (push)', status: 'failure', updated_at: '2026-11-21T01:10:00Z' },
    { context: 'Publish workload containers / publish (push)', status: 'success', updated_at: '2026-11-21T01:10:00Z' },
    { context: 'PR verification / Offline browser workflows (push)', status: 'warning', updated_at: '2026-11-21T01:10:00Z' },
  ]);
  assert.deepEqual(jobs.map((j) => [j.context, j.state]), [
    ['gitea-ci / Runtime and migration inventory', 'success'],
    ['gitea-ci / Web types, build and unit tests', 'failure'],
    ['gitea-ci / Offline browser workflows', 'error'],
  ]);
  assert.equal(jobs[0].description, 'Successful in 20m');
});

test('bridge aggregate is queued until all jobs report, and failure wins', async () => {
  const { aggregateStatus } = await load();
  const ok = (name) => ({ context: `gitea-ci / ${name}`, state: 'success' });
  assert.equal(aggregateStatus([], 3).state, 'pending');
  assert.equal(aggregateStatus([ok('a'), ok('b')], 3).state, 'pending');
  assert.equal(aggregateStatus([ok('a'), ok('b'), ok('c')], 3).state, 'success');
  const failed = aggregateStatus([ok('a'), { context: 'gitea-ci / b', state: 'failure' }], 3);
  assert.equal(failed.state, 'failure');
  assert.equal(failed.description, 'Failed: b');
});

test('bridge scrubs tokens from log output', async () => {
  const { scrub } = await load();
  assert.equal(scrub('fatal: auth ghp_SECRET for tokenX', ['ghp_SECRET', 'tokenX', '']), 'fatal: auth <token> for <token>');
});
