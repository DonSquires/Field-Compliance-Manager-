const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const controlRoom = fs.readFileSync(
  path.resolve(__dirname, '../supabase/functions/bob-builder-control-room/index.ts'),
  'utf8',
);

test('control room projects model heartbeat timestamps and in-progress turn counters without raw output', () => {
  assert.match(controlRoom, /created_at: run\.created_at, updated_at: run\.updated_at/);
  assert.match(controlRoom, /started_at, completed_at, created_at, updated_at'\)/);
  assert.match(controlRoom, /turns: count\(usage\.turns\) \?\? count\(usage\.turn\)/);
});

test('autonomous Builder admission reuses an active owner request after research enrichment', () => {
  assert.match(controlRoom, /if \(body\.autopilot === true\) \{/);
  assert.match(controlRoom, /\.eq\('autopilot_requested_by', user\.id\)/);
  assert.match(controlRoom, /\.in\('autopilot_state', \['driving', 'awaiting_human'\]\)/);
  assert.match(controlRoom, /\.eq\('title', title\)/);
  assert.match(controlRoom, /\.not\('status', 'in', '\("release_ready","deployed","failed","cancelled"\)'\)/);
});

test('manual Builder admission retains exact-brief bounded deduplication', () => {
  assert.match(controlRoom, /duplicateQuery = duplicateQuery\.eq\('task_description', taskDescription\)\.gte\('created_at', duplicateSince\)/);
});

test('run relay preserves accepted and already-running preflight receipts', () => {
  assert.match(controlRoom, /accepted: result\.payload\.accepted/);
  assert.match(controlRoom, /already_running: result\.payload\.already_running/);
  assert.match(controlRoom, /started_at: result\.payload\.started_at/);
  assert.match(controlRoom, /}, result\.status\)/);
});

test('jobs created or continued from the control room are driven by Bob, and an undriven job can be handed to him (incident 2026-10-16: #84/#85 sat at intake)', () => {
  const page = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/BuilderControlRoomPage.tsx'), 'utf8');
  assert.match(page, /autopilot: true,\n  \}\);/, 'New Job defaults to Bob driving');
  assert.match(page, /autopilot: form\.autopilot,/);
  assert.match(page, /action: 'create_followup'[^\n]*autopilot: true/);
  assert.match(page, /invoke\(\{ action: 'drive', job_id: selectedId \}\)/);
  assert.match(page, /Let Bob drive/);
  assert.match(controlRoom, /if \(action === 'drive'\) \{/);
  assert.match(controlRoom, /admin\.rpc\('builder_autopilot_bind', \{ _job_id: jobId, _requested_by: user\.id/);
  // The drive action sits after the per-job organisation access check, so it cannot bind a foreign job.
  assert.ok(controlRoom.indexOf("if (action === 'drive')") > controlRoom.indexOf("if (!job || !canAccessOrganization(job.organization_id))"));
  assert.match(controlRoom, /autopilot_requested_by, autopilot_state, created_at, updated_at'\)/, 'the queue list carries autopilot ownership');
});
