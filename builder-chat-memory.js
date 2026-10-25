'use strict';

const { HANDOFF_TOOL, investigationProposal } = require('./builder-chat-handoff');

const SELF_MEMORY_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: 'write_self_memory',
    description: 'Append a useful lesson, correction or job-continuity note to your existing private diary. This is your memory, not approved knowledge or a growth score. Use only non-sensitive material from this approved packet; no tenant/personal data. Save only something worth carrying forward, not every answer. No approval gate is required for writing. Reading existing private memories into cloud requires separate human review. One note per turn.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['content', 'memory_type'],
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 2000 },
        memory_type: { type: 'string', enum: ['reflection', 'builder_note'] },
      },
    },
  },
});

function assertNoUnreceiptedMemoryClaim(result) {
  const text = result.message?.content || '';
  if (/\b(?:i(?:['’]ve| have)?|we(?:['’]ve| have)?)\s+(?:(?:have|successfully|just|already)\s+)*(?:saved|recorded|stored|written|appended|remembered|kept)\b[^.!?\n]{0,160}\b(?:memory|diary|lesson|note|reflection)\b|\bwrite_self_memory\b[^.!?\n]{0,80}\b(?:executed|succeeded|successful(?:ly)?)\b/i.test(text)) {
    throw new Error('PM claimed a diary write without a saved memory receipt; no write was performed');
  }
}

function completedPmResult(result) {
  if (result.done_reason === 'length') throw new Error('Cloud PM output limit reached; answer is incomplete and was not accepted');
  return result;
}

async function pmChatWithMemory({ api, request, supabase, message, post, allowHandoff = false }) {
  const first = completedPmResult(await api('chat', { ...request, tools: [SELF_MEMORY_TOOL, ...(allowHandoff ? [HANDOFF_TOOL] : [])] }, 90_000));
  const calls = first.message?.tool_calls;
  if (calls !== undefined && !Array.isArray(calls)) throw new Error('Cloud PM tool calls must be an array');
  if (!calls?.length) {
    assertNoUnreceiptedMemoryClaim(first);
    return { result: first, memoryReceipts: [] };
  }
  const tool = calls[0]?.function?.name;
  if (calls.length !== 1 || (tool !== 'write_self_memory' && !(allowHandoff && tool === HANDOFF_TOOL.function.name))) {
    throw new Error('Cloud PM may use one diary or investigation handoff tool per turn; no other tools are enabled');
  }
  let args = calls[0].function.arguments;
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { throw new Error('PM tool arguments must be valid JSON'); }
  }
  if (tool === HANDOFF_TOOL.function.name) {
    const proposal = investigationProposal(args, message);
    return { result: first, memoryReceipts: [], proposal };
  }
  if (!args || typeof args.content !== 'string' || !args.content.trim() || args.content.length > 2000
      || !['reflection', 'builder_note'].includes(args.memory_type)
      || Object.keys(args).some(key => !['content', 'memory_type'].includes(key))) {
    throw new Error('Diary entry requires bounded content and reflection or builder_note type');
  }
  const { data, error } = await supabase.rpc('builder_chat_remember', {
    p_message_id: message.id, p_content: args.content.trim(), p_memory_type: args.memory_type,
  });
  if (error || typeof data !== 'string' || !data) throw new Error(`Bob could not save his diary entry: ${error?.message || 'missing memory receipt'}`);
  const receipt = { memory_id: data, memory_type: args.memory_type, status: 'kept', authority: 'self_memory_not_approved_knowledge' };
  await post({
    role: 'tool', kind: 'tool', content: 'Bob saved a private diary entry. This is memory, not approved knowledge or verified growth.',
    payload: { message_id: message.id, tool: 'write_self_memory', ok: true, ...receipt },
  });
  const result = completedPmResult(await api('chat', {
    ...request,
    messages: [...request.messages, first.message, {
      role: 'tool', tool_name: 'write_self_memory', content: JSON.stringify(receipt),
    }],
  }, 90_000));
  if (result.message?.tool_calls?.length) throw new Error('Diary entry was saved, but PM requested another tool instead of completing the answer');
  return { result, memoryReceipts: [receipt] };
}

module.exports = { SELF_MEMORY_TOOL, completedPmResult, pmChatWithMemory };
