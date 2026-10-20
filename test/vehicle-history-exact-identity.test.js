const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('selected vehicle history uses indexed case-insensitive identity before caller RLS', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, () => {
  const name = `fcm-vehicle-history-${process.pid}`;
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
    const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261020130000_vehicle_history_exact_identity_index.sql'), 'utf8');
    const sql = `
CREATE ROLE authenticated;
CREATE TABLE observations(id integer PRIMARY KEY, organization_id uuid, canonical_vehicle_id uuid,
  plate_number text, observed_at timestamptz, zone_id uuid);
CREATE INDEX idx_observations_canonical_vehicle ON observations(organization_id,canonical_vehicle_id,observed_at DESC)
  WHERE canonical_vehicle_id IS NOT NULL;
CREATE FUNCTION fixture_access(integer,uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF $1<9000 THEN RAISE EXCEPTION 'Unrelated history access evaluated'; END IF;
  PERFORM pg_sleep(0.005);
  RETURN $2=md5('allowed')::uuid;
END $$;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_read ON observations FOR SELECT TO authenticated USING(fixture_access(id,organization_id));
GRANT SELECT ON observations TO authenticated;
INSERT INTO observations SELECT n,md5('denied')::uuid,md5(n::text)::uuid,'OTHER'||n,now(),md5('zone')::uuid
  FROM generate_series(1,8100) n;
INSERT INTO observations VALUES
 (9001,md5('allowed')::uuid,md5('chosen')::uuid,'OLDPLATE',now(),md5('zone')::uuid),
 (9002,md5('allowed')::uuid,null,'rJd598',now()-interval '1 day',md5('zone')::uuid),
 (9003,md5('allowed')::uuid,md5('chosen')::uuid,'RJD598',now()-interval '2 days',md5('other-zone')::uuid),
 (9004,md5('denied')::uuid,md5('chosen')::uuid,'RJD598',now(),md5('zone')::uuid);
${migration}
ANALYZE observations;
SET ROLE authenticated;
SET statement_timeout='2s';
DO $$
DECLARE ids integer[]; old_query_failed boolean := false;
BEGIN
  BEGIN
    PERFORM id FROM observations
    WHERE canonical_vehicle_id=md5('chosen')::uuid OR plate_number ILIKE 'RJD598'
    ORDER BY observed_at DESC LIMIT 10;
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Unrelated history access evaluated' THEN RAISE; END IF;
    old_query_failed := true;
  END;
  IF NOT old_query_failed THEN RAISE EXCEPTION 'Fixture did not reproduce original history scan'; END IF;
  SELECT array_agg(q.id ORDER BY q.observed_at DESC) INTO ids FROM (
    SELECT id,observed_at FROM observations
    WHERE canonical_vehicle_id=md5('chosen')::uuid OR plate_number_upper='RJD598'
    ORDER BY observed_at DESC LIMIT 10
  ) q;
  IF ids IS DISTINCT FROM ARRAY[9001,9002,9003] THEN RAISE EXCEPTION 'History identity, order, dedup or RLS changed: %',ids; END IF;
  IF (SELECT count(*) FROM observations WHERE plate_number_upper='RJD598')<>2 THEN RAISE EXCEPTION 'Legacy case-insensitive lookup lost'; END IF;
  IF (SELECT count(*) FROM observations WHERE
    (canonical_vehicle_id=md5('chosen')::uuid OR plate_number_upper='RJD598') AND zone_id=md5('zone')::uuid)<>2
    THEN RAISE EXCEPTION 'Officer agreement zone filter changed'; END IF;
  IF EXISTS(SELECT 1 FROM observations WHERE plate_number_upper='NOTFOUND') THEN RAISE EXCEPTION 'Empty result changed'; END IF;
END $$;
RESET ROLE;
INSERT INTO observations VALUES(9010,md5('allowed')::uuid,null,'rjd598',now(),md5('zone')::uuid);
DO $$ BEGIN
  IF (SELECT plate_number_upper FROM observations WHERE id=9010)<>'RJD598' THEN RAISE EXCEPTION 'New writes lack derived key'; END IF;
END $$;
UPDATE observations SET plate_number='aBc123' WHERE id=9010;
DO $$ BEGIN
  IF (SELECT plate_number_upper FROM observations WHERE id=9010)<>'ABC123' THEN RAISE EXCEPTION 'Plate update did not update key'; END IF;
END $$;
`;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
        input: sql, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Exact vehicle history fixture failed:\n${error.stderr?.toString() ?? error.message}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});
