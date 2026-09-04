const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const workflow = readFileSync(resolve(__dirname, '../.github/workflows/deploy-bob-control-plane.yml'), 'utf8');

test('Bob control-plane deployment uses the repository VPS secret without exposing it', () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /secrets\.VPS_SSH_PRIVATE_KEY/);
  assert.match(workflow, /ssh-keygen -y -f/);
  assert.match(workflow, /PRIVATE KEY/);
  assert.match(workflow, /base64 -d/);
  assert.match(workflow, /VPS_SSH_PRIVATE_KEY is not a valid private SSH key/);
  assert.match(workflow, /root@72\.61\.123\.97/);
  assert.match(workflow, /tar[\s\S]*--exclude='\.\/\.env'/);
  assert.doesNotMatch(workflow, /git pull --ff-only origin main/);
  assert.match(workflow, /docker compose -f deploy\/bob-control-plane\/docker-compose\.yml up -d --force-recreate bob-control-plane/);
  assert.match(workflow, /172\.16\.0\.1:8091\/health/);
  assert.doesNotMatch(workflow, /echo\s+["']?\$VPS_SSH_PRIVATE_KEY|printf.*key_file.*stdout/);
});