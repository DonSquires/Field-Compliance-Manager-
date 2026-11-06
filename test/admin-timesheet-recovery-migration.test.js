'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261106021912_admin_scheduled_timesheet_recovery.sql'), 'utf8');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const table = (name) => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.notEqual(start, -1, name);
  return schema.slice(start, schema.indexOf('\n);', start) + 3);
};
const fn = (name) => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.notEqual(start, -1, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
};
test('manual recovery shares the officer overlap lock and never writes attendance or employment rates', () => {
  assert.match(migration, /'timesheet_submission:' \|\| v_staff.id::text/);
  assert.match(migration, /'evidence_kind','manual_admin'/);
  assert.match(migration, /work_derived_hours,adjustment_hours/);
  assert.doesNotMatch(migration, /UPDATE public\.(?:shifts|staff_profiles|rate_rules|shift_breaks)\b/i);
  assert.match(migration, /source_version IS DISTINCT FROM/);
  assert.match(migration, /OLD.status<>'branch_checked'/);
});

test('scheduled recovery, scoped pay, payroll export and finance run in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-admin-timesheet-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const org = '00000000-0000-4000-8000-000000000001';
  const admin = '00000000-0000-4000-8000-000000000002';
  const other = '00000000-0000-4000-8000-000000000003';
  const officer = '00000000-0000-4000-8000-000000000004';
  const slot = '00000000-0000-4000-8000-000000000005';
  const shift = '00000000-0000-4000-8000-000000000006';
  const request = '00000000-0000-4000-8000-000000000007';
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    sql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,employer_organization_id uuid,deactivated_at timestamptz,role text);
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,role_code text);
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=$1 AND role='admin' AND deactivated_at IS NULL) $$;
      CREATE TABLE public.audit_log(id uuid DEFAULT gen_random_uuid(),organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
      ${['timesheets','roster_slots','shifts','shift_breaks','rate_rules','payroll_export_batches',
        'finance_pl_periods','service_agreements','service_agreement_locations','service_agreement_modules',
        'finance_service_costs','finance_labour_cost_postings','cost_centres'].map(table).join('\n')}
      ALTER TABLE public.roster_slots ADD COLUMN planned_break_minutes integer NOT NULL DEFAULT 0,ADD COLUMN break_unpaid boolean NOT NULL DEFAULT false;
      CREATE FUNCTION public.timesheet_dispatch_pay_review_blocker(uuid) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
      ${fn('post_finance_timesheet_labour_cost')}
      ${fn('create_payroll_export_batch')}
      ${migration}
      CREATE FUNCTION public.expect_error(p_sql text,p_message text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
          IF SQLERRM NOT ILIKE '%'||p_message||'%' THEN RAISE; END IF;
          RETURN;
        END;
        RAISE EXCEPTION 'Expected error: %',p_message;
      END $$;
      INSERT INTO public.user_profiles VALUES
        ('${admin}','${org}','${org}',NULL,'admin'),('${other}','${org}','${org}',NULL,'admin'),
        ('${officer}','${org}','${org}',NULL,'officer');
      INSERT INTO public.staff_profiles VALUES('${officer}','${officer}','${org}','GUARD');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status)
        VALUES('${shift}','${org}','${officer}','site_guard','2026-10-01 08:00+13','2026-10-01 16:00+13','missed');
      INSERT INTO public.roster_slots(id,organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,linked_shift_id,client_request_id,planned_break_minutes,break_unpaid)
        VALUES('${slot}','${org}',gen_random_uuid(),'${officer}','2026-10-01 08:00+13','2026-10-01 16:00+13','published','${shift}',gen_random_uuid(),30,true);
      SELECT set_config('request.jwt.claim.sub','${admin}',false);
      CREATE TABLE request_rows AS SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object(
        'reviewed_start',p.scheduled_start,'reviewed_end',p.scheduled_end,'unpaid_break_minutes',15)) AS rows
        FROM public.preview_scheduled_timesheet('${officer}','2026-10-01','2026-10-01') p;
      SELECT public.expect_error(
        $$SELECT public.recover_scheduled_timesheet('${request}','${officer}','2026-10-01','2026-10-01',(SELECT rows FROM request_rows),0,'')$$,'reason');
      SELECT public.expect_error(
        $$SELECT public.recover_scheduled_timesheet(gen_random_uuid(),'${officer}','2026-10-01','2026-10-01',jsonb_set((SELECT rows FROM request_rows),'{0,source_version}','"stale"'),0,'Stale roster')$$,'source changed');
      SELECT public.expect_error(
        $$SELECT public.recover_scheduled_timesheet(gen_random_uuid(),'${officer}','2026-10-01','2026-10-01',(SELECT rows||rows FROM request_rows),0,'Duplicate sources')$$,'Duplicate scheduled');
      SELECT public.recover_scheduled_timesheet('${request}','${officer}','2026-10-01','2026-10-01',(SELECT rows FROM request_rows),0,'Supervisor confirmed time');
      SELECT public.recover_scheduled_timesheet('${request}','${officer}','2026-10-01','2026-10-01',(SELECT rows FROM request_rows),0,'Supervisor confirmed time');
    `);
    assert.equal(sql('SELECT count(*) FROM public.timesheets').trim(), '1', 'replay creates no duplicate');
    assert.equal(sql("SELECT actual_hours||':'||work_derived_hours||':'||adjustment_hours FROM public.timesheets").trim(), '7.75:0.00:7.75');
    assert.equal(sql("SELECT actual_start IS NULL AND actual_end IS NULL AND status='missed' FROM public.shifts").trim(), 't', 'no fabricated attendance');
    assert.equal(sql(`SELECT set_config('request.jwt.claim.sub','${admin}',false);
      SELECT review_status FROM public.get_timesheet_break_review((SELECT id FROM public.timesheets));`).trim().split('\n').pop(), 'not_recorded');
    sql(`SELECT set_config('request.jwt.claim.sub','${admin}',false);
      BEGIN;
      INSERT INTO public.shift_breaks(organization_id,shift_id,officer_user_id,break_type,started_at,ended_at,is_paid,client_request_id)
        VALUES('${org}','${shift}','${officer}','meal','2026-10-01 12:00+13','2026-10-01 12:15+13',false,gen_random_uuid());
      DO $$ BEGIN
        IF (SELECT review_status FROM public.get_timesheet_break_review((SELECT id FROM public.timesheets)))<>'short'
          THEN RAISE EXCEPTION 'Short break evidence missing'; END IF;
      END $$;
      UPDATE public.shift_breaks SET ended_at='2026-10-01 12:45+13';
      DO $$ BEGIN
        IF (SELECT review_status FROM public.get_timesheet_break_review((SELECT id FROM public.timesheets)))<>'long'
          THEN RAISE EXCEPTION 'Long break evidence missing'; END IF;
        IF (SELECT actual_hours FROM public.timesheets)<>7.75 THEN RAISE EXCEPTION 'Break plan silently changed manual payroll hours'; END IF;
      END $$;
      ROLLBACK;
    `);
    sql(`SELECT set_config('request.jwt.claim.sub','${admin}',false);
      SELECT public.expect_error($$SELECT public.recover_scheduled_timesheet('${request}','${officer}','2026-10-01','2026-10-01',(SELECT rows FROM request_rows),0,'Different reason')$$,'different recovery');
      SELECT public.expect_error($$SELECT public.recover_scheduled_timesheet(gen_random_uuid(),'${officer}','2026-10-01','2026-10-01',(SELECT rows FROM request_rows),0,'Duplicate period')$$,'overlaps');
      SELECT public.expect_error($$UPDATE public.timesheets SET status='approved',approved_by='${admin}'$$,'branch check');
      INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,pay_code,role_code)
        VALUES('${org}','pay','Fixture hourly base','hourly',30,'NORMAL','GUARD');
      BEGIN;
      SELECT public.correct_timesheet_pay('00000000-0000-4000-8000-000000000060',(SELECT id FROM public.timesheets),1,NULL,42.5,'Rate only');
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.timesheet_effective_pay((SELECT id FROM public.timesheets))
          WHERE pay_code='NORMAL' AND hourly_rate=42.5) THEN RAISE EXCEPTION 'Rate-only override lost base pay code'; END IF;
      END $$;
      ROLLBACK;
      BEGIN;
      SELECT public.correct_timesheet_pay('00000000-0000-4000-8000-000000000061',(SELECT id FROM public.timesheets),1,'SPECIAL',NULL,'Code only');
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.timesheet_effective_pay((SELECT id FROM public.timesheets))
          WHERE pay_code='SPECIAL' AND hourly_rate=30) THEN RAISE EXCEPTION 'Code-only override lost base hourly rate'; END IF;
      END $$;
      ROLLBACK;
      SELECT public.correct_timesheet_pay('00000000-0000-4000-8000-000000000008',(SELECT id FROM public.timesheets),1,'SPECIAL',42.5,'One shift premium');
      SELECT public.correct_timesheet_pay('00000000-0000-4000-8000-000000000008',(SELECT id FROM public.timesheets),1,'SPECIAL',42.5,'One shift premium');
      BEGIN;
      SELECT public.correct_timesheet_pay('00000000-0000-4000-8000-000000000062',(SELECT id FROM public.timesheets),2,NULL,NULL,'Clear overrides');
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.timesheet_effective_pay((SELECT id FROM public.timesheets))
          WHERE pay_code='NORMAL' AND hourly_rate=30) THEN RAISE EXCEPTION 'Clearing overrides did not restore base rule'; END IF;
      END $$;
      ROLLBACK;
      SELECT public.expect_error($$SELECT public.correct_timesheet_pay(gen_random_uuid(),(SELECT id FROM public.timesheets),1,'SPECIAL',50,'Stale')$$,'changed');
      UPDATE public.timesheets SET status='branch_checked',branch_reviewed_by='${admin}';
      SELECT public.expect_error($$UPDATE public.timesheets SET status='approved',approved_by='${admin}'$$,'different corporate');
      SELECT set_config('request.jwt.claim.sub','${other}',false);
      UPDATE public.timesheets SET status='approved',approved_by='${other}';
      SELECT public.create_payroll_export_batch('00000000-0000-4000-8000-000000000020','${org}','2026-10-01','2026-10-01','csv');
      SELECT public.create_payroll_export_batch('00000000-0000-4000-8000-000000000020','${org}','2026-10-01','2026-10-01','csv');
    `);
    const snapshot = JSON.parse(sql('SELECT payroll_snapshot FROM public.timesheets').trim());
    assert.equal(snapshot.pay_code, 'SPECIAL');
    assert.equal(Number(snapshot.hourly_rate), 42.5);
    assert.equal(Number(snapshot.gross_amount), 329.38);
    assert.equal(sql('SELECT count(*) FROM public.payroll_export_batches').trim(), '1', 'export replay has one receipt');
    sql(`SELECT set_config('request.jwt.claim.sub','${other}',false);
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name)
        VALUES('00000000-0000-4000-8000-000000000030','${org}',gen_random_uuid(),'Fixture agreement');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id)
        VALUES('00000000-0000-4000-8000-000000000031','00000000-0000-4000-8000-000000000030');
      UPDATE public.shifts SET service_agreement_location_id='00000000-0000-4000-8000-000000000031' WHERE id='${shift}';
      INSERT INTO public.finance_pl_periods(id,organization_id,name,period_start,period_end)
        VALUES('00000000-0000-4000-8000-000000000032','${org}','Fixture month','2026-10-01','2026-10-31');
      SELECT public.post_finance_timesheet_labour_cost((SELECT id FROM public.timesheets),
        '00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000030');
      SELECT public.post_finance_timesheet_labour_cost((SELECT id FROM public.timesheets),
        '00000000-0000-4000-8000-000000000032','00000000-0000-4000-8000-000000000030');
      SELECT public.expect_error($$UPDATE public.timesheets SET hourly_rate_override=99$$,'immutable');
    `);
    assert.equal(Number(sql('SELECT hourly_rate FROM public.finance_labour_cost_postings').trim()), 42.5, 'finance uses actual timesheet override');
    assert.equal(sql('SELECT total_cost FROM public.finance_service_costs').trim(), '329.38');
    assert.equal(sql('SELECT amount FROM public.rate_rules').trim(), '30', 'shared employment/pay rule is unchanged');
    sql(`SELECT set_config('request.jwt.claim.sub','${admin}',false);
      CREATE EXTENSION dblink;
      INSERT INTO public.roster_slots(id,organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,client_request_id)
        VALUES('00000000-0000-4000-8000-000000000040','${org}',gen_random_uuid(),'${officer}',
          '2026-10-02 08:00+13','2026-10-02 16:00+13','published',gen_random_uuid());
      CREATE TABLE concurrent_rows AS SELECT jsonb_agg(to_jsonb(p)||jsonb_build_object(
        'reviewed_start',p.scheduled_start,'reviewed_end',p.scheduled_end,'unpaid_break_minutes',0)) AS rows
        FROM public.preview_scheduled_timesheet('${officer}','2026-10-02','2026-10-02') p;
      CREATE FUNCTION public.try_concurrent_recovery(p_request uuid) RETURNS text LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM set_config('request.jwt.claim.sub','${admin}',true);
        PERFORM public.recover_scheduled_timesheet(p_request,'${officer}','2026-10-02','2026-10-02',
          (SELECT rows FROM concurrent_rows),0,'Concurrent recovery');
        RETURN 'recovered';
      EXCEPTION WHEN OTHERS THEN RETURN SQLERRM;
      END $$;
      SELECT dblink_connect('first','host=127.0.0.1 dbname=postgres user=postgres application_name=fcm_manual_first');
      SELECT dblink_connect('second','host=127.0.0.1 dbname=postgres user=postgres application_name=fcm_manual_second');
      SELECT dblink_exec('first','BEGIN');
      SELECT * FROM dblink('first',$$SELECT public.try_concurrent_recovery('00000000-0000-4000-8000-000000000041')$$) AS result(value text);
      SELECT dblink_send_query('second',$$SELECT public.try_concurrent_recovery('00000000-0000-4000-8000-000000000042')$$);
      DO $$ DECLARE waiting boolean:=false; BEGIN
        FOR attempt IN 1..100 LOOP
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='fcm_manual_second' AND wait_event_type='Lock') INTO waiting;
          EXIT WHEN waiting; PERFORM pg_sleep(0.01);
        END LOOP;
        IF NOT waiting THEN RAISE EXCEPTION 'Second recovery must wait on the shared staff lock'; END IF;
      END $$;
      SELECT dblink_exec('first','COMMIT');
      CREATE TABLE concurrent_result AS SELECT value FROM dblink_get_result('second') AS result(value text);
      SELECT dblink_disconnect('first'); SELECT dblink_disconnect('second');
      GRANT USAGE ON SCHEMA public,auth TO authenticated;
      GRANT SELECT,UPDATE ON public.timesheets TO authenticated;
      SET ROLE authenticated;
      SELECT public.expect_error($$UPDATE public.timesheets SET pay_code_override='DIRECT' WHERE period_start='2026-10-02'$$,'governed payroll');
      RESET ROLE;
    `);
    assert.match(sql('SELECT value FROM concurrent_result'), /already overlaps/, 'concurrent overlapping recovery fails closed');
    assert.equal(sql("SELECT count(*) FROM public.timesheets WHERE period_start='2026-10-02'").trim(), '1');
    assert.equal(sql("SELECT has_function_privilege('anon','public.recover_scheduled_timesheet(uuid,uuid,date,date,jsonb,numeric,text)','EXECUTE')").trim(), 'f');
    sql(`SELECT set_config('request.jwt.claim.sub','${officer}',false);
      SELECT public.expect_error($$SELECT * FROM public.preview_scheduled_timesheet('${officer}','2026-10-01','2026-10-01')$$,'payroll administrator');
      SELECT public.expect_error($$SELECT public.correct_timesheet_pay(gen_random_uuid(),(SELECT id FROM public.timesheets WHERE period_start='2026-10-01'),1,'HACK',1,'No authority')$$,'payroll administrator');
      SELECT set_config('request.jwt.claim.sub','${admin}',false);
      UPDATE public.user_profiles SET employer_organization_id=NULL WHERE id='${admin}';
      SELECT public.expect_error($$SELECT * FROM public.preview_scheduled_timesheet('${officer}','2026-10-01','2026-10-01')$$,'payroll administrator');
    `);
  } finally {
    if (created) docker(['rm', '--force', '--volumes', name]);
  }
});
