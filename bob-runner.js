const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { executeWorker } = require('./worker-executor');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function controlPlaneRequest(baseUrl, token, route, payload, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`control plane request failed (${response.status}): ${body.error || 'unknown error'}`);
  return body;
}

async function runJob({
  controlPlaneUrl,
  runnerToken,
  runnerId,
  jobId,
  profile,
  workerImage,
  sourceDir,
  artifactDir,
  execute = executeWorker,
  fetchImpl = fetch
}) {
  const run = await controlPlaneRequest(controlPlaneUrl, runnerToken, `/jobs/${jobId}/pickup`, { runnerId }, fetchImpl);
  const result = await execute({
    image: workerImage,
    sourceDir,
    artifactDir,
    profile,
    timeoutMs: Number(process.env.BOB_WORKER_TIMEOUT_MS || 10 * 60 * 1000),
    memory: process.env.BOB_WORKER_MEMORY || '1g',
    cpus: process.env.BOB_WORKER_CPUS || '1',
    pidsLimit: Number(process.env.BOB_WORKER_PIDS_LIMIT || 128)
  });
  await fs.mkdir(artifactDir, { recursive: true });
  const artifactName = `${jobId}-${run.id || 'run'}-result.json`;
  const artifactPath = path.join(artifactDir, artifactName);
  const contents = JSON.stringify({ jobId, runId: run.id, result }, null, 2);
  await fs.writeFile(artifactPath, contents, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(contents).digest('hex');
  return controlPlaneRequest(controlPlaneUrl, runnerToken, `/jobs/${jobId}/artifacts`, {
    runId: run.id,
    leaseToken: run.leaseToken,
    runnerId,
    kind: 'report',
    objectPath: artifactName,
    sha256,
    sizeBytes: Buffer.byteLength(contents)
  }, fetchImpl);
}

async function main() {
  const jobId = required('BOB_JOB_ID');
  const result = await runJob({
    controlPlaneUrl: process.env.BOB_CONTROL_PLANE_URL || 'http://127.0.0.1:8090',
    runnerToken: required('BOB_RUNNER_TOKEN'),
    runnerId: process.env.BOB_RUNNER_ID || 'vps-runner',
    jobId,
    profile: process.env.BOB_WORKER_PROFILE || 'test',
    workerImage: required('BOB_WORKER_IMAGE'),
    sourceDir: required('BOB_SOURCE_DIR'),
    artifactDir: process.env.BOB_ARTIFACT_DIR || path.resolve('./bob-artifacts')
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { controlPlaneRequest, runJob };
