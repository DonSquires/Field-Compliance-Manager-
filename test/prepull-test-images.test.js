'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testImages, pullWithRetry, dockerPull } = require('../scripts/prepull-test-images');

test('finds every container image the tests run, once each', () => {
  const sources = [
    "docker(['run', '--detach', '-e', 'X=1', 'postgis/postgis:17-3.5']);\nconst base = 'http://fixture-api:3000';",
    "docker(['run', 'public.ecr.aws/supabase/postgrest:v14.5']); docker(['run', 'postgis/postgis:17-3.5']);",
  ];
  assert.deepEqual(testImages(sources), ['postgis/postgis:17-3.5', 'public.ecr.aws/supabase/postgrest:v14.5']);
});

test('a registry rate limit is retried with backoff until the pull succeeds (PR #509)', async () => {
  const waits = [];
  let calls = 0;
  const run = () => {
    calls += 1;
    return calls < 3 ? { ok: false, output: 'docker: toomanyrequests: Rate exceeded' } : { ok: true, output: '' };
  };
  const result = await pullWithRetry('public.ecr.aws/supabase/postgrest:v14.5', { run, sleep: async ms => { waits.push(ms); } });
  assert.equal(result, 'pulled');
  assert.equal(calls, 3);
  assert.ok(waits.length === 2 && waits[1] > waits[0], 'waits grow between attempts');
});

test('an image no registry has (a local build tag) is skipped without retrying', async () => {
  let calls = 0;
  const run = () => { calls += 1; return { ok: false, output: 'pull access denied for fcm/bob-worker, repository does not exist' }; };
  assert.equal(await pullWithRetry('fcm/bob-worker:test', { run, sleep: async () => {} }), 'skipped');
  assert.equal(calls, 1);
});

test('a pull that keeps hitting the rate limit fails loudly after the last attempt', async () => {
  const run = () => ({ ok: false, output: 'toomanyrequests: Rate exceeded' });
  await assert.rejects(pullWithRetry('postgis/postgis:17-3.5', { run, sleep: async () => {}, attempts: 3 }), /postgis\/postgis:17-3\.5.*toomanyrequests/s);
});

test('a hard ECR quota pulls the identical pinned official artifact and tags the required image', () => {
  const image = 'public.ecr.aws/supabase/postgres:17.11.0.004';
  const mirror = 'docker.io/supabase/postgres@sha256:b15d862126dd2dac02da524696ccfde2dcce2ceaee0a58973b2727befe492706';
  const calls = [];
  const result = dockerPull(image, (command, args) => {
    calls.push([command, ...args]);
    return calls.length === 1
      ? { status: 1, stderr: 'toomanyrequests: Data limit exceeded' }
      : { status: 0 };
  });
  assert.equal(result.ok, true);
  assert.equal(result.mirror, mirror);
  assert.deepEqual(calls, [
    ['docker', 'pull', '--quiet', image],
    ['docker', 'pull', '--quiet', mirror],
    ['docker', 'tag', mirror, image],
  ]);
});

test('a throttled PostgREST pull uses the same upstream digest, not a similarly named repository', () => {
  const calls = [];
  const result = dockerPull('public.ecr.aws/supabase/postgrest:v14.5', (command, args) => {
    calls.push(args);
    return calls.length === 1 ? { status: 1, stderr: 'toomanyrequests: Rate exceeded' } : { status: 0 };
  });
  assert.equal(result.ok, true);
  assert.equal(calls[1][2], 'docker.io/postgrest/postgrest@sha256:b574528fe109c8343c1247155734d03df8c34b462f342dca0ccc20244fc36ef9');
});

test('a failed mirror pull or tag never becomes a successful or skipped required image', async () => {
  const image = 'public.ecr.aws/supabase/postgres:17.11.0.004';
  for (const failAt of [2, 3]) {
    const calls = [];
    const run = () => dockerPull(image, (command, args) => {
      calls.push(args);
      if (calls.length === 1) return { status: 1, stderr: 'toomanyrequests: Data limit exceeded' };
      return calls.length === failAt ? { status: 1, stderr: 'manifest unknown' } : { status: 0 };
    });
    await assert.rejects(pullWithRetry(image, { run, attempts: 1 }), /manifest unknown/);
    assert.equal(calls.length, failAt);
  }
});

test('successful pulls and non-quota failures do not switch registries', () => {
  for (const status of [0, 1]) {
    let calls = 0;
    const result = dockerPull('public.ecr.aws/supabase/postgres:17.11.0.004', () => {
      calls += 1;
      return { status, stderr: status === 0 ? '' : 'unauthorized: credentials rejected' };
    });
    assert.equal(result.ok, status === 0);
    assert.equal(calls, 1);
    assert.equal(result.mirror, undefined);
  }
});

test('a quota on an image without a verified mirror fails without substituting an artifact', () => {
  let calls = 0;
  const result = dockerPull('postgis/postgis:17-3.5', () => {
    calls += 1;
    return { status: 1, stderr: 'toomanyrequests: Data limit exceeded' };
  });
  assert.equal(result.ok, false);
  assert.equal(result.mirror, undefined);
  assert.equal(calls, 1);
});
