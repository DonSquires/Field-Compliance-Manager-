'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pmChatWithMemory } = require('../builder-chat-memory');

function fixture({ arguments: args = { content: 'A map guides checks; it does not prove execution.', memory_type: 'reflection' }, saveError, final, tool = 'write_self_memory', initial } = {}) {
  const requests = [], writes = [], posts = [];
  const responses = [initial || { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: tool, arguments: args } }] }, done_reason: 'stop' },
    final || { message: { role: 'assistant', content: 'I recorded the lesson in my own memory.' }, done_reason: 'stop' }];
  return {
    requests, writes, posts,
    run: () => pmChatWithMemory({
      api: async (_endpoint, request) => { requests.push(request); return responses.shift(); },
      request: { model: 'kimi-k2.7-code', messages: [{ role: 'user', content: 'Remember this lesson.' }] },
      message: { id: 'approved-message' },
      post: async row => posts.push(row),
      supabase: { rpc: async (name, args) => { writes.push({ name, args }); return { data: saveError ? null : 'memory-id', error: saveError ? { message: saveError } : null }; } },
    }),
  };
}

test('ordinary PM answers use one inference, with a discoverable diary tool but no compulsory memory write', async () => {
  const f = fixture({ initial: { message: { content: 'Atlas is a map, not evidence.' } } });
  const result = await f.run();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].tools[0].function.name, 'write_self_memory');
  assert.equal(f.writes.length, 0);
  assert.deepEqual(result.memoryReceipts, []);
});

test('Bob chooses an append-only diary write, receives its receipt and finishes with the same model', async () => {
  const f = fixture();
  const result = await f.run();
  assert.deepEqual(f.writes, [{
    name: 'builder_chat_remember',
    args: { p_message_id: 'approved-message', p_content: 'A map guides checks; it does not prove execution.', p_memory_type: 'reflection' },
  }]);
  assert.deepEqual(f.requests.map(request => request.model), ['kimi-k2.7-code', 'kimi-k2.7-code']);
  assert.ok(!f.requests[1].tools);
  assert.equal(f.requests[1].messages.at(-1).role, 'tool');
  assert.equal(result.memoryReceipts[0].authority, 'self_memory_not_approved_knowledge');
  assert.equal(f.posts[0].payload.memory_id, 'memory-id');
});

test('invalid diary arguments, unrelated tools, output limits and failed persistence surface before any success', async () => {
  for (const [options, expected] of [
    [{ arguments: { content: '', memory_type: 'reflection' } }, /bounded content/],
    [{ arguments: { content: 'x'.repeat(2001), memory_type: 'reflection' } }, /bounded content/],
    [{ arguments: { content: 'A lesson', memory_type: 'approved_knowledge' } }, /reflection or builder_note/],
    [{ arguments: '{broken' }, /valid JSON/],
    [{ tool: 'create_job' }, /no other tools/],
    [{ initial: { message: { content: 'Incomplete' }, done_reason: 'length' } }, /output limit/],
    [{ initial: { message: { content: 'I have recorded the lesson in my diary.' } } }, /without a saved memory receipt/],
    [{ saveError: 'permission denied' }, /could not save.*permission denied/],
  ]) {
    const f = fixture(options);
    await assert.rejects(f.run(), expected);
    assert.equal(f.requests.length, 1);
    assert.equal(f.posts.length, 0);
  }
});

test('a saved note remains honestly receipted if the final answer fails or requests more tools', async () => {
  for (const final of [
    { message: { content: 'unfinished' }, done_reason: 'length' },
    { message: { tool_calls: [{ function: { name: 'write_self_memory' } }] } },
  ]) {
    const f = fixture({ final });
    await assert.rejects(f.run(), /output limit|another tool/);
    assert.equal(f.writes.length, 1);
    assert.equal(f.posts[0].payload.memory_id, 'memory-id');
    assert.equal(f.requests.length, 2);
  }
});
