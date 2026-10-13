const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = (relativePath) => fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
const notify = read('supabase/functions/bob-chat-bell-notify/index.ts');
const conductor = read('supabase/functions/onspace-ai-chat/index.ts');
const navigation = read('apps/web/src/lib/notificationNavigation.ts');
const schema = read('supabase/schema.sql');

test('Bob completion notifications are personal, tenant-scoped, navigable, and replay-safe', () => {
  assert.match(notify, /event === 'conversation_complete'/);
  assert.match(notify, /p_organization_id: orgId/);
  assert.match(notify, /p_recipient_user_id: recipientUserId/);
  assert.match(notify, /p_recipient_role: null/);
  assert.match(notify, /p_category: 'bob_conversation'/);
  assert.match(notify, /p_link_payload:\s*\{\s*conversation_id: conversationId,\s*request_id: requestId/s);
  assert.match(notify, /p_dedup_key: `bob_conversation:\${conversationId}:\${requestId}`/);
  assert.match(schema, /'bob_conversation'::"?text"?/);
  assert.match(navigation, /notification\.category === 'bob_conversation' \|\| link === 'bob_chat'/);
});

test('the conductor emits one completion notification and persists its delivery receipt', () => {
  assert.match(conductor, /ATLAS CALLS: bob-chat-bell-notify/);
  assert.match(conductor, /callFn\(\s*'bob-chat-bell-notify'/);
  assert.match(conductor, /request_id: turnNotificationContext\.requestId\s*\}\s*,\s*5_000/s);
  assert.match(conductor, /terminalStatus === 'completed' && turnNotificationContext/);
  assert.match(conductor, /notification_delivery: delivery/);
  assert.match(conductor, /response_payload: responseBody/);
  assert.match(conductor, /requestId: claimedRun!\.request_id/);
});

test('cancelled and failed Bob turns do not emit completion notifications', () => {
  assert.match(conductor, /terminalStatus === 'completed' && turnNotificationContext/);
  assert.doesNotMatch(notify, /p_body: summary[\s\S]*p_category: 'bob_conversation'/);
});
