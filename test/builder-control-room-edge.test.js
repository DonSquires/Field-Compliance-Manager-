'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const hasDeno = spawnSync('deno', ['--version'], { stdio: 'ignore' }).status === 0;

test('Builder Edge returns stored references without leaking other organizations or private fields', {
  skip: !hasDeno && 'Deno is required to exercise the actual Edge Function',
  timeout: 120000,
}, () => {
  const result = spawnSync('deno', [
    'run', '--no-check', '--no-config', '--node-modules-dir=none', '--allow-env', '--allow-net',
    '--allow-read', path.join('test', 'fixtures', 'builder-control-room-edge-harness.mjs'),
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110000,
    env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', DENO_NO_UPDATE_CHECK: '1',
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}) },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const line = result.stdout.split('\n').find(row => row.startsWith('BUILDER_FIXTURE_RESULT '));
  assert.ok(line, 'Fixture did not return its responses');
  const responses = JSON.parse(line.slice('BUILDER_FIXTURE_RESULT '.length));
  assert.equal(responses.list.status, 200);
  assert.deepEqual(responses.list.body.jobs.map(job => job.human_reference), ['BB-9007199254740992']);
  assert.equal(responses.list.body.jobs[0].autopilot_requested_by, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc');
  assert.equal(responses.list.body.jobs[0].autopilot_state, 'driving');
  assert.equal(responses.get.status, 200);
  assert.equal(responses.get.body.job.human_reference, 'BB-9007199254740992');
  assert.equal(responses.denied.status, 404);
  assert.equal('internal_secret' in responses.list.body.jobs[0], false);
  assert.equal('internal_secret' in responses.get.body.job, false);
  assert.equal(responses.firstPage.status, 200);
  assert.equal(responses.firstPage.body.jobs.length, 100);
  assert.ok(responses.firstPage.body.next_cursor, 'Older jobs need a continuation cursor');
  assert.equal(responses.secondPage.status, 200);
  assert.equal(responses.secondPage.body.jobs.length, 6);
  assert.equal(responses.secondPage.body.next_cursor, null);
  const all = [...responses.firstPage.body.jobs, ...responses.secondPage.body.jobs];
  assert.equal(new Set(all.map(job => job.id)).size, 106, 'Equal timestamps must not duplicate or omit jobs');
  assert.equal(all.at(-1).human_reference, 'BB-9007199254740992');
  assert.equal(responses.lookupOld.status, 200);
  assert.equal(responses.lookupOld.body.job?.human_reference, 'BB-9007199254740992');
  assert.equal(responses.lookupOtherTenant.status, 200);
  assert.equal(responses.lookupOtherTenant.body.job, null);
  assert.equal(responses.nameSearch.status, 200);
  assert.deepEqual(responses.nameSearch.body.jobs.map(job => job.human_reference), ['BB-9007199254740992']);
  assert.equal(responses.namePage1.body.jobs.length, 100);
  assert.equal(responses.namePage2.body.jobs.length, 5);
  assert.equal(responses.namePage2.body.next_cursor, null);
  assert.deepEqual(responses.regexLiteral.body.jobs, []);
  assert.equal(responses.badName.status, 400);
  assert.equal(responses.badCursor.status, 400);
  assert.equal(responses.rename.status, 200);
  assert.equal(responses.rename.body.job.title, 'Clearer work');
  assert.equal(responses.rename.body.job.human_reference, 'BB-9007199254740992');
  assert.equal('internal_secret' in responses.rename.body.job, false);
  assert.equal(responses.renameStale.status, 409);
  assert.match(responses.renameStale.body.error, /changed.*refresh/i);
  assert.equal(responses.renameOtherTenant.status, 404);
  assert.equal(responses.renameBlank.status, 400);
  assert.equal(responses.renameMissingExpected.status, 400);
  assert.equal(responses.renameAuditFailure.status, 503);
  assert.doesNotMatch(JSON.stringify(responses.renameAuditFailure.body), /fixture_deny_rename/);
  assert.equal(responses.renameInactive.status, 403);
  assert.equal(responses.renameOfficer.status, 403);
  assert.equal(responses.renameReadback.body.job.title, 'Clearer work');
});
