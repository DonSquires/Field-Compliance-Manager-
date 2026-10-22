const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { WORKER_NETWORK, WORKER_SUBNET } = require('./bob-firewall');

const MAIN_HEALTH_COMMAND = [
  'set -eu',
  'failed=0',
  'health_step() { name="$1"; shift; printf "\\nBOB_HEALTH_STEP %s START\\n" "$name"; if "$@"; then printf "\\nBOB_HEALTH_STEP %s PASS\\n" "$name"; else code=$?; printf "\\nBOB_HEALTH_STEP %s FAIL exit=%s\\n" "$name" "$code"; failed=1; fi; }',
  'cp -a /opt/bob/root-node_modules/. /workspace/node_modules/',
  'cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/',
  'cd /workspace',
  'export BOB_HEALTH_TRACKED_FILES=/artifacts/health-tracked-files.json',
  'health_step root-tests sh -c \'node --test --test-reporter=tap test/*.test.js\'',
  'cd /workspace/apps/web',
  'export PATH=/workspace/apps/web/node_modules/.bin:$PATH',
  'export VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=playwright-anon-key E2E_OFFLINE=1',
  'export PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report',
  'health_step lint npm run lint',
  'health_step build vite build --outDir=/tmp/bob-main-health-dist',
  'health_step unit-tests npm test -- --run',
  'health_step browser-smoke npm run test:e2e:ci-smoke',
  'exit "$failed"',
].join('; ');

