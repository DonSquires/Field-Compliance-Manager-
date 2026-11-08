'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261108150000_timesheet_pay_links.sql'), 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

test('removes the ambiguous one-argument branch timesheet queue', () => {
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.get_branch_timesheet_queue\(uuid\);/);
});

test('staff-specific pay rules take precedence and never apply to anyone else', () => {
  const sql = squash(migration);
  assert.match(sql, /\(rr\.staff_id IS NULL OR rr\.staff_id=sp\.id\)/);
  assert.match(sql, /ORDER BY \(rr\.staff_id IS NOT NULL\)::integer DESC/);
  assert.match(sql, /\(rr\.staff_id is null or rr\.staff_id = sp\.id\)/);
  assert.match(sql, /order by \(rr\.staff_id is not null\)::integer desc/);
  assert.match(sql, /\(r\.staff_id is null or r\.staff_id=s\.staff_id\)/);
  assert.equal((migration.match(/AND rule\.staff_id IS NULL/g) ?? []).length, 2);
  assert.match(sql, /CHECK \(staff_id IS NULL OR rule_kind = 'pay'\)/);
});

test('staff pay changes are governed, catalogue-driven and audited', () => {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.manage_staff_pay_rate(');
  const body = squash(migration.slice(start, migration.indexOf('$function$;', start)));
  assert.match(body, /public\.is_timesheet_payroll_admin\(v_staff\.organization_id\)/);
  assert.match(body, /code\.code_type = 'pay_item'/);
  assert.match(body, /FROM public\.module_catalog m WHERE m\.module_key = v_service AND m\.active/);
  assert.match(body, /FROM public\.roster_work_units u WHERE u\.organization_id = v_staff\.organization_id AND u\.service_type = v_service/);
  assert.match(body, /A reason is required for every pay change/);
  assert.match(body, /effective_to = v_from - 1/);
  assert.match(body, /'staff_pay_rate_reviewed'/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.manage_staff_pay_rate\([^)]*\) FROM PUBLIC, anon;/);
});

test('commercial readiness returns human references', () => {
  for (const column of ['work_unit_name text', 'scheduled_start timestamptz', 'staff_name text', 'service_agreement_name text', 'client_organization_id uuid', 'site_id uuid']) {
    assert.ok(migration.includes(column), column);
  }
});

