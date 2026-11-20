'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'local-ci.mjs')).href);
const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'verify-pr.yml'), 'utf8');

test('local CI reads every PR verification job and run step from the workflow', async () => {
  const { workflowJobs } = await load();
  const jobs = workflowJobs(workflow);
  assert.deepEqual(jobs.map((j) => j.id), ['runtime', 'web', 'browser']);
  assert.deepEqual(jobs.map((j) => j.name), [
    'Runtime and migration inventory',
    'Web types, build and unit tests',
    'Offline browser workflows',
  ]);
  const [runtime, web, browser] = jobs;
  assert.equal(runtime.workingDirectory, '.');
  assert.equal(web.workingDirectory, 'apps/web');
  assert.equal(browser.env.E2E_OFFLINE, '1');
  assert.equal(browser.env.HUMAN_TEST_LIVE, 'false');
  // Every `run:` line in the workflow must become a runnable local step — no silent drops.
  const runLines = workflow.split('\n').filter((l) => /^\s*(- )?run:\s+\S/.test(l)).length;
  assert.equal(jobs.flatMap((j) => j.steps).filter((s) => s.run).length, runLines);
  assert.ok(runtime.steps.some((s) => s.run === 'node --test --test-concurrency=4 test/*.test.js'));
  assert.ok(runtime.steps.some((s) => s.run && s.run.startsWith('BOB_TEST_POSTGRES=1 node --test')));
  const evidence = browser.steps.find((s) => s.name === 'Retain fixture browser evidence');
  assert.equal(evidence.run, null);
  assert.equal(evidence.always, true);
});

test('local CI parses block scalars, quoting and comments', async () => {
  const { parseYaml } = await load();
  const doc = parseYaml([
    'name: demo # trailing comment',
    'jobs:',
    '  a:',
    "    env: { }",
    '    steps:',
    '      - name: "quoted: value"',
    '        run: |',
    '          echo one',
    '          echo "#two"',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          persist-credentials: false',
  ].join('\n'));
  assert.equal(doc.name, 'demo');
  assert.equal(doc.jobs.a.steps[0].name, 'quoted: value');
  assert.equal(doc.jobs.a.steps[0].run, 'echo one\necho "#two"\n');
  assert.equal(doc.jobs.a.steps[1].with['persist-credentials'], 'false');
});

test('local CI drops hosted-only playwright system dependency install off Linux', async () => {
  const { localCommand } = await load();
  assert.equal(localCommand('npx playwright install --with-deps chromium', 'win32'), 'npx playwright install chromium');
  assert.equal(localCommand('npx playwright install --with-deps chromium', 'linux'), 'npx playwright install --with-deps chromium');
});
