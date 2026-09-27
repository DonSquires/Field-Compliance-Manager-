const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const chat = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const caddie = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const handler = chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':", chat.indexOf("case 'cancel_builder_job':")));

test('cancel tool is catalogued and owner-gated as a write', () => {
  assert.match(caddie, /cancel_builder_job: \{/);
  assert.match(chat, /t\.tool === 'cancel_builder_job' && caps\.tier === 'admiral'/);
  assert.match(chat, /'create_builder_job',\s*'cancel_builder_job'/);
});

test('confirmation requires the previous assistant preview and the same requester, job and reason', () => {
  assert.match(handler, /last\?\.role === 'assistant'/);
  assert.match(handler, /last\.metadata\?\.outcome === 'proposed'/);
  assert.match(handler, /stored\.requester_id === user\.id/);
  assert.match(handler, /suppliedId === pendingCancel\.job_id/);
  assert.match(handler, /suppliedReason === pendingCancel\.reason/);
  assert.match(handler, /affirmative && pendingCancel/);
  assert.match(handler, /affirmative && !pendingCancel/);
  assert.match(handler, /outcome: 'proposed'|meta\('proposed'/);
  assert.match(handler, /'declined'/);
  assert.ok(handler.indexOf("callerClient.rpc('builder_cancel_job'") < handler.indexOf('jobsQuery'));
});

test('lookup is requester-scoped, exact, limited to detect ambiguity, and previews without RPC', () => {
  assert.match(handler, /callerClient\.from\('builder_jobs'\)\.select\('id,title,status'\)\.limit\(2\)/);
  assert.match(handler, /jobsQuery\.eq\('id', suppliedId\)/);
  assert.match(handler, /jobsQuery\.eq\('title', suppliedTitle\)/);
  assert.match(handler, /jobs\.length !== 1/);
  assert.match(handler, /'ambiguous'/);
  assert.match(handler, /'not_found'/);
  assert.match(handler, /pending_builder_cancel: \{ job_id: job\.id, title: job\.title \?\? '', reason: suppliedReason, requester_id: user\.id \}/);
});

test('confirmed cancellation calls the RPC as the requester and checks outcomes', () => {
  assert.match(handler, /callerClient\.rpc\('builder_cancel_job', \{\s*_job_id: pendingCancel\.job_id, _reason: pendingCancel\.reason/);
  assert.match(handler, /data\.id === pendingCancel\.job_id && data\.status === 'cancelled'/);
  assert.match(handler, /'already_finished'/);
  assert.match(handler, /'not_found'/);
  assert.match(handler, /'failed'/);
});