test('staff pay review and precedence run in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-staff-pay-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const org = '00000000-0000-4000-8000-000000000001';
  const admin = '00000000-0000-4000-8000-000000000002';
  const officer = '00000000-0000-4000-8000-000000000003';
  const colleague = '00000000-0000-4000-8000-000000000004';
  const sheet = '00000000-0000-4000-8000-000000000005';
  const colleagueSheet = '00000000-0000-4000-8000-000000000006';
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
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,employer_organization_id uuid,deactivated_at timestamptz,display_name text);
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,role_code text,employee_number text);
      CREATE TABLE public.reference_codes(organization_id uuid,code_type text,code text,is_active boolean);
      CREATE TABLE public.module_catalog(module_key text PRIMARY KEY,active boolean);
      CREATE TABLE public.shifts(id uuid PRIMARY KEY,organization_id uuid,service_type text);
      CREATE TABLE public.roster_work_units(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,service_type text);
      CREATE TABLE public.timesheets(id uuid PRIMARY KEY,organization_id uuid,staff_id uuid,shift_id uuid,period_start date,payroll_snapshot jsonb,pay_code_override text,hourly_rate_override numeric);
      CREATE TABLE public.audit_log(id bigserial,organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
      CREATE TABLE public.rate_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,rule_kind text NOT NULL,name text NOT NULL,rate_type text NOT NULL,amount numeric NOT NULL,pay_code text,role_code text,service_type text,effective_from date,effective_to date,priority integer NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,created_by uuid,updated_by uuid,updated_at timestamptz NOT NULL DEFAULT now(),client_request_id uuid,UNIQUE(organization_id,client_request_id));
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='${admin}' $$;
      CREATE FUNCTION public.is_timesheet_payroll_admin(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='${admin}' AND p_org='${org}' $$;
      CREATE FUNCTION public.get_branch_timesheet_queue(uuid) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
      CREATE FUNCTION public.get_cost_of_service_summary(uuid,date,date) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.get_payroll_setup_readiness(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
      CREATE FUNCTION public.get_roster_commercial_readiness(uuid,timestamptz,timestamptz) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
      INSERT INTO public.user_profiles VALUES ('${admin}','${org}','${org}',null,'Payroll Admin'),('${officer}','${org}','${org}',null,'Field Officer'),('${colleague}','${org}','${org}',null,'Colleague');
      INSERT INTO public.staff_profiles VALUES ('${officer}','${officer}','${org}','SECURITY_OFFICER','E1'),('${colleague}','${colleague}','${org}','SECURITY_OFFICER','E2');
      INSERT INTO public.reference_codes VALUES ('${org}','pay_item','GUARD-HOURLY',true),('${org}','pay_item','OLD',false);
      INSERT INTO public.module_catalog VALUES ('patrol',true),('noise_control',true);
      INSERT INTO public.roster_work_units(organization_id,service_type) VALUES ('${org}','general');
      INSERT INTO public.timesheets VALUES ('${sheet}','${org}','${officer}',null,'2026-12-10',null,null,null),('${colleagueSheet}','${org}','${colleague}',null,'2026-12-10',null,null,null);
      INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,pay_code) VALUES ('${org}','pay','General','hourly',30,'GUARD-HOURLY');
    `);
    // The pre-migration stubs only exist so the DROP/CREATE statements can replay; strip the copied large functions.
    const replayable = migration.slice(0, migration.indexOf('-- Cost of service: staff-specific'))
      .replace(/DROP FUNCTION IF EXISTS public\.get_roster_commercial_readiness[\s\S]*$/, '');
    sql(replayable);
    assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname='get_branch_timesheet_queue'").trim(), '0');

    const call = (user, args) => sql(`BEGIN; ${as(user)} SELECT amount||'|'||coalesce(effective_to::text,'open') FROM public.manage_staff_pay_rate(${args}); COMMIT;`).trim();
    fails(`BEGIN; ${as(officer)} SELECT public.manage_staff_pay_rate(gen_random_uuid(),'create','${officer}',null,null,'hourly',40,'GUARD-HOURLY',null,'2026-12-01',null,'raise'); COMMIT;`, /payroll administrator/);
    fails(`BEGIN; ${as(admin)} SELECT public.manage_staff_pay_rate(gen_random_uuid(),'create','${officer}',null,null,'hourly',40,'OLD',null,'2026-12-01',null,'raise'); COMMIT;`, /active payroll pay code/);
    fails(`BEGIN; ${as(admin)} SELECT public.manage_staff_pay_rate(gen_random_uuid(),'create','${officer}',null,null,'hourly',40,'GUARD-HOURLY','Unknown task','2026-12-01',null,'raise'); COMMIT;`, /already rostered/);
    assert.equal(call(admin, `gen_random_uuid(),'create','${officer}',null,null,'hourly',36,'GUARD-HOURLY','general','2026-12-01',null,'General task rate'`), '36|open');
    fails(`BEGIN; ${as(admin)} SELECT public.manage_staff_pay_rate(gen_random_uuid(),'create','${officer}',null,null,'hourly',40,'GUARD-HOURLY',null,'2026-12-01',null,' '); COMMIT;`, /reason is required/);

    const createRequest = randomUUID();
    assert.equal(call(admin, `'${createRequest}','create','${officer}',null,null,'hourly',40,'guard-hourly',null,'2026-12-01',null,'Starting rate'`), '40|open');
    assert.equal(call(admin, `'${createRequest}','create','${officer}',null,null,'hourly',40,'guard-hourly',null,'2026-12-01',null,'Starting rate'`), '40|open');
    fails(`BEGIN; ${as(admin)} SELECT public.manage_staff_pay_rate(gen_random_uuid(),'create','${officer}',null,null,'hourly',41,'GUARD-HOURLY',null,'2026-12-05',null,'dup'); COMMIT;`, /Pay review/);

    const pay = (user, id) => sql(`BEGIN; ${as(user)} SELECT pay_code||'|'||hourly_rate FROM public.timesheet_effective_pay('${id}'); COMMIT;`).trim();
    assert.equal(pay(admin, sheet), 'GUARD-HOURLY|40');
    assert.equal(pay(admin, colleagueSheet), 'GUARD-HOURLY|30');

    const current = sql(`SELECT id FROM public.rate_rules WHERE staff_id='${officer}' AND service_type IS NULL`).trim();
    assert.equal(call(admin, `gen_random_uuid(),'review','${officer}','${current}',null,'hourly',44,null,null,'2026-12-08',null,'Annual pay review'`), '44|open');
    assert.equal(sql(`SELECT effective_to FROM public.rate_rules WHERE id='${current}'`).trim(), '2026-12-07');
    assert.equal(pay(admin, sheet), 'GUARD-HOURLY|44');
    assert.equal(sql("SELECT string_agg(action, ',' ORDER BY id) FROM public.audit_log").trim(), 'staff_pay_rate_created,staff_pay_rate_created,staff_pay_rate_reviewed');
    fails(`BEGIN; ${as(admin)} SELECT public.manage_staff_pay_rate(gen_random_uuid(),'create','${colleague}',null,null,'hourly',35,'GUARD-HOURLY',null,null,null,'x'); UPDATE public.rate_rules SET rule_kind='billing' WHERE staff_id='${colleague}'; COMMIT;`, /rate_rules_staff_pay_only/);
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
