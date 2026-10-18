const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../bob-control-plane-server.js'), 'utf8');

test('Builder control-plane routes use server-fixed execution authority', () => {
  assert.match(source, /sourceDir: assessmentRoot/);
  assert.match(source, /workerImage: builderWorkerImage/);
  assert.match(source, /runnerId: builderRunnerId/);
  assert.doesNotMatch(source, /sourceDir:\s*body\./);
  assert.doesNotMatch(source, /workerImage:\s*body\./);
});

test('Builder advance route executes one durable coordinator action', () => {
  assert.match(source, /\/api\\\/bob\\\/builder\\\/jobs/);
  assert.match(source, /advanceBuilderJob/);
  assert.match(source, /outcome\.advanced \? 202 : 200/);
  assert.match(source, /runBuilderUntilPause/);
  assert.match(source, /advance\|run/);
});

test('automatic continuations use the atomic lineage RPC instead of creating detached root jobs', () => {
  const continuation = source.slice(source.indexOf('createJob: async (input)'), source.indexOf('loadJob: async (jobId)'));
  assert.match(continuation, /rpc\('builder_create_autopilot_child'/);
  assert.match(continuation, /_parent_job_id: input\.parentJobId/);
  assert.doesNotMatch(continuation, /rpc\('builder_create_job_v2'/);
  assert.doesNotMatch(continuation, /rpc\('builder_autopilot_bind'/);
});