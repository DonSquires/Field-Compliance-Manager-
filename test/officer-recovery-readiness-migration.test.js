'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(join(__dirname, '../supabase/migrations/20261105165648_officer_recovery_readiness.sql'), 'utf8');
const schema = readFileSync(join(__dirname, '../supabase/schema.sql'), 'utf8');
const start = schema.indexOf('CREATE OR REPLACE FUNCTION "public"."get_shift_end_readiness"');
const end = schema.indexOf('$function$;', start) + '$function$;'.length;
const original = schema.slice(start, end);

test('recovery readiness delegates authorization and explicitly projects only safe fields', () => {
  assert.ok(start >= 0 && end > start, 'live schema snapshot contains the existing readiness function');
  assert.match(migration, /security invoker/i);
  assert.match(migration, /with source as materialized/i);
  assert.match(migration, /public\.get_shift_end_readiness\(p_shift_id\)/);
  assert.match(migration, /'open_stops', '\[\]'::jsonb/);
  assert.match(migration, /'blockers', '\[\]'::jsonb/);
  assert.doesNotMatch(migration, /'service_type'/);
  assert.match(migration, /revoke all on function public\.get_officer_recovery_readiness\(uuid\) from public, anon, authenticated, service_role/i);
  assert.match(migration, /grant execute on function public\.get_officer_recovery_readiness\(uuid\) to postgres, authenticated/i);
  assert.doesNotMatch(migration, /security definer|jsonb_set|source\.readiness\s*\|\|/i);
});

