'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261108160000_geofence_place_enrichment.sql'), 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

test('the inheritance source the place triggers already use is admitted', () => {
  assert.match(squash(migration), /'imported_geojson'::text, 'canonical_place_inherited'::text\]/);
});

test('a site without geometry can never claim an authoritative or verified boundary', () => {
  const sql = squash(migration);
  assert.match(sql, /IF NEW\.boundary IS NULL THEN NEW\.boundary_status := 'provisional'; NEW\.boundary_verification := 'unverified';/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF boundary, boundary_status, boundary_verification ON public\.client_sites/);
});

test('sharing only stages proposals and never certifies on anyone else\'s behalf', () => {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.stage_canonical_boundary_for_siblings(');
  const body = migration.slice(start, migration.indexOf('$function$;', start));
  assert.match(body, /INSERT INTO public\.boundary_proposals/);
  assert.doesNotMatch(body, /UPDATE public\.client_sites/);
  assert.doesNotMatch(body, /verify_boundary/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.stage_canonical_boundary_for_siblings\(uuid, uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(squash(migration), /WHEN \(NEW\.boundary_verification = 'verified' AND OLD\.boundary_verification IS DISTINCT FROM 'verified' AND NEW\.boundary IS NOT NULL\)/);
});

test('place boundary enrichment runs in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-geofence-enrich-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [orgA, orgB, admin, cp1, cp2, cp3, locA1, locB1, locA2, locB2, locA3, locB3] = [1, 2, 3, 10, 11, 12, 20, 21, 22, 23, 24, 25].map(id);
  const [siteVerified, siteSibling, siteToVerify, siteLater, siteLying, siteKeepsPlace, siteOther] = [30, 31, 32, 33, 34, 35, 36].map(id);
  const square = (x) => `ST_SetSRID(ST_GeomFromText('POLYGON((175.${x}0 -40.30,175.${x}1 -40.30,175.${x}1 -40.31,175.${x}0 -40.31,175.${x}0 -40.30))'),4326)`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    sql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.canonical_places (id uuid PRIMARY KEY, boundary geometry(MultiPolygon,4326), updated_at timestamptz);
      CREATE TABLE public.locations (id uuid PRIMARY KEY, organization_id uuid, canonical_place_id uuid REFERENCES public.canonical_places(id));
      CREATE TABLE public.client_sites (
        id uuid PRIMARY KEY, client_organization_id uuid NOT NULL, location_id uuid REFERENCES public.locations(id), active boolean NOT NULL DEFAULT true,
        boundary geometry(Polygon,4326), boundary_status text NOT NULL DEFAULT 'provisional', boundary_verification text NOT NULL DEFAULT 'unverified',
        boundary_verified_by uuid, boundary_verified_at timestamptz);
      CREATE TABLE public.boundary_proposals (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid,
        proposed_boundary geometry(MultiPolygon,4326) NOT NULL, center_point geometry(Point,4326), area_m2 numeric NOT NULL,
        source text NOT NULL, source_ref jsonb NOT NULL DEFAULT '{}', address_candidate jsonb, zone_type text, gate_ok boolean NOT NULL, gate_reason text,
        status text NOT NULL DEFAULT 'proposed', proposed_by uuid, proposed_via text NOT NULL,
        CONSTRAINT boundary_proposals_source_check CHECK (source = ANY (ARRAY['linz_parcel','linz_building','council_gis','nzta','google_point_radius','user_drawn','bob','imported_geojson'])));
      CREATE TABLE public.audit_log (organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
      CREATE FUNCTION public.geofence_area_gate(p_area_m2 numeric, p_zone_type text) RETURNS TABLE(ok boolean, reason text) LANGUAGE sql IMMUTABLE
        AS $$ SELECT p_area_m2 BETWEEN 10 AND 2000000, CASE WHEN p_area_m2 BETWEEN 10 AND 2000000 THEN NULL ELSE 'area' END $$;

      INSERT INTO public.canonical_places(id, boundary) VALUES ('${cp1}', NULL), ('${cp2}', NULL), ('${cp3}', ST_Multi(${square(5)}));
      INSERT INTO public.locations VALUES ('${locA1}','${orgA}','${cp1}'), ('${locB1}','${orgB}','${cp1}'), ('${locA2}','${orgA}','${cp2}'), ('${locB2}','${orgB}','${cp2}'), ('${locA3}','${orgA}','${cp3}'), ('${locB3}','${orgB}','${cp3}');
      INSERT INTO public.client_sites(id, client_organization_id, location_id, boundary, boundary_status, boundary_verification, boundary_verified_at) VALUES
        ('${siteVerified}', '${orgA}', '${locA1}', ${square(1)}, 'authoritative', 'verified', now()),
        ('${siteSibling}', '${orgB}', '${locB1}', NULL, 'provisional', 'unverified', NULL),
        ('${siteToVerify}', '${orgA}', '${locA2}', ${square(2)}, 'authoritative', 'unverified', NULL),
        ('${siteLater}', '${orgB}', '${locB2}', NULL, 'provisional', 'unverified', NULL),
        ('${siteLying}', '${orgB}', '${locB3}', NULL, 'authoritative', 'unverified', NULL),
        ('${siteKeepsPlace}', '${orgA}', '${locA3}', ${square(6)}, 'authoritative', 'unverified', NULL);
    `);
    sql(migration);

    assert.equal(sql(`SELECT boundary_status || '|' || boundary_verification FROM public.client_sites WHERE id='${siteLying}'`).trim(), 'provisional|unverified');
    assert.equal(sql(`SELECT ST_Equals(boundary, ST_Multi(${square(1)})) FROM public.canonical_places WHERE id='${cp1}'`).trim(), 't');
    assert.equal(sql(`SELECT source || '|' || status || '|' || organization_id FROM public.boundary_proposals WHERE entity_id='${siteSibling}'`).trim(), `canonical_place_inherited|proposed|${orgB}`);
    assert.equal(sql(`SELECT count(*) FROM public.boundary_proposals WHERE entity_id='${siteLying}'`).trim(), '1', 'a place that already knows its shape seeds sites with none');
    assert.equal(sql(`SELECT boundary IS NULL FROM public.client_sites WHERE id='${siteSibling}'`).trim(), 't', 'the sibling live boundary is never written');

    sql(`BEGIN; SET LOCAL request.jwt.claim.sub='${admin}'; UPDATE public.client_sites SET boundary_verification='verified', boundary_verified_by='${admin}', boundary_verified_at=now() WHERE id='${siteToVerify}'; COMMIT;`);
    assert.equal(sql(`SELECT boundary_verification FROM public.client_sites WHERE id='${siteToVerify}'`).trim(), 'verified');
    assert.equal(sql(`SELECT ST_Equals(boundary, ST_Multi(${square(2)})) FROM public.canonical_places WHERE id='${cp2}'`).trim(), 't');
    assert.equal(sql(`SELECT proposed_by || '|' || proposed_via || '|' || (source_ref->>'from_site_id') FROM public.boundary_proposals WHERE entity_id='${siteLater}'`).trim(), `${admin}|canonical_place_seed|${siteToVerify}`);

    sql(`UPDATE public.client_sites SET boundary_verification='verified' WHERE id='${siteKeepsPlace}'`);
    assert.equal(sql(`SELECT ST_Equals(boundary, ST_Multi(${square(5)})) FROM public.canonical_places WHERE id='${cp3}'`).trim(), 't', 'an existing place boundary is not overwritten');
    assert.equal(sql(`SELECT count(*) FROM public.boundary_proposals WHERE entity_id='${siteLying}'`).trim(), '1', 'an open proposal is not duplicated');

    sql(`INSERT INTO public.client_sites(id, client_organization_id, boundary, boundary_status, boundary_verification) VALUES ('${siteOther}', '${orgA}', NULL, 'authoritative', 'verified')`);
    assert.equal(sql(`SELECT boundary_status || '|' || boundary_verification FROM public.client_sites WHERE id='${siteOther}'`).trim(), 'provisional|unverified');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
