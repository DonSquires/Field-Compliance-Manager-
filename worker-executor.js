const { spawn } = require('node:child_process');

const WORKER_PROFILES = Object.freeze({
  assessment: Object.freeze(['node', '/opt/bob/assessment-manifest.js', '/workspace', '/artifacts/system-assessment.json']),
  test: Object.freeze(['npm', 'test']),
  build: Object.freeze(['npm', 'run', 'build']),
  lint: Object.freeze(['npm', 'run', 'lint']),
  'frontend-verify': Object.freeze(['node', '/opt/bob/frontend-worker.js', '/workspace', '/artifacts/input.patch', '/artifacts']),
  'backend-verify': Object.freeze(['node', '/opt/bob/backend-worker.js', '/workspace', '/artifacts/input.patch', '/artifacts']),
  'security-review': Object.freeze(['node', '/opt/bob/security-worker.js', '/artifacts/validated.patch', '/artifacts/changed-files.json', '/artifacts/security-review.json']),
  'playwright-visual-check': Object.freeze(['node', '/opt/bob/browser-verifier.js', '/workspace', '/artifacts'])
});

function workerCommand(profile) {
  const command = WORKER_PROFILES[profile];
  if (!command) throw new Error(`unsupported worker profile: ${profile}`);
  return [...command];
}

function dockerArguments({ image, sourceDir, artifactDir, profile, memory = '1g', cpus = '1', pidsLimit = 128, env = {} }) {
  if (!image) throw new Error('worker image is required');
  if (!sourceDir || !artifactDir) throw new Error('sourceDir and artifactDir are required');
  const command = workerCommand(profile);
  const args = [
    'run', '--rm', '--init',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--user=1000:1000',
    `--memory=${memory}`,
    `--cpus=${cpus}`,
    `--pids-limit=${pidsLimit}`,
    '--tmpfs=/tmp:rw,noexec,nosuid,size=64m',
  ];
  if (profile === 'frontend-verify' || profile === 'backend-verify') {
    args.push('--tmpfs=/work:rw,exec,nosuid,size=1024m');
  }
  if (profile === 'playwright-visual-check' && env.BOB_APP_URL) {
    args.push('-e', `BOB_APP_URL=${env.BOB_APP_URL}`);
  }
  args.push(
    '--mount', `type=bind,src=${sourceDir},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${artifactDir},dst=/artifacts`,
    image,
    ...command
  );
  return args;
}

function executeWorker(options, { spawnImpl = spawn } = {}) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const args = dockerArguments(options);
  return new Promise((resolve, reject) => {
    const child = spawnImpl('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-1024 * 1024); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? 'timeout' : code === 0 ? 'succeeded' : 'failed',
        exitCode: code,
        stdout: redact(stdout),
        stderr: redact(stderr),
        profile: options.profile
      });
    });
  });
}

function redact(value) {
  return value
    .replace(/authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, 'authorization=[REDACTED]')
    .replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]+)/g, '[REDACTED]');
}

module.exports = { WORKER_PROFILES, dockerArguments, executeWorker, redact, workerCommand };
