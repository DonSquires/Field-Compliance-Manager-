'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261109180000_reopen_approved_timesheet.sql'), 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

test('reopening requires payroll authority, current revision, a reason and an unexported approved sheet', () => {
  const sql = squash(migration);
  assert.match(sql, /public\.is_timesheet_payroll_admin\(v_sheet\.organization_id\)/);
  assert.match(sql, /v_sheet\.revision IS DISTINCT FROM p_expected_revision/);
  assert.match(sql, /v_sheet\.status <> 'approved' OR v_sheet\.payroll_export_batch_id IS NOT NULL OR v_sheet\.payroll_snapshot IS NOT NULL/);
  assert.match(sql, /SET status = 'submitted'[\s\S]*approved_by = NULL[\s\S]*branch_reviewed_by = NULL/);
  assert.match(sql, /'timesheet_reopened'/);
  assert.match(sql, /'reason', v_reason[\s\S]*'previous_status', 'approved'[\s\S]*'previous_revision', p_expected_revision/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.reopen_approved_timesheet\(uuid, integer, text\) FROM PUBLIC, anon, service_role/);
});

test('reopen authorization, export locks and audit behavior run in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-timesheet-reopen-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const admin = '00000000-0000-4000-8000-000000000002';
  const officer = '00000000-0000-4000-8000-000000000003';
  const sheet = '00000000-0000-4000-8000-000000000004';
  const exported = '00000000-0000-4000-8000-000000000005';
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
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, employer_organization_id uuid, deactivated_at timestamptz, role text);
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY, user_id uuid);
      CREATE TABLE public.timesheets(id uuid PRIMARY KEY, organization_id uuid, staff_id uuid, status text, revision integer NOT NULL DEFAULT 1,
        payroll_export_batch_id uuid, payroll_snapshot jsonb, approved_by uuid, approved_at timestamptz,
        branch_reviewed_by uuid, branch_reviewed_at timestamptz, branch_review_notes text,
        branch_reviewed_organization_id uuid, review_notes text);
      CREATE TABLE public.audit_log(id bigserial, organization_id uuid, actor_user_id uuid, action text,
        target_table text, target_id uuid, metadata jsonb);
      CREATE TABLE public.notifications(category text, recipient_user_id uuid, title text, body text, dedup_key text);
      CREATE FUNCTION public.enqueue_notification(p_organization_id uuid,p_category text,p_title text,p_body text,
        p_severity text,p_recipient_user_id uuid,p_link_page text,p_link_payload jsonb,p_dedup_key text)
        RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.notifications VALUES (p_category,p_recipient_user_id,p_title,p_body,p_dedup_key); END $$;
      CREATE FUNCTION public.is_timesheet_payroll_admin(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS (SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=p_org
          AND employer_organization_id=p_org AND deactivated_at IS NULL AND role IN ('master','admin','admin_officer'))
      $$;
      INSERT INTO public.user_profiles VALUES
        ('${admin}','${org}','${org}',null,'admin'),('${officer}','${org}',null,null,'officer');
      INSERT INTO public.staff_profiles VALUES ('${officer}','${officer}');
      INSERT INTO public.timesheets(id,organization_id,staff_id,status,revision,approved_by,approved_at,branch_reviewed_by,branch_reviewed_at,branch_review_notes,branch_reviewed_organization_id)
        VALUES ('${sheet}','${org}','${officer}','approved',7,'${admin}',now(),'${officer}',now(),'Checked','${org}');
      INSERT INTO public.timesheets(id,organization_id,status,revision,payroll_export_batch_id,payroll_snapshot)
        VALUES ('${exported}','${org}','approved',2,gen_random_uuid(),'{}');
    `);
    sql(migration);

    fails(`BEGIN; ${as(officer)} SELECT public.reopen_approved_timesheet('${sheet}',7,'Correction needed'); COMMIT;`, /Active employer payroll administrator required/);
    fails(`BEGIN; ${as(admin)} SELECT public.reopen_approved_timesheet('${sheet}',6,'Correction needed'); COMMIT;`, /Timesheet changed/);
    fails(`BEGIN; ${as(admin)} SELECT public.reopen_approved_timesheet('${sheet}',7,' '); COMMIT;`, /reason of 1 to 2000 characters/);
    fails(`BEGIN; ${as(admin)} SELECT public.reopen_approved_timesheet('${exported}',2,'Correction needed'); COMMIT;`, /Only approved, unexported/);
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT status||'|'||revision||'|'||(approved_by IS NULL)::text||'|'||(branch_reviewed_by IS NULL)::text FROM public.reopen_approved_timesheet('${sheet}',7,'Correcting approved hours'); COMMIT;`).trim(), 'submitted|8|true|true');
    assert.equal(sql(`SELECT action||'|'||(metadata->>'reason')||'|'||(metadata->>'previous_revision')||'|'||(metadata->>'previous_approved_by') FROM public.audit_log WHERE target_id='${sheet}'`).trim(), `timesheet_reopened|Correcting approved hours|7|${admin}`);
    assert.equal(sql(`SELECT category||'|'||recipient_user_id||'|'||title FROM public.notifications WHERE recipient_user_id='${officer}'`).trim(), `timesheet_decision|${officer}|Timesheet returned for review`);
    assert.equal(sql("SELECT has_function_privilege('authenticated','public.reopen_approved_timesheet(uuid,integer,text)','EXECUTE')").trim(), 't');
    assert.equal(sql("SELECT has_function_privilege('anon','public.reopen_approved_timesheet(uuid,integer,text)','EXECUTE')").trim(), 'f');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});