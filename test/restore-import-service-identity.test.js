const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sql = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20261104140000_restore_import_service_identity.sql'), 'utf8');

test('only sign-in-less configured import actors deactivated by the access-set sweep are restored', () => {
  assert.match(sql, /FROM public\.import_source_profiles p\s+WHERE p\.import_actor_id = u\.id AND p\.active/);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM auth\.users au WHERE au\.id = u\.id\)/);
  assert.match(sql, /a\.metadata ->> 'migration_version' = '20261102140000'/);
  assert.match(sql, /'user_reactivated',\s+'user_profiles'/);
  assert.doesNotMatch(sql, /auth\.users\s+SET|banned_until|grant |create (or replace )?function/i);
});
