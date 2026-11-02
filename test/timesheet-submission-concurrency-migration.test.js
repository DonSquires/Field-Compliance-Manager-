'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(
  path.join(__dirname, '../supabase/migrations/20261104100000_timesheet_submission_concurrency.sql'),
  'utf8',
);

test('concurrent overlapping timesheet submissions serialize and only one commits in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 90000,
}, async () => {
  const name = `fcm-timesheet-concurrency-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = (sql) => execFileSync('docker', [
    'exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
  ], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;

  try {
    docker([
      'run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5',
    ]);
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

    const orgId = '00000000-0000-4000-8000-000000000003';
    const staffId = '00000000-0000-4000-8000-000000000002';
    const userId = '00000000-0000-4000-8000-000000000001';
    const firstEventId = '00000000-0000-4000-8000-000000000011';
    const secondEventId = '00000000-0000-4000-8000-000000000012';

    const output = psql(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE EXTENSION dblink;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

      CREATE TABLE public.user_profiles (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, deactivated_at timestamptz
      );
      CREATE TABLE public.staff_profiles (
        id uuid PRIMARY KEY, user_id uuid, organization_id uuid NOT NULL
      );
      CREATE TABLE public.timesheets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL, staff_id uuid NOT NULL,
        period_start date NOT NULL, period_end date NOT NULL,
        scheduled_hours numeric, actual_hours numeric, overtime_hours numeric,
        adjustment_hours numeric, work_derived_hours numeric, work_summary jsonb,
        status text, notes text, submitted_at timestamptz, client_event_id uuid
      );
      CREATE TABLE public.timesheet_work_entries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL, timesheet_id uuid NOT NULL,
        source_type text, source_id uuid, work_status text, started_at timestamptz,
        ended_at timestamptz, calculated_minutes integer, metadata jsonb
      );
      CREATE TABLE public.shifts (
        officer_user_id uuid, scheduled_start timestamptz, scheduled_end timestamptz, status text
      );
      CREATE TABLE public.audit_log (
        organization_id uuid, actor_user_id uuid, action text, target_table text,
        target_id uuid, metadata jsonb
      );
      CREATE FUNCTION public.get_officer_timesheet_work(date, date)
      RETURNS TABLE(
        source_type text, source_id uuid, work_status text, started_at timestamptz,
        ended_at timestamptz, calculated_minutes integer, label text, metadata jsonb
      )
      LANGUAGE sql STABLE AS $$
        SELECT NULL::text, NULL::uuid, NULL::text, NULL::timestamptz,
          NULL::timestamptz, NULL::integer, NULL::text, NULL::jsonb WHERE false
      $$;
      CREATE FUNCTION public.submit_officer_timesheet_from_work(
        uuid, date, date, numeric DEFAULT 0, text DEFAULT NULL
      )
      RETURNS TABLE(id uuid, created boolean, submitted_at timestamptz,
        work_derived_hours numeric, actual_hours numeric, source_count integer)
      LANGUAGE sql AS $$
        SELECT NULL::uuid, false, NULL::timestamptz, NULL::numeric, NULL::numeric, NULL::integer WHERE false
      $$;
      REVOKE ALL ON FUNCTION public.submit_officer_timesheet_from_work(uuid, date, date, numeric, text)
        FROM PUBLIC, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.submit_officer_timesheet_from_work(uuid, date, date, numeric, text)
        TO authenticated, service_role;

      ${migration}

      CREATE FUNCTION public.try_submit_timesheet(
        p_client_event_id uuid, p_period_start date, p_period_end date
      ) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        BEGIN
          PERFORM 1 FROM public.submit_officer_timesheet_from_work(
            p_client_event_id, p_period_start, p_period_end
          );
          RETURN 'submitted';
        EXCEPTION WHEN OTHERS THEN
          RETURN SQLERRM;
        END;
      END $$;

      INSERT INTO public.user_profiles (id, organization_id) VALUES ('${userId}', '${orgId}');
      INSERT INTO public.staff_profiles (id, user_id, organization_id) VALUES ('${staffId}', '${userId}', '${orgId}');

      SELECT dblink_connect('first', 'host=127.0.0.1 dbname=postgres user=postgres application_name=fcm_timesheet_first');
      SELECT dblink_connect('second', 'host=127.0.0.1 dbname=postgres user=postgres application_name=fcm_timesheet_second');
      SELECT dblink_exec('first', 'BEGIN');
      SELECT setting FROM dblink('first',
        'SELECT set_config(''request.jwt.claim.sub'', ''${userId}'', false)') AS t(setting text);
      SELECT id FROM dblink('first',
        'SELECT id FROM public.submit_officer_timesheet_from_work(''${firstEventId}'', ''2026-01-01'', ''2026-01-07'')')
        AS t(id uuid);

      SELECT dblink_exec('second', 'BEGIN');
      SELECT setting FROM dblink('second',
        'SELECT set_config(''request.jwt.claim.sub'', ''${userId}'', false)') AS t(setting text);
      SELECT dblink_exec('second', 'SET lock_timeout = ''300ms''');

      DO $$
      DECLARE v_result text;
      BEGIN
        SELECT result INTO v_result
        FROM dblink('second',
          'SELECT public.try_submit_timesheet(''${secondEventId}'', ''2026-01-01'', ''2026-01-07'')')
          AS t(result text);
        IF v_result NOT LIKE '%lock timeout%' THEN
          RAISE EXCEPTION 'expected the second submission to wait on the staff lock, got: %', v_result;
        END IF;
      END $$;

      SELECT dblink_exec('first', 'COMMIT');
      SELECT dblink_exec('second', 'SET lock_timeout = 0');
      DO $$
      DECLARE
        v_result text;
      BEGIN
        SELECT result INTO v_result
        FROM dblink('second',
          'SELECT public.try_submit_timesheet(''${secondEventId}'', ''2026-01-01'', ''2026-01-07'')')
          AS t(result text);
        IF v_result <> 'A timesheet already overlaps this period' THEN
          RAISE EXCEPTION 'unexpected concurrent submission result: %', v_result;
        END IF;
      END $$;
      SELECT dblink_exec('second', 'ROLLBACK');
      SELECT dblink_disconnect('first');
      SELECT dblink_disconnect('second');

      DO $$
      BEGIN
        IF (SELECT count(*) FROM public.timesheets) <> 1 THEN
          RAISE EXCEPTION 'expected exactly one committed timesheet';
        END IF;
        IF has_function_privilege('anon',
          'public.submit_officer_timesheet_from_work(uuid,date,date,numeric,text)', 'EXECUTE') THEN
          RAISE EXCEPTION 'anonymous execution was unexpectedly granted';
        END IF;
        IF NOT has_function_privilege('authenticated',
          'public.submit_officer_timesheet_from_work(uuid,date,date,numeric,text)', 'EXECUTE') THEN
          RAISE EXCEPTION 'authenticated execution grant was not preserved';
        END IF;
      END $$;
      SELECT count(*) FROM public.timesheets;
    `);

    assert.equal(output.trim().split('\n').at(-1), '1', 'only the first overlapping submission commits');
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
