const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/components/NotificationInbox.tsx'), 'utf8');

test('mobile inbox uses the canonical notification centre and realtime refresh', () => {
  assert.match(source, /from\('notifications'\)\.select/);
  assert.match(source, /table: 'notifications'/);
  assert.match(source, /organization_id=eq/);
});

test('mobile inbox confirms read status through the RLS-permitted update path', () => {
  assert.match(source, /from\('notifications'\)\.update\(\{ read_at: readAt \}\)/);
  assert.match(source, /is\('read_at', null\)/);
  assert.match(source, /Notification not updated/);
});