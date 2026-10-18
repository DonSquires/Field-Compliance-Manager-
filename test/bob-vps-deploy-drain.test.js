const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { checkRuntimeIdle } = require('../scripts/bob-runtime-idle');

const scriptPath = path.resolve(__dirname, '../scripts/bob-vps-deploy.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

test('manual deployment uses the shared fail-closed probe while keeping explicit emergency authority', () => {
  const drain = source.slice(source.indexOf('drain_control_plane()'), source.indexOf('for target in'));
  assert.match(drain, /! node \/srv\/fcm\/releases\/\$SHA\/scripts\/bob-runtime-idle\.js/);
  assert.match(drain, /BOB_DEPLOY_FORCE/);
});

test('deploy builds before checking idle, immediately before replacing the control plane', () => {
  const action = source.slice(source.indexOf('    control-plane)'), source.indexOf('    fcm-api)'));
  assert.ok(action.indexOf('build -q bob-control-plane') < action.indexOf('drain_control_plane'));
  assert.ok(action.indexOf('drain_control_plane') < action.indexOf('rm -sf bob-control-plane'));
  execFileSync('bash', ['-n', scriptPath]);
});

test('shared probe checks workers, models and runtime and never applies an age cutoff', async () => {
  const urls = [];
  const result = await checkRuntimeIdle({
    url: 'https://fixture.invalid', key: 'fixture',
    fetchImpl: async (url, options) => {
      urls.push(url);
      if (url.includes('/rest/v1/')) assert.equal(options.headers.apikey, 'fixture');
      else assert.equal(options.headers, undefined);
      return { ok: true, json: async () => url.endsWith('/health') ? { runningBuilderJobs: 0 } : [] };
    },
  });
  assert.equal(result.idle, true);
  assert.ok(urls.some(url => url.includes('builder_worker_runs')));
  assert.ok(urls.some(url => url.includes('builder_model_runs')));
  assert.ok(urls.every(url => !url.includes('created_at')));
});

test('shared probe defers for live work, absent credentials, network and response failures', async () => {
  const cases = [
    { workers: [{ id: 'verifier' }] },
    { models: [{ id: 'four-hour-author' }] },
    { runtime: { runningBuilderJobs: 1 } },
    { runtime: {} },
    { runtime: null },
    { runtime: { runningBuilderJobs: -1 } },
    { workers: {} },
    { models: {} },
    { fail: 'http' },
    { fail: 'json' },
    { fail: 'network' },
  ];
  for (const fixture of cases) {
    const result = await checkRuntimeIdle({
      url: 'https://fixture.invalid', key: 'fixture',
      fetchImpl: async url => {
        if (fixture.fail === 'network') throw new Error('private error must not leak');
        return {
          ok: fixture.fail !== 'http',
          json: async () => {
            if (fixture.fail === 'json') throw new Error('bad JSON');
            return url.includes('builder_worker_runs') ? fixture.workers ?? []
              : url.includes('builder_model_runs') ? fixture.models ?? []
                : fixture.runtime === undefined ? { runningBuilderJobs: 0 } : fixture.runtime;
          },
        };
      },
    });
    assert.equal(result.idle, false, JSON.stringify(fixture));
    assert.doesNotMatch(result.reason, /private error/);
  }
  assert.equal((await checkRuntimeIdle({})).idle, false);
});
