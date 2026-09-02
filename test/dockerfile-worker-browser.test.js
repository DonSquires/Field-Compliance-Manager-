const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile.worker'), 'utf8');

test('Builder worker image supports isolated Playwright verification as a non-root user', () => {
  assert.match(dockerfile, /FROM mcr\.microsoft\.com\/playwright:v1\.62\.1-jammy/);
  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /ln -s \/opt\/bob\/web-node_modules \/opt\/bob\/node_modules/);
  assert.match(dockerfile, /chown -R 1000:1000 \/opt\/bob \/workspace/);
  assert.match(dockerfile, /USER 1000:1000/);
});