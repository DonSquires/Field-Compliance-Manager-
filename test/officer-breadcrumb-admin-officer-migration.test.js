'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(join(__dirname, '../supabase/migrations/20261105153612_officer_breadcrumb_admin_officer.sql'), 'utf8');
const schema = readFileSync(join(__dirname, '../supabase/schema.sql'), 'utf8');
const start = schema.indexOf('CREATE OR REPLACE FUNCTION "public"."record_officer_breadcrumb"');
const end = schema.indexOf('$function$;', start) + '$function$;'.length;
const roleBefore = "AND up.role IN ('officer', 'scan_operator')";
const roleAfter = "AND up.role IN ('officer', 'admin_officer', 'scan_operator')";
const snapshotFunction = schema.slice(start, end);
const originalFunction = snapshotFunction.replace(roleAfter, roleBefore);

test('the breadcrumb migration changes exactly one existing role gate without altering grants', () => {
  assert.ok(start >= 0 && end > start, 'schema snapshot contains the breadcrumb function');
  assert.equal(originalFunction.split(roleBefore).length - 1, 1, 'pre-fix role gate occurs once');
  assert.match(migration, /pg_get_functiondef\(v_signature\)/);
  assert.match(migration, /expected role gate not found exactly once/);
  assert.match(migration, /EXECUTE replace\(v_definition, v_before, v_after\)/);
  assert.doesNotMatch(migration, /\b(?:GRANT|REVOKE|DROP)\b/i);
});

