const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const conductor = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = fs.readFileSync(path.join(root, 'supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const controlRoom = fs.readFileSync(path.join(root, 'supabase/functions/bob-builder-control-room/index.ts'), 'utf8');
const controlPlane = fs.readFileSync(path.join(root, 'bob-control-plane-server.js'), 'utf8');

test('Bob human testing is backed by durable control-plane start and status receipts', () => {
  assert.match(caddie, /run_human_test:\s*\{/);
  assert.match(caddie, /Never say a test is running unless this tool returns a queued\/running run with an ID/);
  assert.match(caddie, /run_human_test: 'bob-builder-control-room'/);
  assert.match(conductor, /async function execHumanTest/);
  assert.match(conductor, /case 'run_human_test'/);
  assert.match(conductor, /durable control-plane receipt, not an inferred background status/);
  assert.match(controlRoom, /action === 'human_test_start' \|\| action === 'human_test_status'/);
  assert.match(controlPlane, /humanTestRuns: \[\.\.\.humanTestRuns\.values\(\)\]/);
  assert.match(controlPlane, /\/api\/bob\/human-tests\/latest/);
  assert.match(controlPlane, /human-test-receipt\.json/);
});

test('live human testing requires the dedicated configured test identity', () => {
  assert.match(controlPlane, /GRANDMASTER_TEST_EMAIL/);
  assert.match(controlPlane, /GRANDMASTER_TEST_PASSWORD/);
  assert.match(controlPlane, /Dedicated live human-test identity and target URL are not configured/);
  assert.match(controlRoom, /Live human testing is restricted to grand master/);
});

test('fixture human testing has a bounded browser-sized resource profile', () => {
  assert.match(controlPlane, /mode === 'live' \? '2g' : '8g'/);
  assert.match(controlPlane, /mode === 'live' \? 256 : 1024/);
  assert.match(controlPlane, /mode === 'live'[\s\S]*GRANDMASTER_TEST_PASSWORD[\s\S]*: \{ HUMAN_TEST_LIVE: 'false' \}/);
});
