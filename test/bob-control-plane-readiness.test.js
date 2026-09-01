const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../bob-control-plane-server.js'), 'utf8');

test('control plane supports loopback binding and authenticated readiness', () => {
  assert.match(source, /const host = process\.env\.HOST \|\| '0\.0\.0\.0'/);
  assert.match(source, /url\.pathname === '\/ready'/);
  assert.match(source, /if \(!authorized\(req\)\) return json\(res, 401/);
  assert.match(source, /server\.listen\(port, host/);
});

test('Builder readiness checks real Docker access without exposing configuration values', () => {
  assert.match(source, /docker', \['version', '--format'/);
  assert.match(source, /persistence_configured/);
  assert.match(source, /model_gateway_configured/);
  assert.match(source, /local_model_configured/);
  assert.match(source, /modelGatewayReadiness/);
  assert.match(source, /worker_image_configured/);
  assert.match(source, /repository_available/);
  assert.match(source, /\['package\.json', 'assessment-manifest\.js'\]/);
  assert.doesNotMatch(source, /path\.join\(assessmentRoot, '\.git'\)/);
  assert.doesNotMatch(source, /checks = \{[^}]*SUPABASE_SERVICE_ROLE_KEY/s);
});

test('public health caches Docker probes while authenticated readiness remains fresh', () => {
  assert.match(source, /dockerReadinessCache/);
  assert.match(source, /now - dockerReadinessCache\.checkedAt >= 15000/);
  assert.match(source, /builderRuntimeReadiness\(\{ dockerAccess: cachedDockerAccess\(\) \}\)/);
  assert.match(source, /url\.pathname === '\/ready'[\s\S]*builderRuntimeReadiness\(\)/);
});