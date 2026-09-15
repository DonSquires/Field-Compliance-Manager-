const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Tier 4 checkpoints on the geofence engine: Q3 direct save that still lands unverified,
// P2 reset on any geometry change (structural trigger), Q4 versioning, Q8 org radius,
// P1 server-measured presence on visits.

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260915100000_checkpoint_tier_workbench.sql'), 'utf8');
const oracle = fs.readFileSync(path.join(root, 'supabase/tests/20260914004000_geofence_workbench_rls.sql'), 'utf8');
const scanner = fs.readFileSync(path.join(root, 'apps/mobile/src/components/OfficerCheckpointScanner.tsx'), 'utf8');

const manageSig = 'manage_patrol_checkpoint(uuid, text, uuid, uuid, uuid, text, text, double precision, double precision, integer, text)';
const visitSig = 'record_officer_checkpoint_visit(uuid, uuid, uuid, double precision, double precision, double precision, double precision, boolean)';
const esc = (s) => s.replace(/[()]/g, '\\$&');

test('the structural P2 guard forces every placement to land unverified and resets on any geometry change', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.patrol_checkpoints_geometry_guard\(\)\s+RETURNS trigger/);
  assert.match(migration, /CREATE TRIGGER trg_patrol_checkpoints_geometry_guard\s+BEFORE INSERT OR UPDATE ON public\.patrol_checkpoints/);
  assert.match(migration, /IF TG_OP = 'INSERT'\s+OR \(NEW\.gps_lat, NEW\.gps_lng, NEW\.radius_meters\) IS DISTINCT FROM \(OLD\.gps_lat, OLD\.gps_lng, OLD\.radius_meters\) THEN\s+NEW\.checkpoint_verification := 'unverified';\s+NEW\.checkpoint_verified_by := NULL;\s+NEW\.checkpoint_verified_at := NULL;/);
  assert.match(migration, /Checkpoint radius must be between 1 and 500 metres/);
  assert.match(migration, /Checkpoint position needs both latitude and longitude/);
  assert.doesNotMatch(migration, /CREATE POLICY|DROP POLICY|DROP TABLE|DROP COLUMN|DROP FUNCTION/);
});

test('the direct-save command is governed: admin of the org, site within reach, position required, org radius rule, versioned and audited', () => {
  assert.match(migration, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
  assert.match(migration, /IF p_organization_id IS NULL OR NOT public\.is_admin_for_org\(p_organization_id\) THEN RAISE EXCEPTION 'Organisation administrator required'/);
  assert.match(migration, /IF p_client_site_id IS NULL THEN RAISE EXCEPTION 'A checkpoint must be placed at a site'/);
  assert.match(migration, /IF NOT FOUND OR NOT public\.org_access_allowed\(v_site\.client_organization_id\) THEN RAISE EXCEPTION 'Site is outside your reach'/);
  assert.match(migration, /IF p_gps_lat IS NULL OR p_gps_lng IS NULL THEN RAISE EXCEPTION 'A map position is required to place a checkpoint'/);
  assert.match(migration, /c\.config_key = 'checkpoint_radius_m' AND c\.zone_type IS NULL/);
  assert.match(migration, /v_default_radius := COALESCE\(v_default_radius, 5\)/);
  assert.match(migration, /c\.organization_id = p_organization_id AND c\.client_request_id = p_client_request_id/, 'idempotent create by client_request_id');
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_patrol_checkpoints_org_client_request/);
  assert.match(migration, /v_version := public\._gbh_next_version\('patrol_checkpoint', v_cp\.id\);/);
  assert.match(migration, /ST_Buffer\(ST_SetSRID\(ST_MakePoint\(v_cp\.gps_lng, v_cp\.gps_lat\), 4326\)::geography, v_cp\.radius_meters\)::geometry,\s+'manual_point_radius', 'unverified', v_actor, 'direct_edit'/);
  assert.match(migration, /'patrol_checkpoint_' \|\| CASE WHEN v_action = 'create' THEN 'created'/);
  assert.doesNotMatch(migration, /SET checkpoint_verification = 'verified'/, 'only verify_boundary may certify a checkpoint');
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(manageSig)} FROM PUBLIC, anon;`));
  assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(manageSig)} TO authenticated, service_role;`));
});

test('checkpoint visits measure presence on the server and record the verification state (P1/P2), keeping the mobile contract', () => {
  assert.match(migration, /ALTER TABLE public\.patrol_checkpoint_visits ADD COLUMN IF NOT EXISTS checkpoint_verification_at_visit text;/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.record_officer_checkpoint_visit\(\s+p_client_request_id uuid, p_shift_id uuid, p_checkpoint_id uuid, p_gps_lat double precision, p_gps_lng double precision,\s+p_gps_accuracy double precision DEFAULT NULL, p_gps_distance_from_checkpoint double precision DEFAULT NULL, p_within_radius boolean DEFAULT NULL\s+\) RETURNS TABLE\(visit_id uuid, patrol_id uuid, visited_at timestamp with time zone, created boolean\)/);
  assert.match(migration, /v_distance := round\(ST_Distance\(ST_SetSRID\(ST_MakePoint\(v_checkpoint\.gps_lng, v_checkpoint\.gps_lat\), 4326\)::geography,\s+ST_SetSRID\(ST_MakePoint\(p_gps_lng, p_gps_lat\), 4326\)::geography\)::numeric, 1\);\s+v_within := v_distance <= v_checkpoint\.radius_meters;/);
  // The client's claim is audited, never stored as the record.
  const insert = migration.slice(migration.indexOf('INSERT INTO public.patrol_checkpoint_visits('), migration.indexOf('RETURNING * INTO v_visit'));
  assert.match(insert, /p_gps_accuracy, v_distance, v_within, 'qr_camera'/);
  assert.doesNotMatch(insert, /p_gps_distance_from_checkpoint|p_within_radius/);
  assert.match(migration, /'client_claimed_within_radius', p_within_radius/);
  assert.match(migration, /v_checkpoint\.checkpoint_verification\s*\) RETURNING \* INTO v_visit/);
  assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(visitSig)} FROM PUBLIC, anon;`));
  // Mobile still sends what it always sent; nothing there needs to change for the server to be the record.
  assert.match(scanner, /p_gps_distance_from_checkpoint: distance/);
  assert.match(scanner, /p_within_radius: distance === null \? null : true/);
});

test('the disposable-database truth table exercises every Tier 4 rule', () => {
  for (const label of [
    'a checkpoint is placed at a site with the platform default radius, unverified',
    'placement is versioned as a point-radius geometry and audited',
    'replaying the same client_request_id returns the same checkpoint',
    'the radius follows the organisation rule when one is set (Q8)',
    'moving a verified checkpoint resets it to unverified and writes a new version',
    'a rename keeps the verification and adds no version',
    'a direct table edit of the geometry also resets verification (structural P2)',
    'a zero radius is refused at the table',
    'nothing lands verified, whatever the writer claims',
    'a stranger cannot place checkpoints for another org',
    "a checkpoint cannot be placed at a site outside the caller''s reach",
    'a checkpoint needs a map position',
    'a visit 3 m from the point is within the 6 m radius, distance measured by the server, unverified state recorded',
    'a client claiming within_radius from 40 m away is recorded as outside',
    'a checkpoint with no point yields no distance and no verdict, never a guess',
    'a visit at a verified checkpoint carries the verified state',
  ]) {
    assert.ok(oracle.includes(label), `oracle must carry check: ${label}`);
  }
});
