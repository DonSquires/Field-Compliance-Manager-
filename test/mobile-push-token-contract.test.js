const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const test = require('node:test');

const source = readFileSync(resolve(__dirname, '../apps/mobile/src/lib/officerNotifications.ts'), 'utf8');
const migration = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260903130000_officer_device_tokens_push_spine.sql'),
  'utf8'
);

test('mobile notifications use governed register_officer_device_token RPC', () => {
  assert.match(source, /rpc\('register_officer_device_token'/);
  assert.match(source, /p_push_token: token/);
  assert.match(source, /p_platform: platform/);
  assert.match(source, /Device token registration was not confirmed/);
});

test('mobile notifications support token unregistration on sign-out', () => {
  assert.match(source, /rpc\('unregister_officer_device_token'/);
  assert.match(source, /AsyncStorage\.removeItem/);
});

test('migration defines officer_device_tokens with RLS and platform validation', () => {
  assert.match(migration, /create table if not exists public\.officer_device_tokens/);
  assert.match(migration, /officer_device_tokens_platform_check/);
  assert.match(migration, /create policy odt_select/);
  assert.match(migration, /revoke insert, update, delete on table public\.officer_device_tokens/);
});
