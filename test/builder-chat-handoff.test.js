'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { investigationProposal } = require('../builder-chat-handoff');
const { pmChatWithMemory } = require('../builder-chat-memory');

const REPORT = 'The screen only showed an error after part of my request succeeded.';
const MESSAGE = { id: 'source-message', content: REPORT, payload: {} };
const ARGS = {
  title: 'Partial-success error feedback', report_quote: REPORT,
  assessment: 'The reported feedback may leave users uncertain about side effects and safe retries.',
  investigation_steps: ['Inspect the owning error and persisted receipt path.', 'Check the retry behavior with a synthetic partial failure.'],
  acceptance_checks: ['Show confirmed side effects separately from a failed answer.', 'Verify that retrying does not duplicate completed side effects.'],
  unknowns: 'The failing stage and underlying implementation have not been inspected.',
  frontend_required: true, backend_required: true,
};

test('handoff binds the reported quote and source message without claiming source inspection', () => {
  const proposal = investigationProposal(ARGS, MESSAGE);
  assert.equal(proposal.handoff_kind, 'investigation');
  assert.equal(proposal.source_message_id, MESSAGE.id);
  assert.match(proposal.task_description, /not a source-verified repair plan/);
  assert.match(proposal.task_description, /inspect owning source, schema, callers and writers/);
  assert.match(proposal.task_description, /existing job ledger/);
  assert.match(proposal.task_description, /before\/during\/after/);
  assert.match(proposal.task_description, /not independently verified/);
  assert.throws(() => investigationProposal({ ...ARGS, report_quote: 'Invented evidence was verified by live checks.' }, MESSAGE), /must match/);
  assert.equal(investigationProposal({ ...ARGS, report_quote: REPORT }, { ...MESSAGE, content: 'Please investigate.', payload: { evidence_summary: REPORT } }).handoff_kind, 'investigation');
});

test('invalid or overbroad handoffs fail explicitly', () => {
  for (const args of [
    { ...ARGS, frontend_required: false, backend_required: false },
    { ...ARGS, title: '' }, { ...ARGS, backend_required: 'true' },
    { ...ARGS, investigation_steps: ['Inspect'] }, { ...ARGS, unknowns: '' },
    { ...ARGS, acceptance_checks: ['x'.repeat(501), 'Check the user outcome.'] },
    { ...ARGS, target: 'vibe' },
  ]) assert.throws(() => investigationProposal(args, MESSAGE), /Invalid|requires/);
});

test('short reports require normalized whole-report equality, never a short fragment', () => {
  const args = { ...ARGS, report_quote: 'Fix HTTP 500' };
  assert.equal(investigationProposal(args, { ...MESSAGE, content: ' Fix\nHTTP 500 ' }).handoff_kind, 'investigation');
  assert.throws(() => investigationProposal({ ...args, report_quote: 'HTTP 500' }, { ...MESSAGE, content: 'Fix HTTP 500' }), /must match/);
  assert.throws(() => investigationProposal(args, { ...MESSAGE, content: 'Please Fix HTTP 500 when saving.' }), /must match/);
  assert.throws(() => investigationProposal({ ...args, report_quote: ' ' }, MESSAGE), /Invalid/);
});

test('validated extracted documents support reports with retained attachment provenance, not web or images', async () => {
  const source = { id: 'attachment-1', attachment_id: 'approved-file', sha256: 'a'.repeat(64), transfer: 'locally_extracted_text', content: REPORT };
  const message = { ...MESSAGE, content: 'Investigate the attached report.' };
  const proposal = investigationProposal(ARGS, message, [source]);
  assert.match(proposal.task_description, /"attachment_id":"approved-file"/);
  assert.match(proposal.task_description, /"source_id":"attachment-1"/);
  assert.ok(proposal.task_description.includes(source.sha256));
  for (const invalid of [{ ...source, transfer: 'raw_image' }, { ...source, transfer: undefined }, { ...source, attachment_id: undefined }]) {
    assert.throws(() => investigationProposal(ARGS, message, [invalid]), /must match/);
  }
  const result = await pmChatWithMemory({
    message, sources: [source], allowHandoff: true, request: {},
    api: async () => ({ message: { tool_calls: [{ function: { name: 'propose_builder_investigation', arguments: ARGS } }] } }),
    supabase: { rpc: () => assert.fail('No writes') }, post: () => assert.fail('No posts'),
  });
  assert.match(result.proposal.task_description, /approved-file/);
});

test('one native handoff call yields an unconfirmed proposal with no job, diary write or extra inference', async () => {
  const calls = [];
  const outcome = await pmChatWithMemory({
    allowHandoff: true, message: MESSAGE,
    request: { model: 'kimi-k2.7-code', messages: [] },
    api: async (_endpoint, body) => {
      calls.push(body);
      return { done_reason: 'stop', message: { content: '', tool_calls: [{ function: { name: 'propose_builder_investigation', arguments: JSON.stringify(ARGS) } }] } };
    },
    supabase: { rpc: () => assert.fail('Handoff must not create jobs or diary writes') },
    post: () => assert.fail('Proposal is persisted by the existing chat worker, not as a completed dispatch'),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tools.length, 3);
  assert.equal(outcome.proposal.handoff_kind, 'investigation');
  assert.deepEqual(outcome.memoryReceipts, []);
});

test('QA and incomplete/multiple native calls cannot silently create a proposal', async () => {
  for (const [allowHandoff, reason, count] of [[false, 'stop', 1], [true, 'length', 1], [true, 'stop', 2]]) {
    await assert.rejects(pmChatWithMemory({
      allowHandoff, message: MESSAGE, request: {},
      api: async () => ({ done_reason: reason, message: { tool_calls: Array.from({ length: count }, () => ({ function: { name: 'propose_builder_investigation', arguments: ARGS } })) } }),
      supabase: { rpc: () => assert.fail('No writes') }, post: () => assert.fail('No posts'),
    }), /no other tools|output limit/);
  }
});
