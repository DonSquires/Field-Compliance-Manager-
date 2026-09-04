const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dockerfile = fs.readFileSync(path.resolve(__dirname, '../Dockerfile'), 'utf8');

test('control-plane image provides locked production dependencies outside the read-only app mount', () => {
  assert.match(dockerfile, /WORKDIR \/opt\/bob/);
  assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /ENV NODE_PATH=\/opt\/bob\/node_modules/);
  assert.match(dockerfile, /COPY --chown=bob:bob \. \/app/);
  assert.match(dockerfile, /USER bob/);
  assert.match(dockerfile, /CMD \["node", "\/app\/bob-control-plane-server\.js"\]/);
});