test('admin officers can record and replay their own breadcrumbs without weakening the existing gates', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-breadcrumb-role-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');

    const org = '0a000000-0000-4000-8000-000000000001';
    const branch = '0a000000-0000-4000-8000-000000000002';
    const adminOfficer = 'a0000000-0000-4000-8000-000000000001';
    const officer = 'a0000000-0000-4000-8000-000000000002';
    const scanOperator = 'a0000000-0000-4000-8000-000000000003';
    const inactive = 'a0000000-0000-4000-8000-000000000004';
    const admin = 'a0000000-0000-4000-8000-000000000005';
    const ownShift = 'b0000000-0000-4000-8000-000000000001';
    const otherShift = 'b0000000-0000-4000-8000-000000000002';
    const firstEvent = 'c0000000-0000-4000-8000-000000000001';
    const eventFor = (number) => `c0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    const call = (event, time = 'now()', lat = '-41', shift = 'NULL', activity = "'gps_update'") =>
      `SELECT * FROM public.record_officer_breadcrumb('${event}', ${time}, ${lat}, 172, NULL, NULL, NULL, ${activity}, ${shift}, NULL)`;
    const signature = 'public.record_officer_breadcrumb(uuid,timestamp with time zone,double precision,double precision,double precision,double precision,double precision,text,uuid,text)';
    const sql = `
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY, organization_id uuid, role text, deactivated_at timestamptz);
      CREATE TABLE public.shifts (id uuid PRIMARY KEY, officer_user_id uuid, organization_id uuid);
      CREATE TABLE public.officer_gps_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(),
        organization_id uuid NOT NULL, officer_id uuid NOT NULL, client_event_id uuid NOT NULL,
        recorded_at timestamptz NOT NULL, gps_lat double precision, gps_lng double precision,
        accuracy_meters double precision, heading double precision, speed_kmh double precision,
        activity_type text, shift_id uuid, physical_address text, detected_zone_id uuid,
        UNIQUE (officer_id, client_event_id)
      );
      CREATE FUNCTION public.resolve_context(double precision, double precision, uuid, uuid, timestamptz)
        RETURNS TABLE(matched_zone_id uuid) LANGUAGE sql AS $fn$ SELECT NULL::uuid $fn$;
      CREATE FUNCTION pg_temp.assert_true(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS
        $fn$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION '%', message; END IF; END $fn$;
      CREATE FUNCTION pg_temp.expect_error(statement text, expected text) RETURNS void LANGUAGE plpgsql AS
        $fn$ BEGIN
          BEGIN EXECUTE statement;
          EXCEPTION WHEN OTHERS THEN
            IF position(expected IN SQLERRM) = 0 THEN RAISE; END IF;
            RETURN;
          END;
          RAISE EXCEPTION 'Expected error: %', expected;
        END $fn$;
      ${originalFunction}
      REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION ${signature} TO authenticated, service_role;
      COMMENT ON FUNCTION ${signature} IS 'Synthetic retained comment';
      CREATE TEMP TABLE original_definition AS
        SELECT pg_get_functiondef('${signature}'::regprocedure) AS ddl,
          proacl::text AS acl, obj_description(oid, 'pg_proc') AS comment
        FROM pg_proc WHERE oid = '${signature}'::regprocedure;
      INSERT INTO public.user_profiles VALUES
        ('${adminOfficer}', '${org}', 'admin_officer', NULL),
        ('${officer}', '${org}', 'officer', NULL),
        ('${scanOperator}', '${org}', 'scan_operator', NULL),
        ('${inactive}', '${org}', 'admin_officer', now()),
        ('${admin}', '${org}', 'admin', NULL);
      INSERT INTO public.shifts VALUES
        ('${ownShift}', '${adminOfficer}', '${branch}'),
        ('${otherShift}', '${officer}', '${org}');

      SELECT set_config('request.jwt.claim.sub', '${adminOfficer}', false);
      SELECT pg_temp.expect_error($call$${call(firstEvent)}$call$, 'Active officer profile not found');
      SELECT set_config('request.jwt.claim.sub', '${officer}', false);
      SELECT pg_temp.assert_true(created, 'existing officer role must work before migration') FROM (${call(eventFor(2))}) receipt;

      ${migration}
      SELECT pg_temp.assert_true(
        pg_get_functiondef('${signature}'::regprocedure) = replace(ddl, $old$${roleBefore}$old$, $new$${roleAfter}$new$),
        'the complete function definition must differ only at the role gate'
      ) FROM original_definition;
      SELECT pg_temp.assert_true(
        proacl::text = original_definition.acl AND obj_description(oid, 'pg_proc') = original_definition.comment,
        'existing function grants and comment must be preserved'
      ) FROM pg_proc, original_definition WHERE oid = '${signature}'::regprocedure;
      SELECT pg_temp.assert_true(
        has_function_privilege('authenticated', '${signature}', 'EXECUTE')
        AND has_function_privilege('service_role', '${signature}', 'EXECUTE')
        AND NOT has_function_privilege('anon', '${signature}', 'EXECUTE'),
        'client grants must remain unchanged'
      );
      SELECT pg_temp.expect_error($migration$${migration}$migration$, 'expected role gate not found exactly once');

      SELECT set_config('request.jwt.claim.sub', '${adminOfficer}', false);
      SET ROLE authenticated;
      CREATE TEMP TABLE first_receipt AS ${call(firstEvent, 'now()', '-41', `'${ownShift}'::uuid`)};
      RESET ROLE;
      SELECT pg_temp.assert_true(created, 'active admin officer can create a breadcrumb') FROM first_receipt;
      CREATE TEMP TABLE replay_receipt AS ${call(firstEvent, 'now()', '-41', `'${ownShift}'::uuid`)};
      SELECT pg_temp.assert_true(
        first_receipt.id = replay_receipt.id AND NOT replay_receipt.created,
        'retry must return the original receipt without creating another record'
      ) FROM first_receipt, replay_receipt;
      SELECT pg_temp.assert_true(
        count(*) = 1 AND bool_and(organization_id = '${branch}' AND shift_id = '${ownShift}'),
        'the record belongs to the caller and the shift operating branch'
      ) FROM public.officer_gps_log WHERE officer_id = '${adminOfficer}' AND client_event_id = '${firstEvent}';
      SELECT pg_temp.expect_error($call$${call(eventFor(3), 'now()', '-41', `'${otherShift}'::uuid`)}$call$, 'Shift does not belong to the authenticated officer');
      SELECT pg_temp.expect_error($call$${call(eventFor(4), "now() - interval '25 hours'")}$call$, 'outside the accepted capture window');
      SELECT pg_temp.expect_error($call$${call(eventFor(5), "now() + interval '6 minutes'")}$call$, 'outside the accepted capture window');
      SELECT pg_temp.expect_error($call$${call(eventFor(6), 'now()', '91')}$call$, 'Invalid GPS coordinates');
      SELECT pg_temp.expect_error($call$${call(eventFor(7), 'now()', '-41', 'NULL', "'unknown'")}$call$, 'Unsupported breadcrumb activity type');

      SELECT set_config('request.jwt.claim.sub', '${scanOperator}', false);
      SELECT pg_temp.assert_true(created, 'scan operators remain authorised') FROM (${call(eventFor(8))}) receipt;
      SELECT set_config('request.jwt.claim.sub', '${officer}', false);
      SELECT pg_temp.assert_true(created, 'officers remain authorised') FROM (${call(eventFor(9))}) receipt;
      SELECT set_config('request.jwt.claim.sub', '${inactive}', false);
      SELECT pg_temp.expect_error($call$${call(eventFor(10))}$call$, 'Active officer profile not found');
      SELECT set_config('request.jwt.claim.sub', '${admin}', false);
      SELECT pg_temp.expect_error($call$${call(eventFor(11))}$call$, 'Active officer profile not found');
      SELECT set_config('request.jwt.claim.sub', '', false);
      SELECT pg_temp.expect_error($call$${call(eventFor(12))}$call$, 'Authentication required');
      SELECT pg_temp.assert_true((SELECT count(*) FROM public.officer_gps_log) = 4, 'rejected and replayed calls must not add records');
    `;
    docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], sql);
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
