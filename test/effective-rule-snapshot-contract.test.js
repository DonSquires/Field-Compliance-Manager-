const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const snapshot = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913145000_effective_rule_snapshot_contract.sql'), 'utf8');

test('effective rule snapshots capture place + jurisdiction + module policy at event time', () => {
  assert.match(snapshot, /effective_rule_snapshots/);
  assert.match(snapshot, /governing_jurisdiction_id/);
  assert.match(snapshot, /matched_zone_id/);
  assert.match(snapshot, /matched_site_id/);
  assert.match(snapshot, /jurisdiction_rule_set_id/);
  assert.match(snapshot, /effective_rules/);
  assert.match(snapshot, /capture_effective_rule_snapshot/);
  assert.match(snapshot, /source_event_table/);
});
