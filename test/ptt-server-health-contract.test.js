const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const pttServerSource = readFileSync(resolve(__dirname, '../ptt-server/dist/index.js'), 'utf8');

test('ptt-server implements a clean JSON /health endpoint', () => {
  assert.match(pttServerSource, /req\.url === '\/health'/);
  assert.match(pttServerSource, /Content-Type': 'application\/json'/);
  assert.match(pttServerSource, /status: 'ok'/);
  assert.match(pttServerSource, /service: 'ptt-server'/);
});

test('ptt-server supports authentication, floor requests, and transcripts', () => {
  assert.match(pttServerSource, /case 'auth':/);
  assert.match(pttServerSource, /case 'floor_request':/);
  assert.match(pttServerSource, /case 'floor_release':/);
  assert.match(pttServerSource, /case 'transcript':/);
  assert.match(pttServerSource, /type: 'transcript_received'/);
});
