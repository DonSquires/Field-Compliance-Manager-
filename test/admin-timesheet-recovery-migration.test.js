'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261106120100_admin_scheduled_timesheet_recovery.sql'), 'utf8');
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
// After the live catalog refresh the snapshot already contains this migration's
// in-place rewrite; restore the pre-migration rate lookup so the test replays it.
const preMigrationFinanceFn = () => fn('post_finance_timesheet_labour_cost')
  .replace('  SELECT p.rate_rule_id, p.hourly_rate AS amount INTO v_rate FROM public.timesheet_effective_pay(v_sheet.id) p;', `  SELECT r.id AS rate_rule_id, r.amount
  INTO v_rate
  FROM public.rate_rules r
  WHERE r.organization_id = v_org
    AND r.rule_kind = 'pay'
    AND r.rate_type = 'hourly'
    AND r.active
    AND (r.role_code IS NULL OR r.role_code = v_staff.role_code)
    AND (r.service_type IS NULL OR r.service_type = v_shift.service_type)
    AND (r.effective_from IS NULL OR r.effective_from <= v_sheet.period_start)
    AND (r.effective_to IS NULL OR r.effective_to >= v_sheet.period_start)
  ORDER BY
    (r.role_code IS NOT NULL)::integer DESC,
    (r.service_type IS NOT NULL)::integer DESC,
    r.priority DESC,
    r.effective_from DESC NULLS LAST
  LIMIT 1;`)
  .replace("CASE WHEN v_rate.amount IS NULL THEN 'unresolved' ELSE 'resolved' END", "CASE WHEN v_rate.rate_rule_id IS NULL THEN 'unresolved' ELSE 'resolved' END")
  .replaceAll("'pay_code_override', v_sheet.pay_code_override, 'pay_override_reason', v_sheet.pay_override_reason, 'hourly_rate', COALESCE(v_rate.amount, 0)", "'hourly_rate', COALESCE(v_rate.amount, 0)");
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
  const branchManager = '00000000-0000-4000-8000-000000000008';
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
      CREATE TABLE public.organizations(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,employer_organization_id uuid,deactivated_at timestamptz,role text);
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,role_code text);
      CREATE TABLE public.dispatch_resources(id uuid,assigned_officer_id uuid);
      CREATE TABLE public.dispatch_jobs(id uuid,organization_id uuid,dispatch_resource_id uuid,status text,
        shift_id uuid,shift_stop_id uuid,job_type text,on_scene_at timestamptz,en_route_at timestamptz,
        acknowledged_at timestamptz,dispatched_at timestamptz,created_at timestamptz,completed_at timestamptz);
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=$1 AND role='admin' AND deactivated_at IS NULL) $$;
      CREATE FUNCTION public.user_can_operate_organization(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=p_org AND role='branch_manager' AND deactivated_at IS NULL) $$;
      CREATE FUNCTION public.user_can_exercise_branch_authority(p_org uuid,p_target uuid,p_area text,p_level text DEFAULT 'approve') RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT p_area='timesheet_local_review' AND EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=p_org AND role='branch_manager' AND deactivated_at IS NULL) AND p_target IN('${officer}'::uuid,'${other}'::uuid) $$;
      CREATE TABLE public.audit_log(id uuid DEFAULT gen_random_uuid(),organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
      ${['timesheets','roster_slots','shifts','shift_breaks','rate_rules','payroll_export_batches',
        'finance_pl_periods','service_agreements','service_agreement_locations','service_agreement_modules',
        'finance_service_costs','finance_labour_cost_postings','cost_centres','timesheet_work_entries'].map(table).join('\n')}
      ALTER TABLE public.roster_slots ADD COLUMN IF NOT EXISTS planned_break_minutes integer NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS break_unpaid boolean NOT NULL DEFAULT false;
      ALTER TABLE public.shifts ADD PRIMARY KEY(id);
      ALTER TABLE public.user_profiles ADD COLUMN display_name text;
      CREATE TABLE public.staff_branch_authorisations(user_id uuid,branch_org_id uuid,status text);
      CREATE TABLE public.shift_stop_actions(shift_id uuid);
      CREATE TABLE public.officer_gps_log(shift_id uuid);
      CREATE TABLE public.shift_debriefs(shift_id uuid);
      ALTER TABLE public.timesheets DROP COLUMN IF EXISTS recovery_request,DROP COLUMN IF EXISTS pay_code_override,
        DROP COLUMN IF EXISTS hourly_rate_override,DROP COLUMN IF EXISTS pay_override_reason,
        DROP COLUMN IF EXISTS payroll_snapshot,DROP COLUMN IF EXISTS revision;
      CREATE FUNCTION public.timesheet_dispatch_pay_review_blocker(uuid) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;
      ${preMigrationFinanceFn()}
      ${fn('create_payroll_export_batch')}
      ${migration}
      ${fs.readFileSync(path.join(root, 'supabase/migrations/20261108190000_timesheet_roster_tolerances.sql'), 'utf8')}
      ${fn('submit_officer_timesheet_from_work')}
      ${fn('resubmit_rejected_timesheet_from_work')}
      ${fn('get_branch_timesheet_queue')}
      ${fs.readFileSync(path.join(root, 'supabase/migrations/20261108220000_shift_timesheet_review.sql'), 'utf8')}
      CREATE FUNCTION public.expect_error(p_sql text,p_message text) RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN
          IF SQLERRM NOT ILIKE '%'||p_message||'%' THEN RAISE; END IF;
          RETURN;
        END;
        RAISE EXCEPTION 'Expected error: %',p_message;
      END $$;
      INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,deactivated_at,role) VALUES
        ('${admin}','${org}','${org}',NULL,'admin'),('${other}','${org}','${org}',NULL,'admin'),
        ('${branchManager}','${org}','${org}',NULL,'branch_manager'),
        ('${officer}','${org}','${org}',NULL,'officer');
      INSERT INTO public.staff_profiles VALUES('${officer}','${officer}','${org}','GUARD');
      INSERT INTO public.organizations VALUES('${org}');
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
    sql(`
      BEGIN;
      SET LOCAL TIME ZONE 'Pacific/Auckland';
      SELECT set_config('request.jwt.claim.sub','${officer}',true);
      UPDATE public.shifts SET status='completed',actual_start=scheduled_start,actual_end=scheduled_end;
      INSERT INTO public.shift_breaks(organization_id,shift_id,officer_user_id,break_type,started_at,ended_at,is_paid,client_request_id)
        VALUES('${org}','${shift}','${officer}','meal','2026-10-01 12:00+13','2026-10-01 12:30+13',false,gen_random_uuid());
      DO $$ DECLARE test_case record; work_row record; BEGIN
        FOR test_case IN SELECT * FROM (VALUES (-901,false),(-900,true),(0,true),(900,true),(901,false)) AS cases(seconds,snaps) LOOP
          UPDATE public.shifts SET actual_start=scheduled_start+make_interval(secs=>test_case.seconds),
            actual_end=scheduled_end+make_interval(secs=>test_case.seconds);
          SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01');
          IF (work_row.metadata->>'start_snapped')::boolean IS DISTINCT FROM test_case.snaps
            OR (work_row.metadata->>'finish_snapped')::boolean IS DISTINCT FROM test_case.snaps
            OR (work_row.metadata->>'timesheet_mismatch')::boolean IS DISTINCT FROM NOT test_case.snaps
            THEN RAISE EXCEPTION 'Endpoint boundary failed: %',test_case.seconds; END IF;
          IF test_case.snaps AND (work_row.started_at<>'2026-10-01 08:00+13'::timestamptz
            OR work_row.ended_at<>'2026-10-01 16:00+13'::timestamptz OR work_row.calculated_minutes<>450)
            THEN RAISE EXCEPTION 'Snapped endpoints or deduction incorrect'; END IF;
          IF (work_row.metadata->>'actual_start')::timestamptz IS DISTINCT FROM
            (SELECT actual_start FROM public.shifts WHERE id='${shift}') THEN RAISE EXCEPTION 'Actual evidence lost'; END IF;
        END LOOP;
        UPDATE public.shifts SET actual_start=scheduled_start+interval '15 minutes 1 second',actual_end=scheduled_end-interval '15 minutes';
        SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01');
        IF NOT (work_row.metadata->>'start_mismatch')::boolean OR (work_row.metadata->>'finish_mismatch')::boolean
          THEN RAISE EXCEPTION 'Endpoint review must be independent'; END IF;
        UPDATE public.shifts SET actual_start=scheduled_start,actual_end=scheduled_end;
        FOR test_case IN SELECT * FROM (VALUES (1499,false),(1500,true),(1800,true),(2100,true),(2101,false)) AS cases(seconds,snaps) LOOP
          UPDATE public.shift_breaks SET ended_at=started_at+make_interval(secs=>test_case.seconds);
          SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01');
          IF (work_row.metadata->>'break_snapped')::boolean IS DISTINCT FROM test_case.snaps
            OR (work_row.metadata->>'unpaid_break_mismatch')::boolean IS DISTINCT FROM NOT test_case.snaps
            THEN RAISE EXCEPTION 'Break boundary failed: %',test_case.seconds; END IF;
          IF test_case.snaps AND work_row.calculated_minutes<>450 THEN RAISE EXCEPTION 'Roster deduction not snapped'; END IF;
        END LOOP;
        DELETE FROM public.shift_breaks;
        SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01');
        IF work_row.calculated_minutes<>480 OR NOT (work_row.metadata->>'unpaid_break_mismatch')::boolean
          THEN RAISE EXCEPTION 'Missing break must flag without inventing a deduction'; END IF;
        INSERT INTO public.shift_breaks(organization_id,shift_id,officer_user_id,break_type,started_at,ended_at,is_paid,client_request_id)
          VALUES('${org}','${shift}','${officer}','meal','2026-10-01 12:00+13','2026-10-01 12:30+13',true,gen_random_uuid());
        SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01');
        IF work_row.calculated_minutes<>480 OR NOT (work_row.metadata->>'unpaid_break_mismatch')::boolean
          THEN RAISE EXCEPTION 'Paid break cannot satisfy mandatory unpaid break'; END IF;
        UPDATE public.shift_breaks SET is_paid=false,ended_at=NULL;
        SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01');
        IF (work_row.metadata->>'break_snapped')::boolean OR NOT (work_row.metadata->>'unpaid_break_mismatch')::boolean
          THEN RAISE EXCEPTION 'Open unpaid break must remain unresolved'; END IF;
        DELETE FROM public.shift_breaks;
        UPDATE public.shifts SET scheduled_start='2026-10-01 23:00+13',scheduled_end='2026-10-02 01:00+13',
          actual_start='2026-10-01 22:50+13',actual_end='2026-10-02 01:10+13';
        UPDATE public.roster_slots SET planned_break_minutes=0;
        SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01');
        IF work_row.calculated_minutes<>60 THEN RAISE EXCEPTION 'First clipped period incorrect'; END IF;
        SELECT * INTO STRICT work_row FROM public.get_officer_timesheet_work('2026-10-02','2026-10-02');
        IF work_row.calculated_minutes<>60 THEN RAISE EXCEPTION 'Second clipped period incorrect'; END IF;
        UPDATE public.roster_slots SET planned_break_minutes=25;
        INSERT INTO public.shift_breaks(organization_id,shift_id,officer_user_id,break_type,started_at,ended_at,is_paid,client_request_id)
          VALUES('${org}','${shift}','${officer}','meal','2026-10-01 23:45+13','2026-10-02 00:15+13',false,gen_random_uuid());
        IF (SELECT sum(calculated_minutes) FROM (
          SELECT calculated_minutes FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01')
          UNION ALL SELECT calculated_minutes FROM public.get_officer_timesheet_work('2026-10-02','2026-10-02')) portions)<>95
          THEN RAISE EXCEPTION 'Split period duplicated snapped break deduction'; END IF;
        DELETE FROM public.shift_breaks;
      END $$;
      SELECT set_config('request.jwt.claim.sub','${other}',true);
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.get_officer_timesheet_work('2026-10-01','2026-10-02'))
        THEN RAISE EXCEPTION 'Other officer work disclosed'; END IF; END $$;
      SELECT set_config('request.jwt.claim.sub','',true);
      SELECT public.expect_error($$SELECT public.get_officer_timesheet_work('2026-10-01','2026-10-01')$$,'Authentication');
      SELECT set_config('request.jwt.claim.sub','${officer}',true);
      UPDATE public.shifts SET scheduled_start='2026-10-03 08:00+13',scheduled_end='2026-10-03 16:00+13',
        actual_start='2026-10-03 08:15+13',actual_end='2026-10-03 16:15+13';
      UPDATE public.roster_slots SET planned_break_minutes=30;
      INSERT INTO public.shift_breaks(organization_id,shift_id,officer_user_id,break_type,started_at,ended_at,is_paid,client_request_id)
        VALUES('${org}','${shift}','${officer}','meal','2026-10-03 12:00+13','2026-10-03 12:10+13',false,gen_random_uuid()),
          ('${org}','${shift}','${officer}','meal','2026-10-03 12:20+13','2026-10-03 12:35+13',false,gen_random_uuid());
      SELECT public.submit_officer_timesheet_from_work(gen_random_uuid(),'2026-10-03','2026-10-03',0,NULL);
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.timesheet_work_entries WHERE source_id='${shift}'
          AND calculated_minutes=450 AND (metadata->>'recorded_unpaid_break_minutes')::numeric=25
          AND (metadata->>'break_snapped')::boolean AND NOT (metadata->>'timesheet_mismatch')::boolean)
          THEN RAISE EXCEPTION 'Split-break snapping missing from submitted snapshot'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.shifts WHERE id='${shift}' AND actual_start='2026-10-03 08:15+13'::timestamptz)
          THEN RAISE EXCEPTION 'Submission changed original attendance'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.timesheets WHERE period_start='2026-10-03' AND work_derived_hours=7.5
          AND (work_summary->'entries'->0->'metadata'->>'roster_tolerance_version')::integer=1)
          THEN RAISE EXCEPTION 'Submission summary lost roster derivation'; END IF;
      END $$;
      ROLLBACK;
    `);
    sql(`BEGIN;
      SELECT set_config('request.jwt.claim.sub','${admin}',true);
      SELECT public.correct_timesheet_shift_hours('00000000-0000-4000-8000-000000000090','${shift}',
        (SELECT updated_at FROM public.shifts WHERE id='${shift}'),NULL,'${officer}',
        '2026-10-01 08:00+13','2026-10-01 16:00+13',30,'Correct manual break allowance');
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.timesheets WHERE actual_hours=7.5 AND adjustment_hours=7.5
          AND work_summary->>'evidence_kind'='manual_admin' AND status='submitted')
          THEN RAISE EXCEPTION 'Manual timesheet correction lost source or hours'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.shifts WHERE id='${shift}' AND actual_start IS NULL AND actual_end IS NULL)
          THEN RAISE EXCEPTION 'Manual correction rewrote attendance'; END IF;
      END $$;
      SELECT public.expect_error($$SELECT public.correct_timesheet_shift_hours(gen_random_uuid(),'${shift}',
        '2000-01-01'::timestamptz,NULL,'${officer}','2026-10-01 08:00+13','2026-10-01 16:00+13',30,'Stale edit')$$,'Shift changed');
      ROLLBACK;`);
    sql(`BEGIN;
      SET LOCAL TIME ZONE 'Pacific/Auckland';
      SELECT set_config('request.jwt.claim.sub','${admin}',true);
      INSERT INTO public.staff_profiles VALUES('${other}','${other}','${org}','GUARD');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status)
        VALUES('00000000-0000-4000-8000-000000000080','${org}','${other}','site_guard',
          '2026-10-01 16:00+13','2026-10-02 00:00+13','in_progress');
      DO $$ BEGIN
        IF jsonb_array_length(public.get_timesheet_shift_rows('${org}','2026-10-01','2026-10-01','${other}'))<>1
          OR public.get_timesheet_shift_rows('${org}','2026-10-01','2026-10-01','${other}')->0->>'hours_status'<>'pending'
          THEN RAISE EXCEPTION 'Open staff shift must appear before submission'; END IF;
      END $$;
      DELETE FROM public.shifts WHERE id='00000000-0000-4000-8000-000000000080';
      DO $$ BEGIN
        IF public.get_timesheet_shift_rows('${org}','2026-10-01','2026-10-01')->0->>'hours_status'<>'review'
          OR public.get_timesheet_shift_rows('${org}','2026-10-01','2026-10-01')->0->>'payable_start' IS NULL
          THEN RAISE EXCEPTION 'Manual recovery must still appear as a timesheet'; END IF;
      END $$;
      INSERT INTO public.staff_branch_authorisations VALUES('${officer}','${org}','active');
      SELECT set_config('request.jwt.claim.sub','${branchManager}',true);
      DO $$ BEGIN
        IF (SELECT count(*) FROM public.get_branch_timesheet_queue('${org}','2026-10-01','2026-10-01','${officer}'))<>1
          THEN RAISE EXCEPTION 'Authorized branch reviewer could not load filtered period'; END IF;
        IF (SELECT count(*) FROM public.get_branch_timesheet_queue('${org}','2026-10-01','2026-10-01','${other}'))<>0
          THEN RAISE EXCEPTION 'Branch period filter returned another staff member'; END IF;
      END $$;
      SELECT set_config('request.jwt.claim.sub','${admin}',true);
      SELECT public.expect_error($$SELECT public.correct_timesheet_shift_hours(gen_random_uuid(),'${shift}',
        (SELECT updated_at FROM public.shifts WHERE id='${shift}'),NULL,'${other}',
        '2026-10-01 08:00+13','2026-10-01 16:00+13',30,'Replacement guard')$$,'Existing manual recovery');
      DELETE FROM public.timesheets WHERE period_start='2026-10-01';
      SELECT public.correct_timesheet_shift_hours('00000000-0000-4000-8000-000000000070','${shift}',
        (SELECT updated_at FROM public.shifts WHERE id='${shift}'),NULL,'${other}',
        '2026-10-01 08:00+13','2026-10-01 16:00+13',30,'Replacement guard confirmed by supervisor');
      SELECT public.correct_timesheet_shift_hours('00000000-0000-4000-8000-000000000070','${shift}',
        (SELECT (metadata->'request'->>'source_version')::timestamptz FROM public.audit_log
          WHERE action='timesheet_shift_hours_corrected' LIMIT 1),NULL,'${other}',
        '2026-10-01 08:00+13','2026-10-01 16:00+13',30,'Replacement guard confirmed by supervisor');
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.shifts WHERE id='${shift}' AND officer_user_id='${other}'
          AND actual_start IS NULL AND actual_end IS NULL AND status='missed') THEN RAISE EXCEPTION 'Replacement fabricated attendance'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.roster_slots WHERE linked_shift_id='${shift}' AND staff_id='${other}')
          THEN RAISE EXCEPTION 'Replacement roster attribution missing'; END IF;
        IF (SELECT count(*) FROM public.audit_log WHERE action='timesheet_shift_hours_corrected')<>1
          THEN RAISE EXCEPTION 'Correction replay duplicated decision'; END IF;
        IF NOT EXISTS(SELECT 1 FROM public.audit_log WHERE action='timesheet_shift_hours_corrected'
          AND metadata->>'original_assignment_user_id'='${officer}') THEN RAISE EXCEPTION 'Original assignment lost'; END IF;
      END $$;
      SELECT set_config('request.jwt.claim.sub','${other}',true);
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01')
          WHERE source_id='${shift}' AND calculated_minutes=450 AND (metadata->>'manual_correction')::boolean)
          THEN RAISE EXCEPTION 'Replacement payable work missing'; END IF;
      END $$;
      SELECT set_config('request.jwt.claim.sub','${officer}',true);
      DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.get_officer_timesheet_work('2026-10-01','2026-10-01'))
        THEN RAISE EXCEPTION 'Replaced officer retained payable correction'; END IF; END $$;
      SELECT public.expect_error($$SELECT public.get_timesheet_shift_rows('${org}','2026-10-01','2026-10-01')$$,'authority');
      SELECT set_config('request.jwt.claim.sub','${branchManager}',true);
      DO $$ BEGIN
        IF jsonb_array_length(public.get_timesheet_shift_rows('${org}','2026-10-01','2026-10-01','${other}'))<>1
          THEN RAISE EXCEPTION 'Authorized branch timesheet reviewer could not see assigned shift'; END IF;
        IF jsonb_array_length(public.get_timesheet_shift_rows('${org}','2026-10-01','2026-10-01','${officer}'))<>0
          THEN RAISE EXCEPTION 'Branch staff filter exposed an unauthorized shift'; END IF;
      END $$;
      ROLLBACK;`);
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
      UPDATE public.shift_breaks SET ended_at='2026-10-01 12:25+13';
      DO $$ BEGIN
        IF (SELECT review_status FROM public.get_timesheet_break_review((SELECT id FROM public.timesheets)))<>'matched'
          THEN RAISE EXCEPTION 'Unpaid break within five minutes must match'; END IF;
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
