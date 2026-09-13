const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const trigger = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913146000_capture_effective_rule_snapshot_on_observation.sql'), 'utf8');

test('observation writes capture the effective rule snapshot at event time', () => {
  assert.match(trigger, /capture_observation_effective_rule_snapshot/);
  assert.match(trigger, /AFTER INSERT OR UPDATE OF geofence_context/);
  assert.match(trigger, /INSERT INTO public\.effective_rule_snapshots/);
  assert.match(trigger, /source_event_table[\s\S]*observations/);
  assert.match(trigger, /resolution_status/);
});
