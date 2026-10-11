const { spawn } = require('node:child_process');

const WORKER_PROFILES = Object.freeze({
  assessment: Object.freeze(['node', '/opt/bob/assessment-manifest.js', '/workspace', '/artifacts/system-assessment.json']),
  test: Object.freeze(['npm', 'test']),
  build: Object.freeze(['npm', 'run', 'build']),
  lint: Object.freeze(['npm', 'run', 'lint']),
  'human-qa': Object.freeze(['sh', '-lc', 'cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/ && cd /workspace/apps/web && PATH=/workspace/apps/web/node_modules/.bin:$PATH PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report playwright test e2e/dr-bob-human-test.spec.ts --workers=4']),
  'human-qa-live': Object.freeze(['sh', '-lc', 'cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/ && cd /workspace/apps/web && PATH=/workspace/apps/web/node_modules/.bin:$PATH PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report playwright test e2e/dr-bob-human-test.spec.ts --workers=1']),
  'full-page-audit': Object.freeze(['sh', '-lc', 'set -eu; npm test; npm run check:css; cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/; cd /workspace/apps/web; PATH=/workspace/apps/web/node_modules/.bin:$PATH npm run lint; PATH=/workspace/apps/web/node_modules/.bin:$PATH npm test -- --reporter=dot; PATH=/workspace/apps/web/node_modules/.bin:$PATH npm run build; PATH=/workspace/apps/web/node_modules/.bin:$PATH PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report playwright test e2e/dr-bob-human-test.spec.ts --workers=1']),
  'frontend-verify': Object.freeze(['node', '/opt/bob/frontend-worker.js', '/workspace', '/artifacts/input.patch', '/artifacts']),
  'backend-verify': Object.freeze(['node', '/opt/bob/backend-worker.js', '/workspace', '/artifacts/input.patch', '/artifacts']),
  'security-review': Object.freeze(['node', '/opt/bob/security-worker.js', '/artifacts/validated.patch', '/artifacts/changed-files.json', '/artifacts/security-review.json'])
});

function workerCommand(profile) {
  const command = WORKER_PROFILES[profile];
  if (!command) throw new Error(`unsupported worker profile: ${profile}`);
  return [...command];
}

// The control plane runs in a container but talks to the HOST docker daemon, so
// bind-mount sources must be host paths: /data/... -> /var/lib/bob/... when
// BOB_HOST_DATA_DIR is set. Anything outside the data volume cannot be mounted.
function hostPath(containerPath, env = process.env) {
  const from = (env.BOB_CONTAINER_DATA_DIR || env.BOB_STATE_DIR || '').replace(/\/+$/, '');
  const to = (env.BOB_HOST_DATA_DIR || '').replace(/\/+$/, '');
  if (!from || !to) return containerPath;
  if (containerPath === from || containerPath.startsWith(`${from}/`)) return `${to}${containerPath.slice(from.length)}`;
  throw new Error(`worker mount must live under ${from} to be visible to the host docker daemon: ${containerPath}`);
}

function dockerArguments({ image, sourceDir, artifactDir, profile, memory = '2g', cpus = '1', pidsLimit = 256, environment = {}, env = process.env }) {
  if (!image) throw new Error('worker image is required');
  if (!sourceDir || !artifactDir) throw new Error('sourceDir and artifactDir are required');
  const command = workerCommand(profile);
  const sourceMount = hostPath(sourceDir, env);
  const artifactMount = hostPath(artifactDir, env);
  const args = [
    'run', '--rm', '--init',
    profile === 'human-qa-live' ? '--network=bridge' : '--network=none',
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
    args.push(`--tmpfs=/work:rw,exec,nosuid,size=${profile === 'frontend-verify' ? '2048m' : '1024m'}`);
  }
  if (profile === 'human-qa' || profile === 'human-qa-live' || profile === 'full-page-audit') {
    args.push('--tmpfs=/workspace/apps/web/node_modules:rw,exec,nosuid,size=512m,uid=1000,gid=1000,mode=0755');
    for (const key of ['HUMAN_TEST_LIVE', 'HUMAN_TEST_BASE_URL', 'GRANDMASTER_TEST_EMAIL', 'GRANDMASTER_TEST_PASSWORD']) {
      if (environment[key]) args.push('--env', `${key}=${environment[key]}`);
    }
  }
  args.push(
    '--mount', `type=bind,src=${sourceMount},dst=/workspace,readonly`,
    '--mount', `type=bind,src=${artifactMount},dst=/artifacts`,
    image,
    ...command
  );
  return args;
}

function executeWorker(options, { spawnImpl = spawn } = {}) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const args = dockerArguments({ ...options, environment: {
    HUMAN_TEST_LIVE: process.env.HUMAN_TEST_LIVE,
    HUMAN_TEST_BASE_URL: process.env.HUMAN_TEST_BASE_URL,
    GRANDMASTER_TEST_EMAIL: process.env.GRANDMASTER_TEST_EMAIL,
    GRANDMASTER_TEST_PASSWORD: process.env.GRANDMASTER_TEST_PASSWORD,
    ...(options.environment || {})
  } });
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

module.exports = { WORKER_PROFILES, dockerArguments, executeWorker, hostPath, redact, workerCommand };
