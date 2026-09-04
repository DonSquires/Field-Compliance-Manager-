const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const compose = readFileSync(resolve(__dirname, '../deploy/bob-control-plane/docker-compose.yml'), 'utf8');

test('Bob control-plane deployment builds the production dependency image', () => {
  assert.match(compose, /build:\s+context: \.\.\/\.\.\s+dockerfile: Dockerfile/);
  assert.match(compose, /image: fcm-control-plane:current/);
  assert.match(compose, /- \/var\/lib\/bob:\/data/);
  assert.doesNotMatch(compose, /control-plane-source/);
});