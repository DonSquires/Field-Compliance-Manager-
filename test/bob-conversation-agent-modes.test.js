const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260901023000_bob_conversation_agent_modes.sql'), 'utf8');
const panel = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/components/BobPanel.tsx'), 'utf8');

test('Bob operations and Builder use separate durable conversation modes', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS agent_mode text NOT NULL DEFAULT 'operations'/);
  assert.match(migration, /agent_mode IN \('operations', 'builder'\)/);
  assert.match(migration, /bob_conversations_user_org_mode_updated_idx/);
  assert.match(panel, /\.eq\('agent_mode', mode\)/);
  assert.match(panel, /agent_mode: mode/);
});