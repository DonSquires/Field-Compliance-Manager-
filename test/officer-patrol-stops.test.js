const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260918110000_officer_patrol_stops.sql'), 'utf8').replace(/\r\n/g, '\n');

test('officers read only their own contracted, non-adhoc, non-static stops', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.get_officer_patrol_stops\(p_shift_id uuid DEFAULT NULL\)/);
  assert.match(migration, /where id = p_shift_id and officer_user_id = v_actor/);
  assert.match(migration, /where st\.shift_id = v_shift\.id and st\.is_adhoc = false and st\.module_key <> 'static_guarding'/);
  assert.match(migration, /'officer_instructions', st\.officer_instructions/);
  assert.match(migration, /'access_instructions', cs\.access_instructions, 'hs_notes', cs\.hs_notes/);
});

test('attendance is recorded only by the assigned officer on an in-progress shift with a race check and replay receipt', () => {
  assert.match(migration, /if not found or v_shift\.officer_user_id <> v_actor then raise exception 'This stop is not on your shift'/);
  assert.match(migration, /if v_shift\.status <> 'in_progress' then raise exception/);
  assert.match(migration, /if v_stop\.is_adhoc or v_stop\.dispatch_job_id is not null then raise exception 'Dispatch stops are recorded from the Dispatch page'/);
  assert.match(migration, /if v_stop\.module_key = 'static_guarding' then raise exception/);
  assert.match(migration, /where a\.organization_id = v_shift\.organization_id and a\.client_request_id = p_request_id;\n\s+if found then return v_receipt; end if;/);
  assert.match(migration, /if v_stop\.status <> p_expected_status then/);
});

test('arrival verification is loud but never blocking; late arrival and short dwell need words, not permission', () => {
  for (const state of ['no_gps', 'no_geofence', 'unverified_boundary', 'verified_on_site', 'near_site', 'off_site']) {
    assert.match(migration, new RegExp(`v_verification := '${state}'`));
  }
  assert.doesNotMatch(migration, /raise exception 'Current position is outside/);
  assert.match(migration, /sla_status = case when v_at > sla_arrive_by then 'breached' else 'on_track' end/);
  assert.match(migration, /You arrived after the contracted window\. Give a short reason for the delay before leaving/);
  assert.match(migration, /You are leaving before the contracted % minutes on site\. Say why in the notes/);
  assert.match(migration, /update public\.shifts set completed_stops = completed_stops \+ 1 where id = v_shift\.id/);
});

test('every action leaves a receipt, an action row, and an audit row, and the legacy unguarded writer is not used', () => {
  assert.match(migration, /'reference', 'PS-' \|\| upper\(left\(replace\(v_action_id::text, '-', ''\), 8\)\)/);
  assert.match(migration, /insert into public\.shift_stop_actions\(id, organization_id, shift_stop_id, shift_id, action_type, outcome, notes, gps_lat, gps_lng, performed_at, client_request_id, gps_accuracy_metres, evidence_metadata, receipt\)/);
  assert.match(migration, /case when p_action = 'arrive' then 'patrol_stop_arrived' else 'patrol_stop_departed' end, 'shift_stops', v_stop\.id, v_receipt/);
  assert.doesNotMatch(migration, /complete_shift_stop\(/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.manage_officer_patrol_stop\(uuid, text, text, uuid, text, double precision, double precision, double precision, text\) FROM PUBLIC, anon;/);
});
