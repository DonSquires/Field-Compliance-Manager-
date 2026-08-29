const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.resolve(__dirname, '../supabase/migrations/20260828020000_bob_task_continuity.sql');

test('task continuity foundation defines durable task ledger and step state', () => {
  assert.ok(fs.existsSync(migrationPath), 'task continuity migration should exist');

  const migration = fs.readFileSync(migrationPath, 'utf8');

  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.bob_task_runs/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.bob_task_steps/i);
  assert.match(migration, /conversation_id/i);
  assert.match(migration, /current_step_index/i);
  assert.match(migration, /total_steps/i);
  assert.match(migration, /task_id/i);
  assert.match(migration, /step_id/i);
  assert.match(migration, /status/i);
  assert.match(migration, /evidence_refs/i);
  assert.match(migration, /CREATE POLICY .*bob_task_runs/i);
  assert.match(migration, /CREATE POLICY .*bob_task_steps/i);
});
