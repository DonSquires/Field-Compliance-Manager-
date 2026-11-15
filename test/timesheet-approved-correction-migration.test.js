'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.resolve(__dirname, '../supabase/migrations/20261115090000_allow_approved_timesheet_correction.sql');
const migrationSource = fs.readFileSync(migrationPath, 'utf8');
const migration = migrationSource.replace(/\s+/g, ' ');
const timesheetsPage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/TimesheetsPage.tsx'), 'utf8');
const rosterPage = fs.readFileSync(path.resolve(__dirname, '../apps/web/src/pages/RosterHRPage.tsx'), 'utf8');
const databaseTypes = fs.readFileSync(path.resolve(__dirname, '../src/types/database.ts'), 'utf8');

test('approved hours corrections require payroll authority and the displayed revision', () => {
  assert.match(migration, /DROP FUNCTION public\.correct_timesheet_hours\(uuid, text, numeric, numeric, text\)/i);
  assert.match(migration, /CREATE FUNCTION public\.correct_timesheet_hours\([\s\S]*p_expected_revision integer/i);
  assert.match(migration, /IF v_sheet\.status = 'approved' THEN IF NOT public\.is_timesheet_payroll_admin\(v_sheet\.organization_id\)/i);
  assert.match(migration, /v_sheet\.revision IS DISTINCT FROM p_expected_revision/i);
  assert.match(timesheetsPage, /p_expected_revision: revision/);
  assert.match(rosterPage, /p_expected_revision: timesheetCorrection\.item\.revision/);
  assert.match(databaseTypes, /correct_timesheet_hours:\s*\{\s*Args:\s*\{[^}]*p_expected_revision: number/s);
});

test('both correction receipts preserve invalidated approval and branch-review details', () => {
  for (const field of [
    'previous_status', 'previous_revision', 'previous_approved_by', 'previous_approved_at',
    'previous_branch_reviewed_by', 'previous_branch_reviewed_at',
    'previous_branch_review_notes', 'previous_branch_reviewed_organization_id',
  ]) {
    assert.equal((migration.match(new RegExp(`'${field}'`, 'g')) ?? []).length, 2, field);
  }
});

test('approved corrections enforce payroll authority, revision checks and receipt history in PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-timesheet-approved-correction-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const employerAdmin = '00000000-0000-4000-8000-000000000002';
  const delegatedAdmin = '00000000-0000-4000-8000-000000000003';
  const staff = '00000000-0000-4000-8000-000000000004';
  const hoursSheet = '00000000-0000-4000-8000-000000000005';
  const paySheet = '00000000-0000-4000-8000-000000000006';
  const as = (user) => `SET LOCAL request.jwt.claim.sub='${user}';`;
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
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, employer_organization_id uuid,
        deactivated_at timestamptz, role text);
      CREATE TABLE public.timesheets(id uuid PRIMARY KEY, organization_id uuid, staff_id uuid,
        status text, revision integer NOT NULL DEFAULT 1, payroll_export_batch_id uuid,
        actual_hours numeric, overtime_hours numeric, adjustment_hours numeric, work_derived_hours numeric,
        review_notes text, approved_by uuid, approved_at timestamptz, branch_reviewed_by uuid,
        branch_reviewed_at timestamptz, branch_review_notes text, branch_reviewed_organization_id uuid,
        pay_code_override text, hourly_rate_override numeric, pay_override_reason text);
      CREATE TABLE public.audit_log(id bigserial, organization_id uuid, actor_user_id uuid, action text,
        target_table text, target_id uuid, metadata jsonb);
      CREATE FUNCTION public.is_admin_for_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=auth.uid()
          AND organization_id=p_org AND deactivated_at IS NULL AND role IN ('master','admin','admin_officer'))
      $$;
      CREATE FUNCTION public.is_timesheet_payroll_admin(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=auth.uid()
          AND organization_id=p_org AND employer_organization_id=p_org AND deactivated_at IS NULL
          AND role IN ('master','admin','admin_officer'))
      $$;
      CREATE FUNCTION public.correct_timesheet_hours(uuid,text,numeric,numeric,text)
        RETURNS public.timesheets LANGUAGE sql AS $$ SELECT NULL::public.timesheets $$;
      CREATE FUNCTION public.bump_timesheet_revision() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN NEW.revision := OLD.revision+1; RETURN NEW; END
      $$;
      CREATE TRIGGER timesheet_revision BEFORE UPDATE ON public.timesheets
        FOR EACH ROW EXECUTE FUNCTION public.bump_timesheet_revision();
      INSERT INTO public.user_profiles VALUES
        ('${employerAdmin}','${org}','${org}',null,'admin'),
        ('${delegatedAdmin}','${org}','00000000-0000-4000-8000-000000000099',null,'admin');
      INSERT INTO public.timesheets(id,organization_id,staff_id,status,revision,actual_hours,overtime_hours,
        work_derived_hours,approved_by,approved_at,branch_reviewed_by,branch_reviewed_at,branch_review_notes,
        branch_reviewed_organization_id)
        VALUES ('${hoursSheet}','${org}','${staff}','approved',7,8,1,6,'${employerAdmin}',now(),
          '${staff}',now(),'Branch checked','${org}'),
          ('${paySheet}','${org}','${staff}','approved',3,8,1,6,'${employerAdmin}',now(),
          '${staff}',now(),'Branch checked','${org}');
    `);
    sql(migrationSource);

    fails(`BEGIN; ${as(delegatedAdmin)} SELECT public.correct_timesheet_hours('${hoursSheet}','approved',7,9,1,'Fix hours'); COMMIT;`, /Active employer payroll administrator required/);
    fails(`BEGIN; ${as(employerAdmin)} SELECT public.correct_timesheet_hours('${hoursSheet}','approved',6,9,1,'Fix hours'); COMMIT;`, /Timesheet changed/);
    assert.equal(sql(`BEGIN; ${as(employerAdmin)} SELECT status||'|'||revision||'|'||(approved_by IS NULL)::text||'|'||(branch_reviewed_by IS NULL)::text FROM public.correct_timesheet_hours('${hoursSheet}','approved',7,9,1,'Fix hours'); COMMIT;`).trim(), 'submitted|8|true|true');
    assert.equal(sql(`SELECT (metadata->>'previous_status')||'|'||(metadata->>'previous_revision')||'|'||(metadata->>'previous_approved_by')||'|'||(metadata->>'previous_approved_at' IS NOT NULL)::text||'|'||(metadata->>'previous_branch_reviewed_by')||'|'||(metadata->>'previous_branch_reviewed_at' IS NOT NULL)::text||'|'||(metadata->>'previous_branch_review_notes')||'|'||(metadata->>'previous_branch_reviewed_organization_id') FROM public.audit_log WHERE target_id='${hoursSheet}'`).trim(), `approved|7|${employerAdmin}|true|${staff}|true|Branch checked|${org}`);

    sql(`UPDATE public.timesheets SET status='approved',approved_by='${employerAdmin}',approved_at=now() WHERE id='${hoursSheet}'`);
    fails(`BEGIN; ${as(employerAdmin)} SELECT public.correct_timesheet_hours('${hoursSheet}','approved',7,10,1,'Stale form'); COMMIT;`, /Timesheet changed/);
    assert.equal(sql(`SELECT actual_hours||'|'||status||'|'||revision FROM public.timesheets WHERE id='${hoursSheet}'`).trim(), '9|approved|9');

    assert.equal(sql(`BEGIN; ${as(employerAdmin)} SELECT status||'|'||revision||'|'||(approved_by IS NULL)::text FROM public.correct_timesheet_pay('00000000-0000-4000-8000-000000000007','${paySheet}',3,'OT',30,'Pay correction'); COMMIT;`).trim(), 'submitted|4|true');
    assert.equal(sql(`SELECT (metadata->>'previous_status')||'|'||(metadata->>'previous_revision')||'|'||(metadata->>'previous_approved_by')||'|'||(metadata->>'previous_approved_at' IS NOT NULL)::text||'|'||(metadata->>'previous_branch_reviewed_by')||'|'||(metadata->>'previous_branch_reviewed_at' IS NOT NULL)::text||'|'||(metadata->>'previous_branch_review_notes')||'|'||(metadata->>'previous_branch_reviewed_organization_id') FROM public.audit_log WHERE target_id='${paySheet}'`).trim(), `approved|3|${employerAdmin}|true|${staff}|true|Branch checked|${org}`);
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