const WORKER_PROFILES = Object.freeze({
  assessment: Object.freeze(['node', '/opt/bob/assessment-manifest.js', '/workspace', '/artifacts/system-assessment.json']),
  test: Object.freeze(['npm', 'test']),
  build: Object.freeze(['npm', 'run', 'build']),
  lint: Object.freeze(['npm', 'run', 'lint']),
  'human-qa': Object.freeze(['sh', '-lc', 'cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/ && cd /workspace/apps/web && PATH=/workspace/apps/web/node_modules/.bin:$PATH PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report playwright test e2e/dr-bob-human-test.spec.ts --workers=4']),
  'human-qa-live': Object.freeze(['sh', '-lc', 'cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/ && cd /workspace/apps/web && PATH=/workspace/apps/web/node_modules/.bin:$PATH PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report playwright test e2e/dr-bob-human-test.spec.ts --workers=1']),
  // Vibe branch check: Dr Bob's fixture walk plus targeted specs listed by the control plane in specs.txt
  // (validated e2e/<name>.spec.ts paths only), desktop project, offline.
  'vibe-human-qa': Object.freeze(['sh', '-lc', 'cp -a /opt/bob/web-node_modules/. /workspace/apps/web/node_modules/ && cd /workspace/apps/web && PATH=/workspace/apps/web/node_modules/.bin:$PATH PLAYWRIGHT_OUTPUT_DIR=/artifacts/test-results PLAYWRIGHT_HTML_OUTPUT_DIR=/artifacts/playwright-report PLAYWRIGHT_JSON_OUTPUT_NAME=/artifacts/results.json playwright test $(grep -E \'^e2e/[A-Za-z0-9][A-Za-z0-9._-]*\\.spec\\.ts$\' /artifacts/specs.txt) --project=desktop-chromium --workers=2 --reporter=line,json']),
  'main-health': Object.freeze(['sh', '-lc', MAIN_HEALTH_COMMAND]),
  'visual-baseline': Object.freeze(['node', '/opt/bob/visual-baseline-worker.js', '/workspace', '/artifacts']),
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

// Owner ruling 2026-10-21: workers get the network, tailnet included, on Bob's own bridge network
// (bob-workers) so the BOB-WORKER-EGRESS firewall chain can govern it. BOB_WORKER_NETWORK=none
// restores the offline sandbox. Workers still get no credentials beyond the human-test keys below.
function workerNetwork(profile, env = process.env) {
  if (profile === 'visual-baseline' || profile === 'vibe-human-qa') return 'none';
  const configured = String(env.BOB_WORKER_NETWORK || WORKER_NETWORK).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(configured) || configured === 'host') throw new Error(`unsupported worker network: ${configured}`);
  if (configured === 'none' && profile === 'human-qa-live') return 'bridge';
  return configured;
}

function dockerArguments({ image, sourceDir, artifactDir, profile, memory = '2g', cpus = '1', pidsLimit = 256, environment = {}, env = process.env }) {
  if (!image) throw new Error('worker image is required');
  if (!sourceDir || !artifactDir) throw new Error('sourceDir and artifactDir are required');
  const command = workerCommand(profile);
  const sourceMount = hostPath(sourceDir, env);
  const artifactMount = hostPath(artifactDir, env);
  const browserProfile = profile === 'human-qa' || profile === 'human-qa-live' || profile === 'vibe-human-qa' || profile === 'main-health' || profile === 'full-page-audit';
  const args = [
    'run', '--rm', '--init',
    `--network=${workerNetwork(profile, env)}`,
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges:true',
    '--user=1000:1000',
    `--memory=${memory}`,
    `--cpus=${cpus}`,
    `--pids-limit=${pidsLimit}`,
    // Root tests execute temporary git/npm fixtures; only this profile needs an executable /tmp.
    `--tmpfs=/tmp:rw,${profile === 'main-health' ? 'exec' : 'noexec'},nosuid,size=${browserProfile ? '1024m' : '64m'}`,
  ];
  if (profile === 'main-health') {
    args.push('--tmpfs=/workspace/node_modules:rw,exec,nosuid,size=256m,uid=1000,gid=1000,mode=0755');
    args.push('--tmpfs=/workspace/.bob:rw,noexec,nosuid,size=32m,uid=1000,gid=1000,mode=0755');
  }
  if (profile === 'frontend-verify' || profile === 'backend-verify' || profile === 'visual-baseline') {
    args.push(`--tmpfs=/work:rw,exec,nosuid,size=${profile === 'backend-verify' ? '1024m' : '2048m'}`);
  }
  if (browserProfile) {
    args.push('--tmpfs=/workspace/apps/web/node_modules:rw,exec,nosuid,size=768m,uid=1000,gid=1000,mode=0755');
    // The Vibe walk runs unreviewed branch code offline: it only ever receives the fixture switches.
    const forwarded = profile === 'vibe-human-qa' ? ['HUMAN_TEST_LIVE', 'E2E_OFFLINE'] : ['HUMAN_TEST_LIVE', 'E2E_OFFLINE', 'HUMAN_TEST_BASE_URL', 'HUMAN_TEST_EXPECTED_SHA', 'HUMAN_TEST_REQUIRE_DEPLOYMENT_MATCH', 'HUMAN_TEST_ADMIN_ROUTE', 'GRANDMASTER_TEST_EMAIL', 'GRANDMASTER_TEST_PASSWORD', 'VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID'];
    for (const key of forwarded) {
      if (environment[key]) args.push('--env', key);
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

const ensuredNetworks = new Map();
function ensureWorkerNetwork(name, { spawnImpl = spawn } = {}) {
  if (['none', 'bridge'].includes(name)) return Promise.resolve();
  if (!ensuredNetworks.has(name)) {
    const run = args => new Promise(resolve => {
      const child = spawnImpl('docker', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', chunk => { stderr += chunk; });
      child.on('error', error => resolve({ code: null, stderr: error.message }));
      child.on('close', code => resolve({ code, stderr }));
    });
    const subnet = name === WORKER_NETWORK ? ['--subnet', WORKER_SUBNET] : [];
    const pending = run(['network', 'inspect', name]).then(async inspected => {
      if (inspected.code === 0) return;
      const created = await run(['network', 'create', '--driver', 'bridge', ...subnet, name]);
      if (created.code !== 0 && !/already exists/i.test(created.stderr)) throw new Error(`could not create worker network ${name}: ${created.stderr.trim()}`);
    });
    pending.catch(() => ensuredNetworks.delete(name));
    ensuredNetworks.set(name, pending);
  }
  return ensuredNetworks.get(name);
}

async function executeWorker(options, { spawnImpl = spawn } = {}) {
  const timeoutMs = options.timeoutMs || 10 * 60 * 1000;
  const environment = options.environment || {};
  const args = dockerArguments({ ...options, environment });
  prepareWorkerMounts(options.sourceDir, options.profile);
  if (options.profile === 'main-health') {
    const tracked = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', 'HEAD'], {
      cwd: options.sourceDir, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    }).split('\0').filter(Boolean);
    fs.writeFileSync(path.join(options.artifactDir, 'health-tracked-files.json'), JSON.stringify(tracked), { mode: 0o600 });
  }
  await ensureWorkerNetwork(workerNetwork(options.profile, options.env || process.env), { spawnImpl });
  return new Promise((resolve, reject) => {
    const child = spawnImpl('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...environment }
    });
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

function prepareWorkerMounts(sourceDir, profile) {
  if (profile !== 'main-health' && profile !== 'vibe-human-qa') return;
  // Docker cannot create nested mountpoints inside the read-only source bind.
  for (const relative of profile === 'main-health' ? ['node_modules', '.bob', 'apps/web/node_modules'] : ['apps/web/node_modules']) {
    const target = path.join(sourceDir, relative);
    fs.mkdirSync(target, { recursive: true });
    if (!fs.lstatSync(target).isDirectory()) throw new Error(`worker mountpoint must be a directory: ${relative}`);
  }
}

function summarizeHumanTest(result) {
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const matches = [...output.matchAll(/^\s*(\d+)\s+(passed|failed|skipped)(?:\s|$)/gm)];
  const summary = { passed: 0, failed: 0, skipped: 0 };
  for (const match of matches) summary[match[2]] = Number(match[1]);
  return summary;
}

function redact(value) {
  return value
    .replace(/authorization\s*[:=]\s*Bearer\s+[^\s,;]+/gi, 'authorization=[REDACTED]')
    .replace(/(authorization|token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/(sk-[A-Za-z0-9_-]+)/g, '[REDACTED]');
}

module.exports = { WORKER_PROFILES, dockerArguments, ensureWorkerNetwork, executeWorker, workerNetwork, prepareWorkerMounts, hostPath, redact, summarizeHumanTest, workerCommand };
