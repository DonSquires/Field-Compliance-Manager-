const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901023000_bob_conversation_agent_modes.sql'), 'utf8');
const panel = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/BobPanel.tsx'), 'utf8');

test('Bob operations and Builder use separate durable conversation modes', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS module_key text/);
  assert.match(migration, /SET module_key = 'operations'/);
  assert.match(migration, /ALTER COLUMN module_key SET DEFAULT 'operations'/);
  assert.match(migration, /ALTER COLUMN module_key SET NOT NULL/);
  assert.match(migration, /module_key IN \('operations', 'builder'\)/);
  assert.match(migration, /bob_conversations_user_org_mode_updated_idx/);
  assert.match(panel, /\.eq\('module_key', mode\)/);
  assert.match(panel, /module_key: mode/);
});
