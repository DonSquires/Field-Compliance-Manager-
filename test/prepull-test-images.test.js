'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testImages, pullWithRetry } = require('../scripts/prepull-test-images');

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
