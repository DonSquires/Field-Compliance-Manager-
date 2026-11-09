'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261109160000_timesheet_provenance_projection.sql'), 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

test('provenance projection is batch-bounded and applies employer or branch-review authority', () => {
  const sql = squash(migration);
  assert.match(sql, /cardinality\(p_timesheet_ids\) > 500/);
  assert.match(sql, /public\.is_admin_for_org\(t\.organization_id\)/);
  assert.match(sql, /public\.user_can_operate_organization\(p_operating_organization_id\)/);
  assert.match(sql, /'timesheet_local_review'/);
  assert.match(sql, /assignment\.status = 'active'/);
  assert.match(sql, /entry\.source_type = 'shift'/);
  assert.match(sql, /public\.location_zones zone/);
  assert.match(sql, /public\.locations place/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.get_timesheet_provenance\(uuid\[\], uuid\) FROM PUBLIC, anon, service_role/);
});

test('provenance projection returns place labels only to an authorized employer or branch reviewer', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-timesheet-provenance-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const branch = '00000000-0000-4000-8000-000000000002';
  const admin = '00000000-0000-4000-8000-000000000003';
  const reviewer = '00000000-0000-4000-8000-000000000004';
  const officer = '00000000-0000-4000-8000-000000000005';
  const outsider = '00000000-0000-4000-8000-000000000006';
  const sheet = '00000000-0000-4000-8000-000000000007';
  const shift = '00000000-0000-4000-8000-000000000008';
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
      CREATE TABLE public.organizations(id uuid PRIMARY KEY,name text);
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY,user_id uuid);
      CREATE TABLE public.staff_branch_authorisations(user_id uuid,branch_org_id uuid,status text);
      CREATE TABLE public.timesheets(id uuid PRIMARY KEY,organization_id uuid,staff_id uuid,shift_id uuid,work_summary jsonb);
      CREATE TABLE public.timesheet_work_entries(timesheet_id uuid,source_type text,source_id uuid);
      CREATE TABLE public.shifts(id uuid PRIMARY KEY,organization_id uuid,service_type text,work_unit_id uuid,location_id uuid,zone_id uuid,scheduled_start timestamptz);
      CREATE TABLE public.roster_work_units(id uuid PRIMARY KEY,name text);
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY,name text,location_id uuid);
      CREATE TABLE public.locations(id uuid PRIMARY KEY,name text);
      CREATE FUNCTION public.is_admin_for_org(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='${admin}' AND p_org='${org}' $$;
      CREATE FUNCTION public.user_can_operate_organization(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='${reviewer}' AND p_org='${branch}' $$;
      CREATE FUNCTION public.user_can_exercise_branch_authority(p_org uuid,p_user uuid,p_permission text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='${reviewer}' AND p_org='${branch}' AND p_user='${officer}' AND p_permission='timesheet_local_review' $$;
      INSERT INTO public.organizations VALUES ('${org}','Harbour Compliance Services'),('${branch}','Northern Branch');
      INSERT INTO public.staff_profiles VALUES ('${officer}','${officer}');
      INSERT INTO public.staff_branch_authorisations VALUES ('${officer}','${branch}','active');
      INSERT INTO public.locations VALUES ('00000000-0000-4000-8000-000000000009','Civic Events Centre');
      INSERT INTO public.location_zones VALUES ('00000000-0000-4000-8000-000000000010','North Pavilion Zone','00000000-0000-4000-8000-000000000009');
      INSERT INTO public.roster_work_units VALUES ('00000000-0000-4000-8000-000000000011','Civic Centre Static Post');
      INSERT INTO public.shifts VALUES ('${shift}','${org}','static_guarding','00000000-0000-4000-8000-000000000011',null,'00000000-0000-4000-8000-000000000010',now());
      INSERT INTO public.timesheets VALUES ('${sheet}','${org}','${officer}',null,'{}');
      INSERT INTO public.timesheet_work_entries VALUES ('${sheet}','shift','${shift}');
    `);
    sql(migration);

    assert.equal(sql(`BEGIN; ${as(reviewer)} SELECT organization_name||'|'||operating_organization_name||'|'||work_unit_name||'|'||location_name||'|'||zone_name FROM public.get_timesheet_provenance(ARRAY['${sheet}'::uuid],'${branch}'); COMMIT;`).trim(), 'Harbour Compliance Services|Northern Branch|Civic Centre Static Post|Civic Events Centre|North Pavilion Zone');
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT count(*) FROM public.get_timesheet_provenance(ARRAY['${sheet}'::uuid],'${org}'); COMMIT;`).trim(), '1');
    fails(`BEGIN; ${as(outsider)} SELECT * FROM public.get_timesheet_provenance(ARRAY['${sheet}'::uuid],'${branch}'); COMMIT;`, /Timesheet provenance authority required/);
    assert.equal(sql("SELECT has_function_privilege('authenticated','public.get_timesheet_provenance(uuid[],uuid)','EXECUTE')").trim(), 't');
    assert.equal(sql("SELECT has_function_privilege('anon','public.get_timesheet_provenance(uuid[],uuid)','EXECUTE')").trim(), 'f');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});