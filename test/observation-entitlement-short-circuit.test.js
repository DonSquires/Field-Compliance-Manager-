const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('observation read union remains equivalent and avoids per-row task work for existing grants', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, () => {
  const name = `fcm-observation-read-${process.pid}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    docker(['run', '-d', '--rm', '--network', 'none', '--memory', '512m', '--cpus', '1',
      '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { timeout: 2000 }).status === 0) { ready = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    assert.equal(ready, true);
    const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261020110000_observation_read_entitlement_short_circuit.sql'), 'utf8');
    const searchMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261020100000_all_authorised_subject_observations.sql'), 'utf8');
    const searchFunction = searchMigration.slice(searchMigration.indexOf('CREATE OR REPLACE FUNCTION public.search_vehicle_registrations'),
      searchMigration.indexOf('CREATE OR REPLACE FUNCTION "public"."list_repeat_vehicle_subjects_for_agreement"'));
    const sql = `
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE FUNCTION public.org_access_allowed(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN $1 IS NULL THEN NULL ELSE $1=md5('allowed')::uuid END
$$;
CREATE FUNCTION public.user_has_task_entitlement(uuid,uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF current_setting('fixture.forbid_task',true)='true' THEN RAISE EXCEPTION 'Unexpected expensive task check'; END IF;
  RETURN $2=md5('task-only')::uuid;
END $$;
CREATE TABLE observations(id uuid,organization_id uuid,client_org_id uuid,plate_number text);
CREATE TABLE canonical_vehicles(id uuid,plate_number text,make text,model text,year integer,colour text);
CREATE VIEW canonical_vehicle_public AS SELECT * FROM canonical_vehicles;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT SELECT ON observations TO authenticated;
GRANT SELECT ON canonical_vehicle_public TO authenticated;
CREATE POLICY observations_select ON observations FOR SELECT USING(public.org_access_allowed(organization_id));
CREATE POLICY observations_client_org_select ON observations FOR SELECT USING(public.org_access_allowed(client_org_id));
CREATE POLICY bob_full_read ON observations FOR SELECT TO authenticated USING((SELECT auth.uid())='00000000-0000-0000-0000-00000000b0b0');
CREATE POLICY observations_task_entitlement_select ON observations FOR SELECT TO authenticated USING(public.user_has_task_entitlement(auth.uid(),id));
INSERT INTO observations VALUES
  (md5('custody')::uuid,md5('allowed')::uuid,null,'RJ198'),
  (md5('client')::uuid,md5('denied')::uuid,md5('allowed')::uuid,'RJ298'),
  (md5('task-only')::uuid,md5('denied')::uuid,null,'RJ398'),
  (md5('denied')::uuid,md5('denied')::uuid,null,'RJ498'),
  (md5('no-orgs')::uuid,null,null,'RJ598');
${migration}
${searchFunction}
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',md5('fixture-user'),false);
DO $$
BEGIN
  IF (SELECT count(*) FROM observations)<>3 THEN RAISE EXCEPTION 'Read union changed'; END IF;
  IF EXISTS(SELECT 1 FROM observations WHERE id IN(md5('denied')::uuid,md5('no-orgs')::uuid)) THEN RAISE EXCEPTION 'Denied rows disclosed'; END IF;
END $$;
-- Turn the expensive path into a hard failure, proving it cannot run for rows
-- already granted by an organisation/client policy.
SELECT set_config('fixture.forbid_task','true',false);
DO $$
BEGIN
  IF (SELECT count(*) FROM observations WHERE id IN(md5('custody')::uuid,md5('client')::uuid))<>2 THEN RAISE EXCEPTION 'Existing org/client grants lost'; END IF;
END $$;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-00000000b0b0',false);
DO $$ BEGIN IF (SELECT count(*) FROM observations)<>5 THEN RAISE EXCEPTION 'Bob grant changed'; END IF; END $$;
RESET ROLE;
TRUNCATE observations;
INSERT INTO observations SELECT md5(n::text)::uuid,md5('allowed')::uuid,null,
  CASE WHEN n=8000 THEN 'RJ198' ELSE 'ABC'||n END FROM generate_series(1,8000) n;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',md5('fixture-user'),false);
-- Reproduce the search's normalisation/wildcard scan and grouping. Any call to
-- task-basis resolution still raises. The broad suffix variant must work too.
SET statement_timeout='2s';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.search_vehicle_registrations('RJ%9%8'))<>1 THEN
    RAISE EXCEPTION 'Requested wildcard failed';
  END IF;
  IF (SELECT plate_number FROM public.search_vehicle_registrations('RJ%9%8')) IS DISTINCT FROM 'RJ198' THEN
    RAISE EXCEPTION 'Search returned the wrong registration';
  END IF;
  IF (SELECT count(*) FROM public.search_vehicle_registrations('%J%%8'))<>1 THEN
    RAISE EXCEPTION 'Suffix wildcard failed';
  END IF;
END $$;
`;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
        input: sql, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Observation policy fixture failed:\n${error.stderr?.toString() ?? error.message}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});
