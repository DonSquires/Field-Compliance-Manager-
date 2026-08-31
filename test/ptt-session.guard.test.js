const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.resolve(__dirname, '../supabase/functions/ptt-session/index.ts'), 'utf8');

test('PTT session issuer authenticates callers and binds the signed token to a channel permitted by RLS', () => {
  assert.match(source, /client\.auth\.getUser\(\)/);
  assert.match(source, /from\('ptt_channels'\)/);
  assert.match(source, /\.eq\('id', channelId\)/);
  assert.match(source, /organizationId: channel\.organization_id/);
  assert.match(source, /channelId: channel\.id/);
  assert.match(source, /exp: expiresAt/);
  assert.match(source, /Deno\.env\.get\('PTT_SECRET'\)/);
  assert.match(source, /Deno\.env\.get\('PTT_SIGNALLING_URL'\)/);
  assert.match(source, /Deno\.env\.get\('PTT_SERVER_URL'\)/);
  assert.match(source, /function websocketUrl/);
  assert.match(source, /PTT_TURN_SHARED_SECRET/);
  assert.match(source, /turnCredential/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
});