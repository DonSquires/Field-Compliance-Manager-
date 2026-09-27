'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const chat = fs.readFileSync('supabase/functions/onspace-ai-chat/index.ts', 'utf8');
const caddie = fs.readFileSync('supabase/functions/onspace-ai-chat/caddie.ts', 'utf8');
const planner = require('../services/fcm-api/src/bob/planPrompt.js');

const historySource = chat.slice(chat.indexOf('async function loadHistory('), chat.indexOf('// Bob\'s per-user memory', chat.indexOf('async function loadHistory(')));
assert.ok(historySource.startsWith('async function loadHistory('));
const loadHistory = vm.runInNewContext(`${historySource}\nloadHistory`);
const proposal = { job_id: '12345678-1234-1234-1234-123456789abc', title: 'Fix build', reason: 'No longer needed', user_id: 'owner', conversation_id: 'thread' };
const assistant = (metadata) => ({ role: 'assistant', content: 'preview', metadata });
const cancel = (outcome) => assistant({ tool: 'cancel_builder_job', outcome, pending_builder_cancellation: proposal });
const user = { role: 'user', content: 'yes' };
const laptop = assistant({ tool: 'laptop_shell', pending_laptop_command: { command: 'pwd', purpose: 'inspect' }, outcome: 'proposed' });
const builder = assistant({ tool: 'create_builder_job', pending_builder_job: { title: 'Build' }, outcome: 'proposed' });
async function recover(chronological) {
  const supabase = { from: (table) => {
    assert.equal(table, 'bob_messages');
    return { select() { return this; }, eq() { return this; }, order() { return this; }, async limit() { return { data: chronological.slice().reverse() }; } };
  } };
  return loadHistory(supabase, 'thread');
}

test('a newest proposed cancellation is recovered on the confirmation turn without a ReferenceError', async () => {
  const { pending } = await recover([user, cancel('proposed')]);
  assert.equal(pending.kind, 'builder_cancellation_pending');
  assert.equal(pending.builder_cancellation.job_id, proposal.job_id);
});

test('a non-newest proposed cancellation is ignored', async () => {
  assert.equal((await recover([cancel('proposed'), user])).pending, null);
  assert.equal((await recover([cancel('proposed'), builder])).pending.kind, 'builder_job_pending');
});

test('declined or consumed cancellation markers do not mask other pending kinds', async () => {
  for (const outcome of ['declined', 'consumed']) {
    assert.equal((await recover([laptop, cancel(outcome), user])).pending.kind, 'laptop_command_pending');
    assert.equal((await recover([builder, cancel(outcome), user])).pending.kind, 'builder_job_pending');
    assert.equal((await recover([cancel(outcome)])).pending, null);
  }
});

test('old proposed cancellation is skipped when scanning past it for another pending kind', async () => {
  assert.equal((await recover([laptop, cancel('proposed'), user])).pending.kind, 'laptop_command_pending');
  assert.equal((await recover([builder, cancel('proposed'), user])).pending.kind, 'builder_job_pending');
});

test('the control-room list data is narrowed before jobs are read', () => {
  const branch = chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':"));
  assert.match(branch, /callFn\('bob-builder-control-room', authHeader, \{ action: 'list' \}\)/);
  assert.doesNotMatch(branch, /\.from\(['"]builder_jobs['"]\)/);
  const expression = branch.match(/const jobs = ([^;]+);/);
  assert.ok(expression);
  const parseJobs = vm.runInNewContext(`(listed) => ${expression[1]}`);
  for (const data of [undefined, null, 0, '', [], {}, { jobs: null }, { jobs: {} }]) {
    assert.equal(parseJobs({ ok: true, data }), null);
  }
  const jobs = [{ id: proposal.job_id }];
  assert.equal(parseJobs({ ok: true, data: { jobs } }), jobs);
  assert.match(branch, /if \(!listed\.ok \|\| !jobs\) return \{ reply: .*No cancellation was made\./);
  assert.ok(branch.indexOf('if (!listed.ok || !jobs)') < branch.indexOf('jobs.filter('));
});

test('preview, caller RPC, immediate consumption and deterministic routing remain wired', () => {
  const branch = chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':"));
  assert.ok(branch.indexOf('if (!stored) {') < branch.indexOf("callerClient.rpc('builder_cancel_job'"));
  assert.match(branch, /pending_builder_cancellation: \{ job_id: job\.id, title: job\.title, reason, user_id: user\.id, conversation_id: conversationId \}/);
  assert.match(branch, /createClient\(Deno\.env\.get\('SUPABASE_URL'\).*Authorization: authHeader/);
  assert.match(branch, /callerClient\.rpc\('builder_cancel_job', \{ _job_id: jobId, _reason: reason \}\)/);
  assert.match(branch, /if \(stored && !\/\^\(yes\|/);
  const immediate = chat.slice(chat.indexOf("if (pending?.kind === 'builder_cancellation_pending') {\n      // Consume"), chat.indexOf('    const plan = await callPlan(planPayload);'));
  assert.match(immediate, /dispatchTool\('cancel_builder_job', \{\}/);
  assert.match(immediate, /await persist\(admin, orgId, conversationId, \[/);
  assert.match(immediate, /return json\(buildStructuredResponse\(/);
  assert.match(chat, /pending\.builder_cancellation\?\.user_id === user\.id && pending\.builder_cancellation\?\.conversation_id === conversationId\) \{\s*decision = \{ action: 'use_tool', tool: 'cancel_builder_job', args: \{\} \}/);
  assert.match(caddie, /cancel_builder_job: \{/);
  assert.match(planner.buildPendingBlock({ kind: 'builder_cancellation_pending', builder_cancellation: proposal }), /RESUME — BUILDER CANCELLATION AWAITING CONFIRMATION:[\s\S]*cancel_builder_job/);
});
