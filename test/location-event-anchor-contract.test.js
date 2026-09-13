const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913136000_validate_location_event_checkpoint_anchor.sql'), 'utf8');
const projection = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913135000_house_event_anchor_projection.sql'), 'utf8');
const contextContract = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913137000_event_context_snapshot_contract.sql'), 'utf8');
const contextHardening = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913137100_harden_event_context_snapshot_rpc.sql'), 'utf8');
const governedWriter = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913139000_create_governed_location_event.sql'), 'utf8');
const observationWriter = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260913140000_observation_event_context_dual_write.sql'), 'utf8');

test('location event writes enforce checkpoint parent consistency and Site XOR Zone', () => {
  assert.match(migration, /NEW\.client_site_id IS NOT NULL AND NEW\.zone_id IS NOT NULL/);
  assert.match(migration, /patrol_checkpoints_one_anchor_chk|v_checkpoint/);
  assert.match(migration, /Checkpoint belongs to a different Site/);
  assert.match(migration, /Checkpoint belongs to a different Zone/);
  assert.match(migration, /Checkpoint and event organization do not match/);
  assert.match(migration, /trg_validate_location_event_checkpoint_anchor/);
});

test('House event projection exposes explicit unresolved reasons', () => {
  assert.match(projection, /anchor_kind/);
  assert.match(projection, /no_checkpoint_site_or_zone/);
  assert.match(projection, /facet_has_no_house_link/);
  assert.match(projection, /security_invoker/);
});

test('future event context snapshots separate place anchors from immutable authority context', () => {
  for (const source of [contextContract, contextHardening]) {
    assert.match(source, /location_id/);
    assert.match(source, /client_site_id/);
    assert.match(source, /zone_id/);
    assert.match(source, /module_key/);
    assert.match(source, /service_agreement_id/);
    assert.match(source, /authority_snapshot/);
    assert.match(source, /org_access_allowed/);
  }
  assert.match(contextContract, /event_context_snapshots_source_key/);
  assert.match(contextContract, /DO NOTHING/);
});

test('future event writers use the canonical event plus context transaction', () => {
  assert.match(governedWriter, /create_location_event/);
  assert.match(governedWriter, /INSERT INTO public\.location_events/);
  assert.match(governedWriter, /create_event_context_snapshot/);
  assert.match(governedWriter, /Location event organization access denied/);
});

test('observations dual-write canonically in one database transaction', () => {
  assert.match(observationWriter, /AFTER INSERT ON public\.observations/);
  assert.match(observationWriter, /INSERT INTO public\.location_events/);
  assert.match(observationWriter, /INSERT INTO public\.event_context_snapshots/);
  assert.match(observationWriter, /no_site_or_zone/);
  assert.match(observationWriter, /DO NOTHING/);
});