test('recovery readiness withholds stop names and preserves the existing authorization gates', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-recovery-readiness-${randomUUID()}`;
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
    const otherOrg = '0a000000-0000-4000-8000-000000000002';
    const officer = 'a0000000-0000-4000-8000-000000000001';
    const otherOfficer = 'a0000000-0000-4000-8000-000000000002';
    const admin = 'a0000000-0000-4000-8000-000000000003';
    const shift = 'b0000000-0000-4000-8000-000000000001';
    const otherShift = 'b0000000-0000-4000-8000-000000000002';
    const site = 'c0000000-0000-4000-8000-000000000001';
    const stop = 'd0000000-0000-4000-8000-000000000001';
    const withFutureField = original.replace(
      "'shift_id', v_shift.id,",
      "'future_private', 'PRIVATE_FUTURE_FIELD', 'shift_id', v_shift.id,",
    );
    assert.notEqual(withFutureField, original, 'synthetic future field was inserted into the real function body');

    const sql = `
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $fn$ SELECT auth.uid() = '${admin}'::uuid AND $1 = '${org}'::uuid $fn$;
      CREATE TABLE public.shifts (
        id uuid PRIMARY KEY, officer_user_id uuid NOT NULL, organization_id uuid NOT NULL,
        status text NOT NULL, service_type text NOT NULL, scheduled_end timestamptz NOT NULL,
        actual_start timestamptz
      );
      CREATE TABLE public.client_sites (id uuid PRIMARY KEY, name text);
      CREATE TABLE public.location_zones (id uuid PRIMARY KEY, name text);
      CREATE TABLE public.shift_stops (
        id uuid PRIMARY KEY, shift_id uuid, status text, stop_order integer,
        site_id uuid, zone_id uuid, module_key text
      );
      CREATE TABLE public.shift_stop_modules (shift_stop_id uuid, is_required boolean, status text);
      CREATE TABLE public.dispatch_jobs (shift_id uuid, status text);
      CREATE TABLE public.welfare_alerts (shift_id uuid, status text);
      CREATE TABLE public.shift_debriefs (shift_id uuid, officer_user_id uuid);
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
      ${withFutureField}
      REVOKE ALL ON FUNCTION public.get_shift_end_readiness(uuid) FROM PUBLIC, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.get_shift_end_readiness(uuid) TO authenticated, service_role;
      ${migration}
      INSERT INTO public.shifts VALUES
        ('${shift}', '${officer}', '${org}', 'in_progress', 'PRIVATE_SERVICE_MARKER', '2026-08-28T04:00:00Z', '2026-08-27T20:00:00Z'),
        ('${otherShift}', '${otherOfficer}', '${otherOrg}', 'in_progress', 'patrol', '2026-08-28T04:00:00Z', NULL);
      INSERT INTO public.client_sites VALUES ('${site}', 'PRIVATE_STOP_MARKER');
      INSERT INTO public.shift_stops VALUES ('${stop}', '${shift}', 'pending', 1, '${site}', NULL, 'general_patrol');
      INSERT INTO public.shift_stop_modules VALUES ('${stop}', true, 'pending');
      INSERT INTO public.dispatch_jobs VALUES ('${shift}', 'assigned');
      INSERT INTO public.welfare_alerts VALUES ('${shift}', 'active');

      SELECT pg_temp.assert_true(NOT has_function_privilege('anon', 'public.get_officer_recovery_readiness(uuid)', 'EXECUTE'), 'anon must not execute');
      SELECT pg_temp.assert_true(NOT has_function_privilege('service_role', 'public.get_officer_recovery_readiness(uuid)', 'EXECUTE'), 'service role must not execute');
      SELECT pg_temp.assert_true(has_function_privilege('authenticated', 'public.get_officer_recovery_readiness(uuid)', 'EXECUTE'), 'authenticated execution is required');

      SELECT set_config('request.jwt.claim.sub', '${officer}', false);
      SET ROLE authenticated;
      SELECT pg_temp.assert_true(public.get_shift_end_readiness('${shift}')::text LIKE '%PRIVATE_STOP_MARKER%', 'raw source contains the private stop');
      SELECT pg_temp.assert_true(public.get_shift_end_readiness('${shift}')::text LIKE '%PRIVATE_SERVICE_MARKER%', 'raw source contains the private service label');
      SELECT pg_temp.assert_true(public.get_shift_end_readiness('${shift}')::text LIKE '%PRIVATE_FUTURE_FIELD%', 'raw source contains a future private field');
      SELECT pg_temp.assert_true(public.get_officer_recovery_readiness('${shift}')->'open_stops' = '[]'::jsonb, 'stop names are withheld');
      SELECT pg_temp.assert_true(public.get_officer_recovery_readiness('${shift}')->'blockers' = '[]'::jsonb, 'free-text blockers are withheld');
      SELECT pg_temp.assert_true(public.get_officer_recovery_readiness('${shift}')::text NOT LIKE '%PRIVATE_%', 'no private marker reaches the projection');
      SELECT pg_temp.assert_true(NOT (public.get_officer_recovery_readiness('${shift}') ? 'future_private'), 'unknown future fields are not forwarded');
      SELECT pg_temp.assert_true(NOT (public.get_officer_recovery_readiness('${shift}') ? 'service_type'), 'unreviewed service labels are not forwarded');
      SELECT pg_temp.assert_true(
        (public.get_officer_recovery_readiness('${shift}')->>'open_stop_count')::integer = 1
        AND (public.get_officer_recovery_readiness('${shift}')->>'open_required_task_count')::integer = 1
        AND (public.get_officer_recovery_readiness('${shift}')->>'open_dispatch_job_count')::integer = 1
        AND (public.get_officer_recovery_readiness('${shift}')->>'active_welfare_alert_count')::integer = 1
        AND NOT (public.get_officer_recovery_readiness('${shift}')->>'can_end_after_debrief')::boolean,
        'counts and completion gates are retained'
      );
      SELECT pg_temp.expect_error(
        'SELECT public.get_officer_recovery_readiness(''${otherShift}'')',
        'Only the assigned officer or an administrator can review this shift'
      );
      RESET ROLE;
      SELECT set_config('request.jwt.claim.sub', '${admin}', false);
      SET ROLE authenticated;
      SELECT pg_temp.assert_true(public.get_officer_recovery_readiness('${shift}')->>'shift_id' = '${shift}', 'same-organisation administrator retains access');
      SELECT pg_temp.expect_error(
        'SELECT public.get_officer_recovery_readiness(''${otherShift}'')',
        'Only the assigned officer or an administrator can review this shift'
      );
      RESET ROLE;
      SELECT set_config('request.jwt.claim.sub', '', false);
      SET ROLE authenticated;
      SELECT pg_temp.expect_error(
        'SELECT public.get_officer_recovery_readiness(''${shift}'')',
        'Authentication required'
      );
    `;
    docker(['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
