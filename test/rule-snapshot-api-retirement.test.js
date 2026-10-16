const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const retirement = fs.readFileSync(
  path.join(root, 'supabase/migrations/20261016112029_retire_unused_rule_snapshot_rpc.sql'),
  'utf8',
);
const observationCapture = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260913146000_capture_effective_rule_snapshot_on_observation.sql'),
  'utf8',
);
const liveSchema = fs.readFileSync(
  path.join(root, 'supabase/schema.sql'),
  'utf8',
);
const databaseTypes = fs.readFileSync(
  path.join(root, 'src/types/database.ts'),
  'utf8',
);

test('the unused generic rule-snapshot mutation API is retired', () => {
  assert.match(
    retirement,
    /DROP FUNCTION IF EXISTS public\.capture_effective_rule_snapshot\(\s*uuid,\s*text,\s*uuid,\s*text,\s*uuid,\s*uuid,\s*uuid,\s*uuid,\s*text,\s*uuid,\s*jsonb,\s*text,\s*text,\s*uuid,\s*timestamptz\s*\)/,
  );
  assert.doesNotMatch(
    liveSchema,
    /CREATE OR REPLACE FUNCTION "public"\."capture_effective_rule_snapshot"/,
  );
  assert.doesNotMatch(databaseTypes, /^\s+capture_effective_rule_snapshot:/m);
});

test('observation capture remains the governed rule-snapshot write path', () => {
  assert.match(observationCapture, /capture_observation_effective_rule_snapshot/);
  assert.match(observationCapture, /INSERT INTO public\.effective_rule_snapshots/);
  assert.match(observationCapture, /source_event_table[\s\S]*observations/);
});
