const assert = require('node:assert/strict');
const test = require('node:test');
const { dockerArguments, redact, workerCommand } = require('../worker-executor');

test('worker profiles use fixed commands', () => {
  assert.deepEqual(workerCommand('assessment'), ['node', '/opt/bob/assessment-manifest.js', '/workspace', '/artifacts/system-assessment.json']);
  assert.deepEqual(workerCommand('test'), ['npm', 'test']);
  assert.deepEqual(workerCommand('build'), ['npm', 'run', 'build']);
  assert.throws(() => workerCommand('shell'), /unsupported worker profile/);
});

test('docker arguments enforce worker isolation', () => {
  const args = dockerArguments({
    image: 'fcm/bob-worker:test',
    sourceDir: '/tmp/source',
    artifactDir: '/tmp/artifacts',
    profile: 'test'
  });
  assert.equal(args.includes('--network=none'), true);
  assert.equal(args.includes('--read-only'), true);
  assert.equal(args.includes('--cap-drop=ALL'), true);
  assert.equal(args.includes('--security-opt=no-new-privileges:true'), true);
  assert.equal(args.includes('--user=1000:1000'), true);
  assert.equal(args.includes('npm'), true);
  assert.equal(args.includes('shell'), false);
  assert.equal(args.includes('/var/run/docker.sock'), false);
});

test('worker output redacts common secret formats', () => {
  const output = 'token=abc123 authorization: Bearerxyz sk-test_123';
  assert.equal(redact(output), 'token=[REDACTED] authorization=[REDACTED] [REDACTED]');
});
