const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const scriptPath = path.resolve(__dirname, '../scripts/bob-vps-deploy.sh');
const source = fs.readFileSync(scriptPath, 'utf8');

test('deploy drain does not ignore older author sessions and fails closed on unavailable activity', () => {
  const drain = source.slice(source.indexOf('drain_control_plane()'), source.indexOf('for target in'));
  assert.doesNotMatch(drain, /created_at=gt|2 hours/);
  assert.match(drain, /cannot verify worker activity; treating as busy/);
  assert.match(drain, /cannot verify model activity; treating as busy/);
  assert.match(drain, /cannot verify runtime activity; treating as busy/);
  assert.match(drain, /runningBuilderJobs/);
  assert.match(drain, /Number\.isInteger\(n\)&&n===0/);
  assert.match(drain, /BOB_DEPLOY_FORCE/);
});

test('deploy builds before checking idle, immediately before replacing the control plane', () => {
  const action = source.slice(source.indexOf('    control-plane)'), source.indexOf('    fcm-api)'));
  assert.ok(action.indexOf('build -q bob-control-plane') < action.indexOf('drain_control_plane'));
  assert.ok(action.indexOf('drain_control_plane') < action.indexOf('rm -sf bob-control-plane'));
  execFileSync('bash', ['-n', scriptPath]);
});

test('the actual drain probe blocks on active work, lookup failures and malformed runtime health', () => {
  const start = source.indexOf('    busy() {');
  const end = source.indexOf('    deadline=', start);
  const probe = source.slice(start, end).replace(/\\(["$\\])/g, '$1');
  const mock = `
curl() {
  case "$*" in
    *builder_worker_runs*) [ "$FAIL" != worker ] || return 22; printf '%s' "$WORKERS";;
    *builder_model_runs*) [ "$FAIL" != model ] || return 22; printf '%s' "$MODELS";;
    */health*) [ "$FAIL" != health ] || return 22; printf '%s' "$HEALTH";;
    *) return 99;;
  esac
}
`;
  for (const [values, expected] of [
    [{}, 'idle'],
    [{ WORKERS: '[{"id":"active"}]' }, 'busy'],
    [{ MODELS: '[{"id":"four-hour-session"}]' }, 'busy'],
    [{ HEALTH: '{"runningBuilderJobs":1}' }, 'busy'],
    [{ HEALTH: '{}' }, 'busy'],
    [{ HEALTH: 'not json' }, 'busy'],
    [{ FAIL: 'worker' }, 'busy'],
    [{ FAIL: 'model' }, 'busy'],
    [{ FAIL: 'health' }, 'busy'],
  ]) {
    const output = execFileSync('bash', ['-c', `set -euo pipefail\n${mock}\n${probe}\nif busy; then echo busy; else echo idle; fi`], {
      env: {
        ...process.env, SUPABASE_URL: 'http://fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture',
        WORKERS: '[]', MODELS: '[]', HEALTH: '{"runningBuilderJobs":0}', FAIL: '', ...values,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    assert.equal(output.trim(), expected);
  }
});
