'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const chat = fs.readFileSync('supabase/functions/onspace-ai-chat/index.ts', 'utf8');
const caddie = fs.readFileSync('supabase/functions/onspace-ai-chat/caddie.ts', 'utf8');
const planner = require('../services/fcm-api/src/bob/planPrompt.js');
const prompt = fs.readFileSync('services/fcm-api/src/bob/planPrompt.js', 'utf8');
test('Builder cancellation is catalogued, admiral gated, and resolved through caller-token control room list', () => {
  assert.match(caddie, /cancel_builder_job: \{/);
  assert.match(chat, /t\.tool === 'cancel_builder_job' && caps\.tier === 'admiral'/);
  assert.match(chat, /case 'cancel_builder_job':/);
  assert.match(chat, /callFn\('bob-builder-control-room', authHeader, \{ action: 'list' \}\)/);
  assert.doesNotMatch(chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':")), /\.from\('builder_jobs'\)/);
});
test('pending marker, history loading, planner RESUME, and deterministic yes use stored identity', () => {
  assert.match(chat, /pending_builder_cancellation: \{ job_id: job\.id, title: job\.title, reason, user_id: user\.id, conversation_id: conversationId \}/);
  assert.match(chat, /kind: 'builder_cancellation_pending', builder_cancellation: proposal/);
  assert.match(prompt, /RESUME — BUILDER CANCELLATION AWAITING CONFIRMATION/);
  assert.match(chat, /pending\.builder_cancellation\?\.user_id === user\.id && pending\.builder_cancellation\?\.conversation_id === conversationId/);
  assert.match(chat, /decision = \{ action: 'use_tool', tool: 'cancel_builder_job', args: \{\} \}/);
  assert.equal(typeof planner.buildPlannerMessages, 'function');
  const continuation = chat.indexOf("if (pending?.kind === 'builder_cancellation_pending') {\n      // Consume");
  assert.ok(continuation > 0 && continuation < chat.indexOf('    const plan = await callPlan(planPayload);'));
  const seam = chat.slice(continuation, chat.indexOf('    const plan = await callPlan(planPayload);'));
  assert.match(seam, /await dispatchTool\('cancel_builder_job', \{\}/);
  assert.match(seam, /await persist\(admin, orgId, conversationId/);
  assert.match(chat, /i !== rows.length - 1 \|\| md.outcome !== 'proposed'/);
});
test('the confirmed path rechecks target and uses only the caller-scoped RPC', () => {
  const branch = chat.slice(chat.indexOf("case 'cancel_builder_job':"), chat.indexOf("case 'laptop_shell':"));
  assert.match(branch, /job\.title !== stored\.title/);
  assert.match(branch, /callerClient\.rpc\('builder_cancel_job', \{ _job_id: jobId, _reason: reason \}\)/);
  assert.match(branch, /cancelled\.id !== jobId \|\| cancelled\.status !== 'cancelled'/);
  assert.match(branch, /toolMeta\('declined'\)/);
  assert.match(branch, /toolMeta\('ambiguous'\)/);
  assert.match(branch, /toolMeta\('not_found'\)/);
});
