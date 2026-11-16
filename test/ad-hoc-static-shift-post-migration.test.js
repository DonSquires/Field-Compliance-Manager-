const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261116090231_ad_hoc_static_shift_post.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n') : '';

test('officer-started static shifts receive the contracted static post', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.start_ad_hoc_officer_shift\(/);
  assert.match(migration, /work_unit_type = 'static'/);
  assert.match(migration, /INSERT INTO public\.shift_stops/);
  assert.match(migration, /INSERT INTO public\.shift_stop_modules/);
  assert.match(migration, /Static work unit contract is no longer active/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.start_ad_hoc_officer_shift\(uuid, text, uuid, uuid, text\) FROM PUBLIC, anon;/);
});

test('static unscheduled shift preparation, against disposable PostgreSQL', { skip: process.env.BOB_TEST_POSTGRES !== '1' }, async () => {
  const container = `fcm-adhoc-static-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const officer = id(1); const org = id(9);
    const staticUnit = id(20); const patrolUnit = id(21); const closedUnit = id(22);
    const start = (unit, key) => `public.start_ad_hoc_officer_shift('${unit}','${key}',NULL,NULL,'Synthetic note')`;
    const sql = `
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE user_profiles(id uuid PRIMARY KEY, organization_id uuid, role text, deactivated_at timestamptz);
      CREATE TABLE roster_work_units(id uuid PRIMARY KEY, organization_id uuid, active boolean, service_type text, work_unit_type text, patrol_route_id uuid, service_agreement_location_id uuid, service_agreement_module_id uuid);
      CREATE TABLE service_agreement_locations(id uuid PRIMARY KEY, service_agreement_id uuid, status text, site_id uuid, zone_id uuid);
      CREATE TABLE service_agreement_modules(id uuid PRIMARY KEY, service_agreement_id uuid, module_key text, enabled boolean);
      CREATE TABLE client_sites(id uuid PRIMARY KEY, location_id uuid);
      CREATE TABLE locations(id uuid PRIMARY KEY, organization_id uuid);
      CREATE TABLE location_zones(id uuid PRIMARY KEY, location_id uuid);
      CREATE TABLE shifts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, officer_user_id uuid, service_type text, location_id uuid, zone_id uuid, patrol_route_id uuid, service_agreement_location_id uuid, service_agreement_module_id uuid, scheduled_start timestamptz, scheduled_end timestamptz, status text, notes text, work_unit_id uuid, module_key text, shift_origin text, total_stops integer, generated_at timestamptz, created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE shift_stops(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, shift_id uuid, site_id uuid, zone_id uuid, module_key text, stop_order integer, visit_number integer, is_adhoc boolean, sla_arrive_by timestamptz, required_dwell_minutes integer, status text, sla_status text, officer_notes text, CHECK ((site_id IS NOT NULL) <> (zone_id IS NOT NULL)));
      CREATE TABLE shift_stop_modules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, shift_stop_id uuid, module_key text, is_required boolean, service_agreement_module_id uuid, service_agreement_location_id uuid, UNIQUE(shift_stop_id, module_key));
      CREATE TABLE audit_log(organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
      CREATE TABLE generated_routes(shift_id uuid);
      CREATE FUNCTION public.has_location_access(uuid, uuid) RETURNS boolean LANGUAGE sql AS $fn$ SELECT true $fn$;
      CREATE FUNCTION public.generate_shift_stops(p_shift uuid, p_date date) RETURNS void LANGUAGE sql AS $fn$ INSERT INTO generated_routes VALUES(p_shift) $fn$;
      CREATE FUNCTION pg_temp.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION pg_temp.denied(command text, expected text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN IF position(expected in SQLERRM)>0 THEN RETURN; END IF; RAISE; END;
        RAISE EXCEPTION 'Expected refusal: %',expected;
      END $fn$;
      INSERT INTO user_profiles VALUES('${officer}','${org}','officer',NULL);
      INSERT INTO service_agreement_locations VALUES('${id(30)}','${id(40)}','active','${id(50)}',NULL),('${id(31)}','${id(41)}','ended','${id(50)}',NULL);
      INSERT INTO service_agreement_modules VALUES('${id(32)}','${id(40)}','static_guarding',true),('${id(33)}','${id(41)}','static_guarding',true);
      INSERT INTO client_sites VALUES('${id(50)}','${id(60)}');
      INSERT INTO roster_work_units VALUES
        ('${staticUnit}','${org}',true,'static_guarding','static',NULL,'${id(30)}','${id(32)}'),
        ('${patrolUnit}','${org}',true,'patrol','patrol','${id(70)}',NULL,NULL),
        ('${closedUnit}','${org}',true,'static_guarding','static',NULL,'${id(31)}','${id(33)}');
      -- A shift prepared by the previous function: no static post, so its briefing cannot load.
      INSERT INTO shifts(id,organization_id,officer_user_id,service_type,service_agreement_location_id,service_agreement_module_id,scheduled_start,scheduled_end,status,notes,work_unit_id,module_key,shift_origin)
        VALUES('${id(80)}','${org}','${officer}','static_guarding','${id(30)}','${id(32)}',now(),now()+interval '12 hours','scheduled','Earlier note','${staticUnit}','static_guarding','ad_hoc');
      SELECT set_config('request.jwt.claim.sub','${officer}',false);
      ${migration}

      SELECT pg_temp.check((SELECT (${start(staticUnit, 'static_guarding')}).id='${id(80)}'),'retry returns the existing unstarted shift');
      SELECT pg_temp.check((SELECT count(*)=1 FROM shift_stops WHERE shift_id='${id(80)}' AND module_key='static_guarding' AND site_id='${id(50)}' AND zone_id IS NULL AND status='pending' AND stop_order=1),'retry repairs the missing static post');
      SELECT pg_temp.check((SELECT count(*)=1 FROM shift_stop_modules m JOIN shift_stops st ON st.id=m.shift_stop_id WHERE st.shift_id='${id(80)}' AND m.module_key='static_guarding' AND m.is_required AND m.service_agreement_module_id='${id(32)}' AND m.service_agreement_location_id='${id(30)}'),'repaired post carries contract attribution');
      SELECT pg_temp.check((SELECT location_id='${id(60)}' AND total_stops=1 AND generated_at IS NOT NULL FROM shifts WHERE id='${id(80)}'),'repaired shift is placed at the contracted site');
      SELECT ${start(staticUnit, 'static_guarding')};
      SELECT pg_temp.check((SELECT count(*)=1 FROM shift_stops WHERE shift_id='${id(80)}'),'repeated retries do not duplicate the post');

      UPDATE shifts SET status='completed' WHERE id='${id(80)}';
      SELECT pg_temp.check((SELECT (${start(staticUnit, 'static_guarding')}).shift_origin='ad_hoc'),'new unscheduled static shift is prepared');
      SELECT pg_temp.check((SELECT count(*)=1 FROM shift_stops st JOIN shifts s ON s.id=st.shift_id JOIN shift_stop_modules m ON m.shift_stop_id=st.id WHERE s.id<>'${id(80)}' AND s.work_unit_id='${staticUnit}' AND st.module_key='static_guarding' AND m.service_agreement_module_id='${id(32)}'),'new static shift has one attributed post');
      SELECT pg_temp.check((SELECT location_id='${id(60)}' AND total_stops=1 FROM shifts WHERE id<>'${id(80)}' AND work_unit_id='${staticUnit}'),'new static shift is placed at the contracted site');
      SELECT pg_temp.check((SELECT count(*)=1 FROM audit_log WHERE action='officer_ad_hoc_static_post_created' AND target_id='${id(80)}'),'repair is audited');

      SELECT pg_temp.denied($q$ SELECT ${start(closedUnit, 'static_guarding')} $q$,'Static work unit contract is no longer active');
      SELECT pg_temp.check((SELECT count(*)=0 FROM shifts WHERE work_unit_id='${closedUnit}'),'ended contract creates no shift');

      SELECT ${start(patrolUnit, 'patrol')};
      SELECT pg_temp.check((SELECT count(*)=1 FROM generated_routes g JOIN shifts s ON s.id=g.shift_id WHERE s.work_unit_id='${patrolUnit}'),'patrol shifts still generate route stops');
      SELECT pg_temp.check((SELECT count(*)=0 FROM shift_stops st JOIN shifts s ON s.id=st.shift_id WHERE s.work_unit_id='${patrolUnit}'),'patrol shifts get no static post');

      SELECT pg_temp.check(NOT has_function_privilege('anon','public.start_ad_hoc_officer_shift(uuid,text,uuid,uuid,text)','EXECUTE'),'anon cannot prepare shifts');
      SELECT pg_temp.check(has_function_privilege('authenticated','public.start_ad_hoc_officer_shift(uuid,text,uuid,uuid,text)','EXECUTE'),'officers can prepare shifts');
    `;
    docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres'], sql);
  } finally {
    if (created) docker(['rm', '--force', container]);
  }
});
