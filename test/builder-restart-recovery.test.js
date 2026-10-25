'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVibeStore } = require('../builder-vibe-session');
const { createBuilderChatStore } = require('../builder-chat-session');

// Minimal in-memory PostgREST-style client: select/update/insert with eq filters.
function memorySupabase(tables) {
  const from = (name) => {
    const rows = tables[name] || (tables[name] = []);
    const filters = [];
    let mode = 'select';
    let patch = null;
    const matches = row => filters.every(([column, value]) => row[column] === value);
    const builder = {
      select() { return builder; },
      eq(column, value) { filters.push([column, value]); return builder; },
      update(values) { mode = 'update'; patch = values; return builder; },
      insert(values) { rows.push({ ...values }); return Promise.resolve({ error: null }); },
      then(resolve, reject) {
        const hit = rows.filter(matches);
        if (mode === 'update') for (const row of hit) Object.assign(row, patch);
        return Promise.resolve({ data: hit.map(row => ({ ...row })), error: null }).then(resolve, reject);
      },
    };
    return builder;
  };
  return { from };
}

test('a Vibe turn interrupted by a restart is queued again once and its session reopened', async () => {
  const tables = {
    builder_vibe_messages: [
      { id: 'm1', session_id: 's1', role: 'owner', status: 'claimed', payload: {} },
      { id: 'm2', session_id: 's2', role: 'owner', status: 'claimed', payload: { restart_retries: 1 } },
      { id: 'm3', session_id: 's3', role: 'owner', status: 'claimed', payload: { action: 'ship' } },
      { id: 'm4', session_id: 's1', role: 'owner', status: 'done', payload: {} },
    ],
    builder_vibe_sessions: [
      { id: 's1', status: 'working', pr_url: null },
      { id: 's2', status: 'working', pr_url: 'https://github.com/o/r/pull/1' },
      { id: 's3', status: 'shipping', pr_url: null },
      { id: 's4', status: 'open', pr_url: null },
    ],
  };
  const outcome = await createVibeStore(memorySupabase(tables)).recoverInterruptedTurns();
  assert.deepEqual(outcome, { requeued: 1, failed: 2, sessions: 3 });
  const byId = Object.fromEntries(tables.builder_vibe_messages.filter(row => row.id).map(row => [row.id, row]));
  assert.equal(byId.m1.status, 'queued');
  assert.equal(byId.m1.claimed_at, null);
  assert.equal(byId.m1.payload.restart_retries, 1);
  assert.equal(byId.m2.status, 'failed', 'a second restart does not loop the same message');
  assert.equal(byId.m3.status, 'failed', 'a ship is never repeated automatically');
  assert.equal(byId.m4.status, 'done');
  const notices = tables.builder_vibe_messages.filter(row => row.role === 'system');
  assert.equal(notices.length, 3);
  assert.match(notices.find(row => row.session_id === 's1').content, /queued again/);
  assert.match(notices.find(row => row.session_id === 's3').content, /not repeated automatically/);
  assert.deepEqual(tables.builder_vibe_sessions.map(row => row.status), ['open', 'shipped', 'open', 'open']);
});

test('a Builder chat answer interrupted by a restart is queued again once and the thread reopened', async () => {
  const tables = {
    builder_chat_messages: [
      { id: 'c1', thread_id: 't1', role: 'owner', status: 'claimed', payload: {} },
      { id: 'c2', thread_id: 't2', role: 'owner', status: 'claimed', payload: { restart_retries: 1 } },
    ],
    builder_chat_threads: [{ id: 't1', status: 'working' }, { id: 't2', status: 'working' }, { id: 't3', status: 'closed' }],
  };
  const outcome = await createBuilderChatStore(memorySupabase(tables)).recoverInterruptedTurns();
  assert.deepEqual(outcome, { requeued: 1, failed: 1, threads: 2 });
  assert.equal(tables.builder_chat_messages[0].status, 'queued');
  assert.equal(tables.builder_chat_messages[1].status, 'failed');
  assert.deepEqual(tables.builder_chat_threads.map(row => row.status), ['open', 'open', 'closed']);
  assert.equal(tables.builder_chat_messages.filter(row => row.role === 'system').length, 2);
});
