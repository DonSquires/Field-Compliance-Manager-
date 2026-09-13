const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../supabase/functions/send-capability-share-invite/index.ts'), 'utf8');

test('send-capability-share-invite creates the invite as the caller, not as service-role', () => {
  assert.match(source, /callerClient\.rpc\('invite_client_capability_share'/);
  assert.doesNotMatch(source, /admin\.rpc\('invite_client_capability_share'/);
});

test('send-capability-share-invite degrades gracefully without SMTP instead of losing the invite', () => {
  assert.match(source, /if \(!SMTP_HOST \|\| !SMTP_USER \|\| !SMTP_PASS\)/);
  assert.match(source, /email_sent: false, email_error: 'SMTP not configured/);
  assert.match(source, /accept_url/);
});
