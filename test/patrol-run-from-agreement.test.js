const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260918100000_patrol_run_from_agreement.sql'), 'utf8');

test('a patrol run is built only from an accepted operational agreement by a provider admin', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.create_patrol_route_from_agreement\(/);
  assert.match(migration, /v_agreement\.agreement_type <> 'operational' or v_agreement\.invitation_status <> 'accepted'/);
  assert.match(migration, /public\.is_admin_for_org\(v_agreement\.provider_organization_id\)/);
  assert.match(migration, /if v_actor is null then raise exception 'Authentication required'/);
});

test('the run attaches the contract-derived patrol configs so generate_shift_stops can see them', () => {
  assert.match(migration, /join public\.service_agreement_delivery_schedules sads on sads\.proposal_scope_schedule_id = cspc\.proposal_scope_schedule_id/);
  assert.match(migration, /set patrol_route_id = v_route\.id, updated_at = now\(\)/);
  assert.match(migration, /insert into public\.patrol_routes\(organization_id, name, description, route_type, assignment_type, checkpoint_mode, default_start_time, default_end_time, is_active\)/);
  assert.match(migration, /'mobile', 'client_patrol', 'none'/);
  assert.match(migration, /This agreement has no scheduled patrol places yet/);
});

test('contract inheritance and access doctrine are preserved for every attached place', () => {
  assert.match(migration, /insert into public\.patrol_route_sites\(patrol_route_id, site_id, expected_visits_per_shift, preferred_stop_order, dwell_minutes, sla_arrive_within_minutes, required_module, preferred_time_window, notes\)/);
  assert.match(migration, /insert into public\.patrol_route_stop_modules\(organization_id, patrol_config_id, module_key, is_required, display_order, service_agreement_module_id, service_agreement_location_id\)/);
  assert.match(migration, /array\['patrol', 'general_patrol'\]/);
  assert.match(migration, /exception when unique_violation then/);
});

test('the run is idempotent and audited', () => {
  assert.match(migration, /action = 'patrol_route_created_from_agreement' and metadata->>'client_request_id' = p_client_request_id::text/);
  assert.match(migration, /'patrol_route_created_from_agreement', 'patrol_routes', v_route\.id/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_patrol_route_from_agreement\(uuid, uuid, text\) FROM PUBLIC, anon;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_patrol_route_from_agreement\(uuid, uuid, text\) TO authenticated, service_role;/);
});
