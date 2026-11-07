'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20261107211000_payroll_export_receipt_recovery.sql'), 'utf8');

test('payroll receipt migration builds on the current employer-payroll definition and keeps its grants', () => {
  assert.doesNotMatch(migration, /\bDROP\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  assert.match(migration, /public\.is_timesheet_payroll_admin\(p_organization_id\)/);
  assert.match(migration, /SECURITY DEFINER SET search_path = ''/);
  assert.match(migration, /hashtextextended\('payroll_export:'\|\|p_organization_id::text,0\)/);
  assert.match(migration, /status='paid'/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /GET DIAGNOSTICS v_updated = ROW_COUNT/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_payroll_export_batch\(uuid,uuid,date,date,text,text\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.create_payroll_export_batch\(uuid,uuid,date,date,text,text\) TO authenticated, service_role;/);
});

test('payroll receipts replay safely, bind their inputs and serialize overlapping exports in PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, async () => {
  const name = `fcm-payroll-receipt-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = (sql) => execFileSync('docker', [
    'exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A',
  ], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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
        ready = true; break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const org = '00000000-0000-4000-8000-000000000003';
    const otherOrg = '00000000-0000-4000-8000-000000000004';
    const actor = '00000000-0000-4000-8000-000000000001';
    const secondActor = '00000000-0000-4000-8000-000000000002';
    const request = '00000000-0000-4000-8000-000000000011';
    const concurrentRequest = '00000000-0000-4000-8000-000000000012';
    const losingRequest = '00000000-0000-4000-8000-000000000013';
    const legacyRequest = '00000000-0000-4000-8000-000000000014';
    const legacyBatch = '00000000-0000-4000-8000-000000000021';
    const output = psql(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE EXTENSION dblink;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE public.user_profiles (
        id uuid PRIMARY KEY, organization_id uuid, deactivated_at timestamptz, is_admin boolean DEFAULT true
      );
      CREATE FUNCTION public.is_timesheet_payroll_admin(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT auth.uid() IS NOT NULL AND EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid()
          AND organization_id=$1 AND is_admin AND deactivated_at IS NULL) $$;
      CREATE TABLE public.payroll_export_batches (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        exported_by uuid, period_from date NOT NULL, period_to date NOT NULL,
        format text NOT NULL DEFAULT 'csv', timesheet_count integer NOT NULL DEFAULT 0,
        total_hours numeric NOT NULL DEFAULT 0, notes text, exported_at timestamptz DEFAULT now()
      );
      CREATE TABLE public.timesheets (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        period_start date, period_end date, actual_hours numeric, work_derived_hours numeric,
        status text, payroll_export_batch_id uuid REFERENCES public.payroll_export_batches(id), blocker text
      );
      CREATE FUNCTION public.timesheet_dispatch_pay_review_blocker(uuid) RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT blocker FROM public.timesheets WHERE id=$1 $$;
      CREATE TABLE public.audit_log (
        organization_id uuid, actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb
      );
      CREATE FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text DEFAULT 'csv',text DEFAULT NULL)
      RETURNS TABLE(batch_id uuid,timesheet_count integer,total_hours numeric) LANGUAGE sql AS
        $$ SELECT NULL::uuid,NULL::integer,NULL::numeric WHERE false $$;
      REVOKE ALL ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) FROM PUBLIC,anon;
      GRANT EXECUTE ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) TO authenticated,service_role;
      INSERT INTO public.payroll_export_batches(organization_id,period_from,period_to)
        VALUES ('${org}','2025-12-01','2025-12-07');
      INSERT INTO public.payroll_export_batches(id,organization_id,exported_by,period_from,period_to,timesheet_count,total_hours)
        VALUES ('${legacyBatch}','${org}','${actor}','2025-11-01','2025-11-07',3,21);
      INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
        VALUES ('${org}','${actor}','payroll_export_batch_created','payroll_export_batches','${legacyBatch}',
          jsonb_build_object('client_request_id','${legacyRequest}','period_from','2025-11-01','period_to','2025-11-07','format','csv'));
      ${migration}
      CREATE FUNCTION public.try_export(p_request uuid,p_org uuid,p_from date,p_to date,p_format text DEFAULT 'csv',p_notes text DEFAULT NULL)
      RETURNS text LANGUAGE plpgsql AS $$
      DECLARE receipt record;
      BEGIN
        SELECT * INTO receipt FROM public.create_payroll_export_batch(p_request,p_org,p_from,p_to,p_format,p_notes);
        RETURN 'ok:' || receipt.batch_id;
      EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
      END $$;
      CREATE FUNCTION public.expect_export_error(p_expected text,p_request uuid,p_org uuid,p_from date,p_to date,p_format text DEFAULT 'csv',p_notes text DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql AS $$
      DECLARE result text;
      BEGIN
        result := public.try_export(p_request,p_org,p_from,p_to,p_format,p_notes);
        IF position(p_expected in result)=0 THEN RAISE EXCEPTION 'expected %, got %',p_expected,result; END IF;
      END $$;
      INSERT INTO public.user_profiles(id,organization_id) VALUES ('${actor}','${org}'),('${secondActor}','${org}');
      INSERT INTO public.timesheets(organization_id,period_start,period_end,actual_hours,work_derived_hours,status)
      VALUES ('${org}','2026-01-01','2026-01-07',8,8,'approved'),
        ('${org}','2026-01-01','2026-01-07',NULL,4,'approved'),
        ('${org}','2026-01-01','2026-01-07',9,9,'submitted'),
        ('${org}','2026-01-08','2026-01-14',6,6,'approved'),
        ('${otherOrg}','2026-01-01','2026-01-07',20,20,'approved');
      SELECT set_config('request.jwt.claim.sub','${actor}',false);
      DO $$
      DECLARE original record; replay record;
      BEGIN
        SELECT * INTO original FROM public.create_payroll_export_batch('${request}','${org}','2026-01-01','2026-01-07','csv',' payroll ');
        SELECT * INTO replay FROM public.create_payroll_export_batch('${request}','${org}','2026-01-01','2026-01-07','csv','payroll');
        IF original.batch_id<>replay.batch_id OR replay.timesheet_count<>2 OR replay.total_hours<>12 THEN
          RAISE EXCEPTION 'receipt did not replay the exact batch totals';
        END IF;
        IF (SELECT count(*) FROM public.audit_log)<>2 THEN RAISE EXCEPTION 'replay duplicated audit event'; END IF;
        SELECT * INTO replay FROM public.create_payroll_export_batch('${legacyRequest}','${org}','2025-11-01','2025-11-07','csv',NULL);
        IF replay.batch_id<>'${legacyBatch}' OR replay.timesheet_count<>3 OR replay.total_hours<>21 THEN
          RAISE EXCEPTION 'audit-only legacy receipt did not replay after backfill';
        END IF;
        IF (SELECT count(*) FROM public.timesheets WHERE status='paid')<>2 THEN RAISE EXCEPTION 'wrong timesheets changed'; END IF;
      END $$;
      SELECT public.expect_export_error('different export details','${request}','${org}','2026-01-01','2026-01-08','csv','payroll');
      SELECT public.expect_export_error('different export details','${request}','${org}','2026-01-01','2026-01-07','json','payroll');
      SELECT public.expect_export_error('different export details','${request}','${org}','2026-01-01','2026-01-07','csv','changed');
      SELECT set_config('request.jwt.claim.sub','${secondActor}',false);
      SELECT public.expect_export_error('different export details','${request}','${org}','2026-01-01','2026-01-07','csv','payroll');
      SELECT set_config('request.jwt.claim.sub','${actor}',false);
      SELECT public.expect_export_error('Active employer payroll administrator required','${request}','${otherOrg}','2026-01-01','2026-01-07');
      SELECT public.expect_export_error('Active employer payroll administrator required','${request}',NULL,'2026-01-01','2026-01-07');
      SELECT public.expect_export_error('valid export period are required','${request}','${org}',NULL,'2026-01-07');
      SELECT public.expect_export_error('Unsupported payroll export format','${request}','${org}','2026-01-01','2026-01-07',NULL);
      SELECT public.expect_export_error('A request ID and valid export period',NULL,'${org}','2026-01-01','2026-01-07');
      UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${actor}';
      SELECT public.expect_export_error('Active employer payroll administrator required','${request}','${org}','2026-01-01','2026-01-07');
      UPDATE public.user_profiles SET deactivated_at=NULL,is_admin=false WHERE id='${actor}';
      SELECT public.expect_export_error('Active employer payroll administrator required','${request}','${org}','2026-01-01','2026-01-07');
      UPDATE public.user_profiles SET is_admin=true WHERE id='${actor}';
      SELECT set_config('request.jwt.claim.sub','',false);
      SELECT public.expect_export_error('Active employer payroll administrator required','${request}','${org}','2026-01-01','2026-01-07');
      SELECT set_config('request.jwt.claim.sub','${actor}',false);
      UPDATE public.timesheets SET blocker='unreviewed dispatch pay' WHERE period_start='2026-01-08';
      SELECT public.expect_export_error('unreviewed dispatch pay','${concurrentRequest}','${org}','2026-01-08','2026-01-14');
      UPDATE public.timesheets SET blocker=NULL WHERE period_start='2026-01-08';
      SELECT dblink_connect('first','host=127.0.0.1 dbname=postgres user=postgres');
      SELECT dblink_connect('second','host=127.0.0.1 dbname=postgres user=postgres application_name=fcm_payroll_second');
      SELECT dblink_exec('first','BEGIN');
      SELECT value FROM dblink('first','SELECT set_config(''request.jwt.claim.sub'',''${actor}'',false)') AS t(value text);
      SELECT result FROM dblink('first','SELECT public.try_export(''${concurrentRequest}'',''${org}'',''2026-01-08'',''2026-01-14'')') AS t(result text);
      SELECT value FROM dblink('second','SELECT set_config(''request.jwt.claim.sub'',''${actor}'',false)') AS t(value text);
      SELECT dblink_send_query('second','SELECT public.try_export(''${losingRequest}'',''${org}'',''2026-01-08'',''2026-01-14'')');
      DO $$
      DECLARE deadline timestamptz := clock_timestamp()+interval '5 seconds';
      BEGIN
        LOOP
          EXIT WHEN EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm_payroll_second' AND wait_event_type='Lock');
          IF clock_timestamp()>deadline THEN RAISE EXCEPTION 'second export did not wait for the first'; END IF;
          PERFORM pg_sleep(0.01);
          PERFORM pg_stat_clear_snapshot();
        END LOOP;
      END $$;
      SELECT dblink_exec('first','COMMIT');
      DO $$
      DECLARE result text;
      BEGIN
        SELECT value INTO result FROM dblink_get_result('second') AS t(value text);
        IF result<>'No approved unexported timesheets in this period' THEN
          RAISE EXCEPTION 'competing export created a stale or empty batch: %',result;
        END IF;
      END $$;
      SELECT dblink_disconnect('first');
      SELECT dblink_disconnect('second');
      INSERT INTO public.timesheets(organization_id,period_start,period_end,actual_hours,status)
        VALUES ('${org}','2026-01-15','2026-01-21',2,'approved');
      CREATE FUNCTION public.skip_synthetic_payroll_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.period_start='2026-01-15' THEN RETURN NULL; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER skip_synthetic_payroll_update BEFORE UPDATE ON public.timesheets
        FOR EACH ROW EXECUTE FUNCTION public.skip_synthetic_payroll_update();
      SELECT public.expect_export_error('timesheet count could not be confirmed','${losingRequest}','${org}','2026-01-15','2026-01-21');
      DO $$
      DECLARE receipt record;
      BEGIN
        SELECT * INTO receipt FROM public.create_payroll_export_batch('${concurrentRequest}','${org}','2026-01-08','2026-01-14');
        IF receipt.timesheet_count<>1 OR receipt.total_hours<>6 THEN RAISE EXCEPTION 'concurrent receipt totals changed'; END IF;
        IF (SELECT count(*) FROM public.payroll_export_batches)<>4 OR (SELECT count(*) FROM public.audit_log)<>3 THEN
          RAISE EXCEPTION 'duplicate batch or audit event persisted';
        END IF;
        IF (SELECT count(*) FROM public.payroll_export_batches WHERE client_request_id IS NULL)<>1 THEN
          RAISE EXCEPTION 'legacy batch provenance changed';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.timesheets WHERE period_start='2026-01-15'
          AND status='approved' AND payroll_export_batch_id IS NULL) THEN
          RAISE EXCEPTION 'unconfirmed row update was not rolled back';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.timesheets WHERE organization_id='${otherOrg}'
          AND status='approved' AND payroll_export_batch_id IS NULL) THEN
          RAISE EXCEPTION 'another organization was changed';
        END IF;
        IF has_function_privilege('anon','public.create_payroll_export_batch(uuid,uuid,date,date,text,text)','EXECUTE')
          OR NOT has_function_privilege('authenticated','public.create_payroll_export_batch(uuid,uuid,date,date,text,text)','EXECUTE') THEN
          RAISE EXCEPTION 'existing execution grants changed';
        END IF;
      END $$;
      SELECT 'payroll-export-ok';
    `);
    assert.equal(output.trim().split('\n').at(-1), 'payroll-export-ok');
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
