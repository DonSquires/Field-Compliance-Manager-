const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const service = fs.readFileSync(path.join(root, 'deploy/bob-control-plane/bob-control-plane.service'), 'utf8');
const nginx = fs.readFileSync(path.join(root, 'deploy/bob-control-plane/nginx.conf.template'), 'utf8');
const environment = fs.readFileSync(path.join(root, 'deploy/bob-control-plane/environment.example'), 'utf8');
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const deployWorkflow = fs.readFileSync(path.join(root, '.gitea/workflows/bob-control-plane-host-deploy.yml'), 'utf8');

test('host runtime is loopback-bound, non-root, and uses host-visible protected worker temp space', () => {
  assert.match(service, /User=bob-builder/);
  assert.match(service, /SupplementaryGroups=docker/);
  assert.match(service, /Environment=HOST=127\.0\.0\.1/);
  assert.match(service, /Environment=TMPDIR=\/var\/lib\/bob\/tmp/);
  assert.match(service, /PrivateTmp=true/);
  assert.match(service, /ReadWritePaths=\/var\/lib\/bob/);
  assert.doesNotMatch(service, /MemoryDenyWriteExecute/);
  const server = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');
  assert.match(server, /path\.join\(stateDir, 'artifacts'\)/);
  assert.match(server, /chmodSync\(artifactDir, 0o777\)/);
  assert.doesNotMatch(server, /path\.join\(assessmentRoot, 'bob-artifacts'\)/);
});

test('TLS proxy exposes only health and Builder execution routes', () => {
  assert.match(nginx, /listen 443 ssl/);
  assert.match(nginx, /location = \/health/);
  assert.match(nginx, /\/api\/bob\/builder\/jobs\/\[0-9a-f-\]\+\/\(advance\|run\)/);
  assert.match(nginx, /location \/ \{\s*return 404;/s);
  assert.doesNotMatch(nginx, /\/assessment/);
  assert.doesNotMatch(nginx, /\/jobs\/[^[]/);
});

test('example environment contains names only and keeps production deployment disabled', () => {
  for (const line of environment.split('\n').filter(line => line && !line.startsWith('#'))) {
    const [name, value = ''] = line.split('=', 2);
    assert.match(name, /^[A-Z0-9_]+$/);
    if (!['BOB_ALLOWED_REPOSITORIES', 'BOB_ALLOWED_REFS', 'BOB_ASSESSMENT_ROOT', 'BOB_STATE_DIR', 'BOB_WORKER_IMAGE', 'BOB_BUILDER_RUNNER_ID', 'BOB_WORKER_TIMEOUT_MS', 'OLLAMA_URL', 'BOB_OLLAMA_MODELS'].includes(name)) {
      assert.equal(value, '');
    }
  }
  assert.doesNotMatch(environment, /DEPLOYMENT_ENABLED|PRODUCTION_DEPLOY/);
});

test('production control-plane image includes required runtime modules', () => {
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /COPY bob-control-plane-server\.js \/app\/bob-control-plane-server\.js/);
  assert.match(dockerfile, /COPY builder-frontend-orchestrator\.js \/app\/builder-frontend-orchestrator\.js/);
  assert.match(dockerfile, /COPY builder-backend-handoff\.js \/app\/builder-backend-handoff\.js/);
  assert.match(dockerfile, /COPY builder-security-handoff\.js \/app\/builder-security-handoff\.js/);
  assert.match(dockerfile, /COPY builder-model-gateway\.js \/app\/builder-model-gateway\.js/);
  assert.match(dockerfile, /COPY builder-runtime-coordinator\.js \/app\/builder-runtime-coordinator\.js/);
  assert.match(dockerfile, /COPY supabase-workflow-client\.js \/app\/supabase-workflow-client\.js/);
  assert.match(dockerfile, /COPY supabase\/functions\/_shared \/app\/supabase\/functions\/_shared/);
  assert.match(dockerfile, /CMD \["node", "\/app\/bob-control-plane-server\.js"\]/);
});

test('Gitea deploy workflow is manual and restarts only the Bob host service', () => {
  assert.match(deployWorkflow, /workflow_dispatch:/);
  assert.match(deployWorkflow, /deploy_ref:/);
  assert.match(deployWorkflow, /npm test -- --test-reporter=spec test\/bob-control-plane\.test\.js test\/bob-control-plane-readiness\.test\.js test\/bob-control-plane-host-runtime\.test\.js/);
  assert.match(deployWorkflow, /--exclude='\.env'/);
  assert.match(deployWorkflow, /test -n "\$BOB_VPS_KNOWN_HOSTS"/);
  assert.match(deployWorkflow, /\/opt\/bob-control-plane\/releases\/\$BOB_RELEASE_SHA/);
  assert.match(deployWorkflow, /docker build -f Dockerfile\.worker -t "\$BOB_WORKER_IMAGE" \./);
  assert.match(deployWorkflow, /systemctl restart bob-control-plane/);
  assert.doesNotMatch(deployWorkflow, /3010/);
  assert.doesNotMatch(deployWorkflow, /docker compose/);
});