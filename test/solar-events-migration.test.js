const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261117000400_solar_events.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n') : '';

test('solar events migration declares its surface', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.solar_event_at\(p_date date, p_lat double precision, p_lng double precision, p_event text\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.place_anchor_point\(p_site_id uuid, p_zone_id uuid\)/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
});

describe('solar events against disposable PostgreSQL', { skip: process.env.BOB_TEST_POSTGRES !== '1' }, () => {
  const container = `fcm-solar-events-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = (sql) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres'], sql);
  const scalar = (sql) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-qAt', '-U', 'postgres'], sql).trim();
  let created = false;
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const site = id(1); const zone = id(2); const bareZone = id(3); const centredZone = id(4);
  const wellington = [-41.2865, 174.7762];

  // Minutes after local midnight in Pacific/Auckland, or null.
  const localMinutes = (date, lat, lng, event) => {
    const value = scalar(`SELECT to_char(public.solar_event_at('${date}',${lat},${lng},'${event}') AT TIME ZONE 'Pacific/Auckland','YYYY-MM-DD HH24:MI:SS');`);
    if (value === '') return null;
    assert.equal(value.slice(0, 10), date, `${event} on ${date} falls on that local date`);
    const [h, m, s] = value.slice(11).split(':').map(Number);
    return h * 60 + m + s / 60;
  };
  const near = (actual, hhmm, tolerance, label) => {
    const [h, m] = hhmm.split(':').map(Number);
    assert.ok(actual !== null && Math.abs(actual - (h * 60 + m)) <= tolerance, `${label}: got ${actual} minutes, expected ${hhmm} +/- ${tolerance}`);
  };

  before(async () => {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { psql('SELECT 1;'); break; } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    psql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE SCHEMA fixture;
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY, boundary geometry(Polygon,4326), center_point geometry(Point,4326));
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY, site_id uuid, boundary geometry(MultiPolygon,4326), center_point geometry(Point,4326));
      CREATE FUNCTION fixture.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION fixture.raises(command text, expected text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN IF SQLSTATE = expected THEN RETURN; END IF; RAISE; END;
        RAISE EXCEPTION 'Expected SQLSTATE %',expected;
      END $fn$;
      INSERT INTO public.client_sites VALUES('${site}',ST_GeomFromText('POLYGON((174.0 -41.0,174.2 -41.0,174.2 -41.2,174.0 -41.2,174.0 -41.0))',4326),NULL);
      INSERT INTO public.location_zones VALUES
        ('${zone}',NULL,ST_GeomFromText('MULTIPOLYGON(((175.0 -40.0,175.4 -40.0,175.4 -40.4,175.0 -40.4,175.0 -40.0)))',4326),NULL),
        ('${bareZone}',NULL,NULL,NULL),
        ('${centredZone}','${site}',NULL,ST_SetSRID(ST_MakePoint(176.5,-39.5),4326));
      ${migration}
    `);
  });

  after(() => { if (created) docker(['rm', '--force', container]); });

  test('Wellington midsummer sunrise and sunset', () => {
    const rise = localMinutes('2026-12-21', ...wellington, 'sunrise');
    const set = localMinutes('2026-12-21', ...wellington, 'sunset');
    near(rise, '05:44', 4, 'brief sunrise');
    near(set, '20:57', 4, 'brief sunset');
    // NOAA solar calculator (spreadsheet formulas) gives 05:44.0 and 20:53.4.
    near(rise, '05:44', 1, 'NOAA sunrise');
    near(set, '20:53', 1, 'NOAA sunset');
  });

  test('Wellington midwinter sunrise and sunset', () => {
    const rise = localMinutes('2026-06-21', ...wellington, 'sunrise');
    const set = localMinutes('2026-06-21', ...wellington, 'sunset');
    near(rise, '07:47', 4, 'brief sunrise');
    near(set, '16:58', 4, 'brief sunset');
    near(rise, '07:47', 1, 'NOAA sunrise');
    near(set, '16:58', 1, 'NOAA sunset');
  });

  test('Chatham Islands times fall on the Auckland date asked for', () => {
    // localMinutes asserts the Pacific/Auckland date equals p_date.
    const rise = localMinutes('2026-12-21', -43.95, -176.56, 'sunrise');
    const set = localMinutes('2026-12-21', -43.95, -176.56, 'sunset');
    // NOAA reference on the Auckland clock: 04:59.7 and 20:28.4.
    near(rise, '05:00', 1, 'NOAA Chatham sunrise');
    near(set, '20:28', 1, 'NOAA Chatham sunset');
  });

  test('daylight saving changeover day', () => {
    const rise = localMinutes('2026-09-27', ...wellington, 'sunrise');
    const set = localMinutes('2026-09-27', ...wellington, 'sunset');
    // NOAA reference in NZDT: 07:02.2 and 19:21.9.
    near(rise, '07:02', 1, 'NOAA changeover sunrise');
    near(set, '19:22', 1, 'NOAA changeover sunset');
  });

  test('no sunrise or sunset under the midnight sun or polar night', () => {
    psql(`
      SELECT fixture.check(public.solar_event_at('2026-06-21',78.22,15.65,'sunrise') IS NULL,'Longyearbyen midsummer has no sunrise');
      SELECT fixture.check(public.solar_event_at('2026-06-21',78.22,15.65,'sunset') IS NULL,'Longyearbyen midsummer has no sunset');
      SELECT fixture.check(public.solar_event_at('2026-12-21',78.22,15.65,'sunrise') IS NULL,'Longyearbyen polar night has no sunrise');
      SELECT fixture.check(public.solar_event_at('2026-12-21',78.22,15.65,'sunset') IS NULL,'Longyearbyen polar night has no sunset');
      SELECT fixture.check(public.solar_event_at('2026-06-21',-41.0,174.0,NULL) IS NULL,'a missing event gives no time');
      SELECT fixture.check(public.solar_event_at(NULL,78.22,15.65,'sunrise') IS NULL,'a missing date gives no time');
      SELECT fixture.raises($q$ SELECT public.solar_event_at('2026-06-21',-41.0,174.0,'noon') $q$,'22023');
    `);
  });

  test('place anchor point falls back from centre point to boundary centroid', () => {
    psql(`
      SELECT fixture.check(ST_Equals(public.place_anchor_point(NULL,'${zone}'),ST_SetSRID(ST_MakePoint(175.2,-40.2),4326)),'a zone without a centre point uses its boundary centroid');
      SELECT fixture.check(ST_SRID(public.place_anchor_point(NULL,'${zone}'))=4326,'the anchor is in WGS84');
      SELECT fixture.check(public.place_anchor_point(NULL,'${bareZone}') IS NULL,'a zone with neither centre nor boundary has no anchor');
      SELECT fixture.check(public.place_anchor_point(NULL,NULL) IS NULL,'no place gives no anchor');
      SELECT fixture.check(ST_Equals(public.place_anchor_point('${site}',NULL),ST_SetSRID(ST_MakePoint(174.1,-41.1),4326)),'a site without a centre point uses its boundary centroid');
      SELECT fixture.check(ST_Equals(public.place_anchor_point('${site}','${centredZone}'),ST_SetSRID(ST_MakePoint(176.5,-39.5),4326)),'a centre point wins over a boundary centroid');
      SELECT fixture.check(ST_Equals(public.place_anchor_point('${site}','${bareZone}'),ST_SetSRID(ST_MakePoint(174.1,-41.1),4326)),'a bare zone falls back to its site boundary');
      UPDATE public.client_sites SET center_point=ST_SetSRID(ST_MakePoint(174.15,-41.15),4326) WHERE id='${site}';
      SELECT fixture.check(ST_Equals(public.place_anchor_point('${site}','${centredZone}'),ST_SetSRID(ST_MakePoint(174.15,-41.15),4326)),'the site centre point comes first');
    `);
  });

  test('grants keep the anchor internal and the solar maths callable', () => {
    psql(`
      SELECT fixture.check(has_function_privilege('authenticated','public.solar_event_at(date,double precision,double precision,text)','EXECUTE'),'signed-in users can call solar_event_at');
      SELECT fixture.check(has_function_privilege('service_role','public.solar_event_at(date,double precision,double precision,text)','EXECUTE'),'service role can call solar_event_at');
      SELECT fixture.check(NOT has_function_privilege('anon','public.solar_event_at(date,double precision,double precision,text)','EXECUTE'),'anon cannot call solar_event_at');
      SELECT fixture.check(NOT has_function_privilege('anon','public.place_anchor_point(uuid,uuid)','EXECUTE'),'anon cannot call place_anchor_point');
      SELECT fixture.check(NOT has_function_privilege('authenticated','public.place_anchor_point(uuid,uuid)','EXECUTE'),'signed-in users cannot call place_anchor_point');
      SELECT fixture.check(has_function_privilege('service_role','public.place_anchor_point(uuid,uuid)','EXECUTE'),'service role can call place_anchor_point');
      SELECT fixture.check((SELECT prosecdef AND provolatile='s' FROM pg_proc WHERE proname='place_anchor_point'),'place_anchor_point is a stable security definer');
      SELECT fixture.check((SELECT NOT prosecdef AND provolatile='i' FROM pg_proc WHERE proname='solar_event_at'),'solar_event_at is immutable');
    `);
  });
});
