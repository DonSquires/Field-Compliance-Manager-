const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const enrichmentMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261109130000_vehicle_admin_signal_history.sql'), 'utf8');

test('vehicle enrichment receipts are admin-gated and omit provider secrets and payload values', () => {
  assert.match(enrichmentMigration, /public\.is_admin_for_org\(p_organization_id\)/);
  assert.match(enrichmentMigration, /RETURNS TABLE\(source_name text, source_location text, retrieved_at timestamptz, response_sha256 text\)/);
  assert.match(enrichmentMigration, /ORDER BY source\.retrieved_at DESC/);
  assert.match(enrichmentMigration, /least\(greatest\(coalesce\(p_limit, 25\), 1\), 100\)/);
  assert.doesNotMatch(enrichmentMigration, /normalized_payload|storage_authorization_reference|source_key|source_url/);
  assert.match(enrichmentMigration, /REVOKE ALL ON FUNCTION public\.get_vehicle_enrichment_receipts/);
  assert.match(enrichmentMigration, /GRANT EXECUTE ON FUNCTION public\.get_vehicle_enrichment_receipts[\s\S]*?TO authenticated, service_role/);
});

test('vehicle discovery uses the canonical spine without evaluating linked-history access', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, () => {
  const name = `fcm-vehicle-spine-${process.pid}`;
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
    const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261020120000_vehicle_search_use_canonical_spine.sql'), 'utf8');
    const receiptMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261109130000_vehicle_admin_signal_history.sql'), 'utf8');
    const sql = `
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT auth.uid()=md5('fixture-admin')::uuid AND $1=md5('fixture-provider')::uuid
$$;
CREATE TABLE canonical_vehicles(id uuid,plate_number text,make text,model text,year integer,colour text);
CREATE VIEW canonical_vehicle_public AS SELECT * FROM canonical_vehicles;
CREATE TABLE vehicle_data_sources(id uuid,canonical_vehicle_id uuid,client_request_id uuid,source_name text,
  source_url text,source_location text,source_terms_url text,storage_authorization_reference text,
  source_key text,normalized_payload jsonb,response_sha256 text,retrieved_at timestamptz,created_at timestamptz);
CREATE TABLE observations(id uuid,canonical_vehicle_id uuid,organization_id uuid,plate_number text);
CREATE FUNCTION fixture_observation_access(uuid,uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF $1 IS NOT NULL THEN RAISE EXCEPTION 'Registration discovery must not evaluate linked-history access'; END IF;
  PERFORM pg_sleep(0.01);
  RETURN $2=md5('allowed')::uuid;
END $$;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_read ON observations FOR SELECT TO authenticated
  USING(fixture_observation_access(canonical_vehicle_id,organization_id));
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT SELECT ON observations,canonical_vehicle_public TO authenticated;
INSERT INTO canonical_vehicles VALUES
  (md5('canonical')::uuid,'RJ198','Fixture','Registry',2026,'Blue'),
  (md5('canonical-yg')::uuid,'AYG24','Fixture','Registry',2026,'Blue');
INSERT INTO vehicle_data_sources VALUES(md5('receipt')::uuid,md5('canonical')::uuid,md5('request')::uuid,
  'Fixture licensed provider','https://fixture.invalid/private?plate=RJ198','NZ','https://fixture.invalid/terms',
  'private-storage-consent','secret-source-key','{"owner":"must not escape"}'::jsonb,'abcdef123456',now(),now());
INSERT INTO observations SELECT md5(n::text)::uuid,md5('canonical')::uuid,
  md5('denied')::uuid,'RJ198' FROM generate_series(1,8100) n;
INSERT INTO observations VALUES
  (md5('legacy')::uuid,null,md5('allowed')::uuid,'RJ298'),
  (md5('legacy-denied')::uuid,null,md5('denied')::uuid,'RJ398'),
  (md5('duplicate')::uuid,null,md5('allowed')::uuid,'RJ198'),
  (md5('legacy-yg')::uuid,null,md5('allowed')::uuid,'BYG34');
${migration}
${receiptMigration}
ANALYZE observations;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',md5('fixture-user'),false);
SET statement_timeout='2s';
DO $$
BEGIN
  IF (SELECT count(*) FROM public.search_vehicle_registrations('RJ%9%8'))<>2 THEN RAISE EXCEPTION 'Registry/legacy matching or RLS exclusion failed'; END IF;
  IF (SELECT count(*) FROM public.search_vehicle_registrations('%yg%%4'))<>2 THEN RAISE EXCEPTION 'Second human wildcard variant failed'; END IF;
  IF (SELECT id FROM public.search_vehicle_registrations('RJ%9%8') WHERE plate_number='RJ198') IS DISTINCT FROM md5('canonical')::uuid THEN RAISE EXCEPTION 'Canonical identity lost during deduplication'; END IF;
  IF EXISTS(SELECT 1 FROM public.search_vehicle_registrations('RJ%9%8') WHERE plate_number='RJ398') THEN RAISE EXCEPTION 'Legacy observation RLS bypassed'; END IF;
  IF (SELECT count(*) FROM public.search_vehicle_registrations('%RJ%',1))<>1 THEN RAISE EXCEPTION 'Result cap ignored'; END IF;
  IF (SELECT count(*) FROM public.search_vehicle_registrations('%NOTFOUND%'))<>0 THEN RAISE EXCEPTION 'Empty result incorrect'; END IF;
END $$;
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',md5('fixture-admin'),false);
DO $$ BEGIN
  IF (SELECT count(*) FROM public.get_vehicle_enrichment_receipts(md5('fixture-provider')::uuid,md5('canonical')::uuid,25))<>1 THEN
    RAISE EXCEPTION 'Vehicle enrichment receipt not available to authorized admin';
  END IF;
  IF has_function_privilege('anon','public.get_vehicle_enrichment_receipts(uuid,uuid,integer)','EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous receipt read granted';
  END IF;
END $$;
SELECT set_config('request.jwt.claim.sub',md5('fixture-user'),false);
DO $$ DECLARE denied boolean:=false; BEGIN
  BEGIN PERFORM 1 FROM public.get_vehicle_enrichment_receipts(md5('fixture-provider')::uuid,md5('canonical')::uuid,25);
  EXCEPTION WHEN insufficient_privilege THEN denied:=true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Unauthorised receipt read succeeded'; END IF;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.search_vehicle_registrations(text,integer)'::regprocedure) THEN RAISE EXCEPTION 'RPC must remain security invoker'; END IF;
  IF has_function_privilege('anon','public.search_vehicle_registrations(text,integer)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous search granted'; END IF;
END $$;
`;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
        input: sql, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Canonical-spine search fixture failed:\n${error.stderr?.toString() ?? error.message}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});
