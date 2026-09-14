const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const engine = fs.readFileSync(path.join(root, 'supabase/migrations/20260914004000_geofence_workbench_boundary_proposals.sql'), 'utf8');
const hardening = fs.readFileSync(path.join(root, 'supabase/migrations/20260914140000_geofence_verify_hardening.sql'), 'utf8');
const oracle = fs.readFileSync(path.join(root, 'supabase/tests/20260914004000_geofence_workbench_rls.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');

test('the engine stages every source as a proposal and only accept writes the live entity (P2)', () => {
  assert.match(engine, /CREATE TABLE IF NOT EXISTS public\.boundary_proposals/);
  assert.match(engine, /source IN \('linz_parcel','linz_building','council_gis','nzta','google_point_radius','user_drawn','bob','imported_geojson'\)/);
  assert.match(engine, /ALTER TABLE public\.boundary_proposals ENABLE ROW LEVEL SECURITY/);
  assert.match(engine, /REVOKE INSERT, UPDATE, DELETE ON public\.boundary_proposals FROM anon, authenticated/);
  const propose = engine.slice(engine.indexOf('FUNCTION public.propose_boundary('), engine.indexOf('FUNCTION public.accept_boundary_proposal('));
  assert.doesNotMatch(propose, /UPDATE public\.(client_sites|location_zones|organizations)/, 'propose must never touch live geometry');
  assert.match(propose, /UPDATE public\.boundary_proposals SET status = 'superseded'/);
  const accept = engine.slice(engine.indexOf('FUNCTION public.accept_boundary_proposal('), engine.indexOf('FUNCTION public.reject_boundary_proposal('));
  assert.match(accept, /boundary_verification = 'unverified', boundary_verified_by = NULL, boundary_verified_at = NULL/);
  assert.equal((accept.match(/boundary_verification = 'unverified'/g) || []).length, 2, 'both site and zone writes reset verification');
  assert.match(accept, /IF NOT v_gate\.ok THEN RAISE EXCEPTION 'Boundary fails the % area gate/);
  assert.match(accept, /RAISE EXCEPTION 'Entity type % cannot be accepted through the workbench'/, 'Q5: organisation jurisdiction stays governed');
  assert.match(accept, /IF ST_NumGeometries\(v_final\) <> 1 THEN RAISE EXCEPTION 'A site boundary must be a single polygon'/);
  assert.match(accept, /INSERT INTO public\.geofence_boundary_history[\s\S]*?'direct_edit'/);
});

test('the hardened verify_boundary refuses to certify missing or invalid geometry (P1) and is pinned', () => {
  assert.match(hardening, /CREATE OR REPLACE FUNCTION public\.verify_boundary\(p_entity_type text, p_entity_id uuid\)\s+RETURNS boolean/);
  assert.match(hardening, /LANGUAGE plpgsql SECURITY DEFINER SET search_path = public/);
  assert.match(hardening, /IF v_boundary IS NULL OR ST_IsEmpty\(v_boundary\) THEN\s+RAISE EXCEPTION 'verify_boundary: % % has no boundary geometry to verify \(unresolved_no_geofence\)'/);
  assert.match(hardening, /IF NOT ST_IsValid\(v_boundary\) THEN\s+RAISE EXCEPTION 'verify_boundary: % % boundary geometry is invalid[^']*\(unresolved_invalid\)'/);
  // The geometry checks run before any state write for the three polygon entities.
  const checks = hardening.indexOf('unresolved_no_geofence');
  for (const write of ["SET jurisdiction_verification = 'verified'", "UPDATE public.location_zones SET boundary_verification = 'verified'", "UPDATE public.client_sites SET boundary_verification = 'verified'"]) {
    assert.ok(hardening.indexOf(write) > checks, `${write} must follow the geometry checks`);
  }
  assert.match(hardening, /'Boundary verified via visual map confirmation', public\._gbh_next_version\(v_et, p_entity_id\)/, 'history discipline unchanged');
  assert.match(hardening, /REVOKE ALL ON FUNCTION public\.verify_boundary\(text, uuid\) FROM PUBLIC, anon;/);
  assert.match(hardening, /REVOKE ALL ON FUNCTION public\._gbh_next_version\(text, uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(hardening, /REVOKE ALL ON FUNCTION public\.get_boundary_history\(text, uuid\) FROM PUBLIC, anon;/);
  assert.doesNotMatch(hardening, /CREATE TABLE|ALTER TABLE|CREATE POLICY|DROP POLICY|DROP FUNCTION/);
});

test('every writer of _gbh_next_version in the live schema is SECURITY DEFINER, so narrowing its grant is safe', () => {
  const functions = schema.split(/^CREATE OR REPLACE FUNCTION /m).slice(1);
  const callers = functions.filter((f) => /_gbh_next_version\(/.test(f.slice(f.indexOf('AS $function$'))));
  assert.ok(callers.length >= 8, `expected the known writers, found ${callers.length}`);
  for (const f of callers) assert.match(f.slice(0, f.indexOf('AS $function$')), /SECURITY DEFINER/, `${f.slice(0, 60)} must be SECURITY DEFINER`);
});

test('the disposable-database truth table exercises every rule the engine and the hardening claim', () => {
  for (const label of [
    'proposals cannot be inserted directly by a browser role',
    'proposing never touches the live boundary',
    'an older open proposal for the entity is superseded',
    'a shape below the band is flagged, not hidden',
    'a failing gate blocks acceptance',
    'a point is not a boundary',
    'a stranger cannot propose for another org',
    'a site with no geometry cannot be verified',
    'anon can no longer execute the verification or version helpers',
    'accepted with a human edit recorded',
    'live site boundary is the final polygon, authoritative provenance, still unverified',
    'visual verification flips the state and writes version 2',
    'zone boundary live as multipolygon, verified in the same act, two history rows',
    'an organisation jurisdiction cannot be accepted through the workbench (Q5)',
    'a two-part shape is refused for a site',
    'a rejection needs a reason',
    'a site with no polygon is top priority and carries no open proposal after rejection',
    "a stranger''s queue holds none of them",
    'an address matches by normalised key',
    'dedup lookup is org-access gated',
  ]) {
    assert.ok(oracle.includes(label), `oracle must carry check: ${label}`);
  }
});
