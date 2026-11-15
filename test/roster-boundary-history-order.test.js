'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrations = path.resolve(__dirname, '../supabase/migrations');
const original = fs.readFileSync(path.join(migrations, '20260830135000_roster_commercial_readiness.sql'), 'utf8');

test('roster geofence readiness reads the final boundary version when save and verification share a timestamp', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const migrationNames = fs.readdirSync(migrations).filter(name => name.endsWith('_fix_roster_boundary_history_order.sql'));
  assert.equal(migrationNames.length, 1);
  const repair = fs.readFileSync(path.join(migrations, migrationNames[0]), 'utf8');
  const name = `fcm-roster-boundary-history-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sql = input => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input).trim();
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const place = id(1), missing = id(2), noHistory = id(3);
  const state = (site, zone) => sql(`SET ROLE service_role;
    SELECT public.roster_place_geofence_state(${site ? `'${site}'` : 'NULL'},${zone ? `'${zone}'` : 'NULL'});`);
  const acl = () => sql(`SELECT proacl::text FROM pg_proc
    WHERE oid='public.roster_place_geofence_state(uuid,uuid)'::regprocedure`);
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    sql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY,boundary geometry(Polygon,4326));
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY,boundary geometry(MultiPolygon,4326));
      CREATE TABLE public.geofence_boundary_history(
        entity_type text,entity_id uuid,verification_state text,
        version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
      ${original.slice(0, original.indexOf('create function public.roster_agreement_billing_ready'))}
      REVOKE ALL ON FUNCTION public.roster_place_geofence_state(uuid,uuid) FROM PUBLIC,anon,authenticated;
      GRANT EXECUTE ON FUNCTION public.roster_place_geofence_state(uuid,uuid) TO service_role;
      INSERT INTO public.client_sites VALUES
        ('${place}',ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326)),
        ('${missing}',NULL),
        ('${noHistory}',ST_GeomFromText('POLYGON((0 0,0 1,1 1,1 0,0 0))',4326));
      INSERT INTO public.location_zones SELECT id,ST_Multi(boundary) FROM public.client_sites;
      BEGIN;
      INSERT INTO public.geofence_boundary_history(entity_type,entity_id,verification_state,version)
        VALUES ('client_site','${place}','unverified',2),('location_zone','${place}','unverified',2);
      INSERT INTO public.geofence_boundary_history(entity_type,entity_id,verification_state,version)
        VALUES ('client_site','${place}','verified',3),('location_zone','${place}','verified',3),
          ('client_site','${missing}','verified',1),('location_zone','${missing}','verified',1);
      COMMIT;
    `);
    assert.equal(sql(`SELECT count(DISTINCT created_at) FROM public.geofence_boundary_history
      WHERE entity_id='${place}'`), '1', 'A combined save/verify transaction shares now()');
    assert.equal(state(place, null), 'mapped_unverified', 'Reproduces the original tied-timestamp defect');
    const beforeAcl = acl();
    sql(`BEGIN; ${repair} COMMIT;`);
    assert.equal(acl(), beforeAcl, 'Repair preserves the existing internal-helper execute grants');

    for (const [site, zone] of [[place, null], [null, place]]) {
      assert.equal(state(site, zone), 'verified', 'The final verification version wins a timestamp tie');
    }
    for (const [site, zone] of [[missing, null], [null, missing], [null, null], [id(99), null]]) {
      assert.equal(state(site, zone), 'missing', 'A history row never invents current boundary geometry');
    }
    for (const [site, zone] of [[noHistory, null], [null, noHistory]]) {
      assert.equal(state(site, zone), 'mapped_unverified', 'Geometry without verification history stays unverified');
    }
    sql(`INSERT INTO public.geofence_boundary_history(entity_type,entity_id,verification_state,version,created_at)
      SELECT entity_type,entity_id,'unverified',4,created_at FROM public.geofence_boundary_history
      WHERE entity_id='${place}' AND version=3;`);
    for (const [site, zone] of [[place, null], [null, place]]) {
      assert.equal(state(site, zone), 'mapped_unverified', 'A subsequent unverified revision supersedes verification');
    }
    for (const role of ['anon', 'authenticated']) {
      assert.throws(() => sql(`SET ROLE ${role}; SELECT public.roster_place_geofence_state('${place}',NULL)`),
        error => /permission denied/.test(String(error.stderr ?? error.message)));
    }
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
