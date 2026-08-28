const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runJob } = require('../bob-runner');

test('runner picks up a job, executes a fixed profile, and reports an artifact', async () => {
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bob-artifacts-'));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async json() { return calls.length === 1 ? { id: 'run-1', status: 'picked_up' } : { id: 'artifact-1' }; }
    };
  };
  const execute = async options => {
    assert.equal(options.profile, 'test');
    assert.equal(options.image, 'fcm/bob-worker:test');
    return { status: 'succeeded', exitCode: 0, stdout: 'ok', stderr: '', profile: options.profile };
  };

  const artifact = await runJob({
    controlPlaneUrl: 'http://control-plane:8090',
    runnerToken: 'runner-token',
    runnerId: 'runner-1',
    jobId: 'job-1',
    profile: 'test',
    workerImage: 'fcm/bob-worker:test',
    sourceDir: '/source',
    artifactDir,
    execute,
    fetchImpl
  });

  assert.equal(artifact.id, 'artifact-1');
  assert.equal(calls[0].url, 'http://control-plane:8090/jobs/job-1/pickup');
  assert.deepEqual(calls[0].body, { runnerId: 'runner-1' });
  assert.equal(calls[1].url, 'http://control-plane:8090/jobs/job-1/artifacts');
  assert.equal(calls[1].body.runnerId, 'runner-1');
  const files = await fs.readdir(artifactDir);
  assert.equal(files.length, 1);
  await fs.rm(artifactDir, { recursive: true, force: true });
});

test('runner rejects control-plane errors', async () => {
  await assert.rejects(() => runJob({
    controlPlaneUrl: 'http://control-plane:8090',
    runnerToken: 'runner-token',
    runnerId: 'runner-1',
    jobId: 'job-1',
    profile: 'test',
    workerImage: 'fcm/bob-worker:test',
    sourceDir: '/source',
    artifactDir: '/tmp/artifacts',
    fetchImpl: async () => ({ ok: false, status: 401, async json() { return { error: 'runner unauthorized' }; } })
  }), /control plane request failed \(401\)/);
});
