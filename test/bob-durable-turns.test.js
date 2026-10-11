const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261011035917_bob_durable_turn_runs.sql'),
  'utf8',
);
const conductor = fs.readFileSync(
  path.join(root, 'supabase/functions/onspace-ai-chat/index.ts'),
  'utf8',
);
const panel = fs.readFileSync(
  path.join(root, 'apps/web/src/components/BobPanel.tsx'),
  'utf8',
);

test('Bob turn runs are private, tenant-scoped and uniquely claim a client request', () => {
  assert.match(migration, /create table public\.bob_turn_runs/i);
  assert.match(migration, /unique \(conversation_id, user_id, request_id\)/i);
  assert.match(migration, /alter table public\.bob_turn_runs enable row level security/i);
  assert.match(migration, /to authenticated[\s\S]*auth\.uid\(\)[\s\S]*user_id[\s\S]*org_access_allowed\(organization_id\)/i);
  assert.match(migration, /revoke all on table public\.bob_turn_runs from public, anon, authenticated/i);
  assert.match(migration, /grant select on table public\.bob_turn_runs to authenticated/i);
  assert.doesNotMatch(migration, /grant (insert|update|delete).*authenticated/i);
});

test('Bob conductor rejects cross-user conversations and deduplicates durable turns', () => {
  assert.match(conductor, /existingConversation\.organization_id !== orgId/);
  assert.match(conductor, /existingConversation\.user_id !== user\.id/);
  assert.match(conductor, /insertRunError\?\.code === '23505'/);
  assert.match(conductor, /priorRun\.request_fingerprint !== requestFingerprint/);
  assert.match(conductor, /response_payload[\s\S]*replayed: true/);
  assert.match(conductor, /operation === 'status' \|\| operation === 'cancel'/);
});

test('Bob cancellation is cooperative and checked before planning, tools and loop steps', () => {
  assert.match(conductor, /cancelAtBoundary\('planning'\)/);
  assert.match(conductor, /cancelAtBoundary\('tool execution'\)/);
  assert.match(conductor, /cancelAtBoundary\(`reasoning step \$\{stepCount \+ 1\}`\)/);
  assert.match(conductor, /status: 'cancel_requested'/);
  assert.match(conductor, /respond\(structured, 200, 'cancelled'\)/);
});

test('Bob panel sends a stable request id and offers reconciliation instead of blind retry', () => {
  assert.match(panel, /const requestId = crypto\.randomUUID\(\)/);
  assert.match(panel, /request_id: requestId/);
  assert.match(panel, /operation: 'status'/);
  assert.match(panel, /operation: 'cancel'/);
  assert.match(panel, /Check status/);
  assert.match(panel, /Request cancellation/);
  assert.match(panel, /durable run prevents duplicate work/);
});
