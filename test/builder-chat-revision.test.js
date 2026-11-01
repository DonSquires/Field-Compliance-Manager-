'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareSpecRevision, prepareCodeChanges, prepareImplementationRecovery } = require('../builder-chat-revision');
const { pmChatWithMemory } = require('../builder-chat-memory');

const JOB = '11111111-1111-4111-8111-111111111111';
const QUOTE = 'Please revise the specification before implementing a fix.';
const MESSAGE = { id: 'source', thread_id: 'thread', content: `Job ${JOB}. ${QUOTE}`, payload: {} };
const ARGS = { job_id: JOB, feedback: 'Revisit the reported workflow and distinguish unverified map leads from source findings before implementation.' };
function fixture({ linked = true, pending = true, error = null } = {}) {
  const calls = [];
  return { calls, from: table => {
    const query = {};
    for (const name of ['select', 'eq']) query[name] = (...args) => { calls.push({ table, name, args }); return query; };
    query.limit = async () => ({
      data: table === 'builder_chat_messages' ? (linked ? [{ id: 'handoff' }] : []) : pending ? [{ id: 'approval', requested_target_sha: 'a'.repeat(40) }] : [],
      error,
    });
    return query;
  } };
}
test('review tool binds exact human feedback and same-thread accepted job, and pins the pending gate', async () => {
  const db = fixture();
  const revision = await prepareSpecRevision(ARGS, MESSAGE, db);
  assert.equal(revision.job_id, JOB);
  assert.equal(revision.approval_id, 'approval');
  assert.equal(revision.target_sha, 'a'.repeat(40));
  assert.equal(revision.source_message_id, MESSAGE.id);
  assert.equal(revision.review_quote, MESSAGE.content);
  assert.ok(db.calls.some(call => call.name === 'eq' && call.args[0] === 'thread_id' && call.args[1] === MESSAGE.thread_id));
  assert.ok(db.calls.some(call => call.name === 'eq' && call.args[0] === 'status' && call.args[1] === 'pending'));
});
test('unsupplied job, invented quote, unrelated thread, moved gate and read failure cannot prepare revisions', async () => {
  for (const [args, message, db, expected] of [
    [{ ...ARGS, job_id: 'not-a-uuid' }, MESSAGE, fixture(), /UUID/],
    [ARGS, { ...MESSAGE, content: QUOTE }, fixture(), /must match/],
    [{ ...ARGS, review_quote: 'Invented evidence from unobserved logs.' }, MESSAGE, fixture(), /bounded feedback/],
    [ARGS, MESSAGE, fixture({ linked: false }), /no accepted handoff/],
    [ARGS, MESSAGE, fixture({ pending: false }), /exactly one/],
    [ARGS, MESSAGE, fixture({ error: { message: 'permission denied' } }), /Could not verify/],
  ]) await assert.rejects(prepareSpecRevision(args, message, db), expected);
});
test('native revision prepares a confirmation card in one assigned-model call, no effects or private evidence returned to cloud', async () => {
  const db = fixture();
  let calls = 0;
  const outcome = await pmChatWithMemory({
    message: MESSAGE, supabase: db, allowHandoff: true, request: { model: 'kimi-k2.7-code' },
    api: async () => {
      calls++;
      return { message: { tool_calls: [{ function: { name: 'request_builder_spec_revision', arguments: ARGS } }] } };
    }, post: () => assert.fail('No dispatch'),
  });

  assert.equal(calls, 1);
  assert.equal(outcome.revision.job_id, JOB);
  assert.equal(outcome.proposal, undefined);
  assert.deepEqual(outcome.memoryReceipts, []);
});

test('code-review feedback pins the implementation gate without using the specification channel', async () => {
  const db = fixture();
  const revision = await prepareCodeChanges(ARGS, MESSAGE, db);
  assert.equal(revision.kind, 'implementation');
  assert.equal(revision.source_message_id, MESSAGE.id);
  assert.equal(revision.review_quote, MESSAGE.content);
  assert.ok(db.calls.some(call => call.name === 'eq' && call.args[0] === 'approval_type' && call.args[1] === 'implementation_review'));
  assert.ok(!db.calls.some(call => call.args[1] === 'specification_review'));
  await assert.rejects(prepareCodeChanges(ARGS, MESSAGE, fixture({ pending: false })), /pending human code review/);
});

test('native code changes prepare only a card, and independent QA cannot dispatch one', async () => {
  const call = { message: { tool_calls: [{ function: { name: 'request_builder_code_changes', arguments: ARGS } }] } };
  let count = 0;
  const input = { message: MESSAGE, supabase: fixture(), request: {}, api: async () => { count++; return call; } };
  const outcome = await pmChatWithMemory({ ...input, allowHandoff: true });
  assert.equal(count, 1);
  assert.equal(outcome.revision.kind, 'implementation');
  assert.equal(outcome.proposal, undefined);
  assert.deepEqual(outcome.memoryReceipts, []);
  await assert.rejects(pmChatWithMemory({ ...input, allowHandoff: false }), /no other tools/);
});

test('recovery pins a failed same-thread correction without dispatch or private transfer', async () => {
  const db = fixture();
  const original = db.from;
  db.from = table => ['builder_jobs', 'builder_job_steps'].includes(table) ? {
    select() { return this; }, eq() { return this; },
    async limit() { return { data: table === 'builder_jobs'
      ? [{ id: JOB, status: 'failed', target_sha: 'a'.repeat(40), updated_at: '2026-10-26T10:30:00Z', code_review_revision: { approval_id: 'review' } }]
      : [{ id: 'failed-step', step_id: 'frontend_implementation', status: 'failed' }], error: null }; },
  } : original(table);
  const card = await prepareImplementationRecovery(ARGS, MESSAGE, db);
  assert.equal(card.kind, 'recovery');
  assert.equal(card.failed_step_id, 'failed-step');
  assert.equal(card.job_updated_at, '2026-10-26T10:30:00Z');
  assert.equal(card.approval_id, 'review');
  const input = { message: MESSAGE, supabase: db, request: {},
    api: async () => ({ message: { tool_calls: [{ function: { name: 'request_builder_implementation_recovery', arguments: ARGS } }] } }) };
  assert.equal((await pmChatWithMemory({ ...input, allowHandoff: true })).revision.kind, 'recovery');
  await assert.rejects(pmChatWithMemory({ ...input, allowHandoff: false }), /no other tools/);
  await assert.rejects(prepareImplementationRecovery(ARGS, MESSAGE, fixture()), /failed implementation-correction/);
});
