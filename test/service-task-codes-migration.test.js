'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261108200000_service_task_codes.sql'), 'utf8');
const pickerMigration = fs.readFileSync(path.join(root, 'supabase/migrations/20261108210000_service_task_picker_shows_tasks.sql'), 'utf8');
const squash = (text) => text.replace(/\s+/g, ' ');

test('task codes are one catalogue shared by pickers, staff pay and every rate rule write', () => {
  const sql = squash(migration);
  assert.match(sql, /rc\.code_type = 'service_code' AND rc\.is_active/);
  assert.match(sql, /NOT public\.is_known_service_code\(v_staff\.organization_id, v_service\)/);
  assert.doesNotMatch(sql, /Choose a service from the module catalogue or one already rostered/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF service_type ON public\.rate_rules/);
  assert.match(sql, /BEFORE UPDATE OF service_type ON public\.shifts/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.service_code_catalog\(uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.list_service_codes\(uuid\) FROM PUBLIC, anon;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.manage_service_code\(text, text, text, uuid\) FROM PUBLIC, anon;/);
});

test('pickers list registered and in-use tasks, not every platform module', () => {
  const sql = squash(pickerMigration);
  assert.match(sql, /FROM public\.rate_rules r JOIN chain ON chain\.id = r\.organization_id WHERE r\.active/);
  assert.match(sql, /SELECT m\.module_key, NULL, 'module', 9/);
  assert.match(sql, /WHERE c\.source <> 'module' ORDER BY c\.name/);
  assert.doesNotMatch(sql, /already a module task/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.service_code_catalog\(uuid\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.list_service_codes\(uuid\) FROM PUBLIC, anon;/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.manage_service_code\(text, text, text, uuid\) FROM PUBLIC, anon;/);
});

test('the release lane can apply the migration (no destructive SQL)', () => {
  for (const text of [migration, pickerMigration]) {
    assert.doesNotMatch(text, /^\s*(drop\s+(table|schema|database|column)|truncate\s+table|alter\s+table[^;]*\bdrop\b|delete\s+from\s+\S+\s*;)/im);
  }
});

test('task codes, owner corrections and write guards run in disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-service-codes-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = (input) => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input);
  const fails = (input, pattern) => assert.throws(() => sql(input), (error) => pattern.test(String(error.stderr ?? error.message)));
  const parent = '00000000-0000-4000-8000-0000000000a1';
  const org = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  const branch = '8b860f57-83ce-4f95-aca3-df30522f0388';
  const admin = '00000000-0000-4000-8000-000000000002';
  const officer = '00000000-0000-4000-8000-000000000003';
  const outsider = '00000000-0000-4000-8000-000000000009';
  const don = 'fa236e30-a89a-4302-944c-8e903201ba8a';
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
      CREATE TABLE public.organizations(id uuid PRIMARY KEY,parent_organization_id uuid);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,role text,deactivated_at timestamptz,display_name text);
      CREATE TABLE public.staff_profiles(id uuid PRIMARY KEY,user_id uuid,organization_id uuid,role_code text,employee_number text);
      CREATE TABLE public.reference_codes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,code_type text NOT NULL,code text NOT NULL,name text NOT NULL,is_active boolean NOT NULL DEFAULT true,sort_order integer NOT NULL DEFAULT 0,created_by uuid,updated_by uuid,UNIQUE(organization_id,code_type,code));
      CREATE TABLE public.module_catalog(module_key text PRIMARY KEY,active boolean);
      CREATE TABLE public.shifts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,service_type text NOT NULL);
      CREATE TABLE public.roster_work_units(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,service_type text,active boolean NOT NULL DEFAULT true);
      CREATE TABLE public.audit_log(id bigserial,organization_id uuid,actor_user_id uuid,action text NOT NULL,target_table text,target_id uuid,metadata jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE public.rate_rules(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,rule_kind text NOT NULL,name text NOT NULL,rate_type text NOT NULL,amount numeric NOT NULL,pay_code text,role_code text,service_type text,staff_id uuid,effective_from date,effective_to date,priority integer NOT NULL DEFAULT 0,active boolean NOT NULL DEFAULT true,created_by uuid,updated_by uuid,updated_at timestamptz NOT NULL DEFAULT now(),client_request_id uuid,UNIQUE(organization_id,client_request_id));
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='${admin}' $$;
      CREATE FUNCTION public.user_can_operate_organization(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid() IN ('${admin}','${officer}') $$;
      CREATE FUNCTION public.is_timesheet_payroll_admin(p_org uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT auth.uid()='${admin}' $$;
      CREATE FUNCTION public.get_descendant_organizations(org_id uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$
        WITH RECURSIVE t AS (SELECT id FROM public.organizations WHERE id=org_id UNION ALL SELECT o.id FROM public.organizations o JOIN t ON o.parent_organization_id=t.id) SELECT array_agg(id) FROM t $$;
      INSERT INTO public.organizations VALUES ('${parent}',null),('${org}',null),('${branch}','${parent}');
      INSERT INTO public.user_profiles VALUES ('${admin}','${org}','admin',null,'Payroll Admin'),('${officer}','${org}','field_officer',null,'Officer'),('${don}','${org}','field_officer',null,'Don Squires Field');
      INSERT INTO public.staff_profiles VALUES ('${don}','${don}','${org}','SECURITY_OFFICER','EMP-000027');
      INSERT INTO public.reference_codes(organization_id,code_type,code,name) VALUES ('${org}','pay_item','GUARD-HOURLY','Guard'),('${org}','pay_item','OPERATIONS_MANAGER','Ops');
      INSERT INTO public.module_catalog VALUES ('static_guarding',true),('patrol',true),('hr',true);
      INSERT INTO public.shifts(organization_id,service_type) VALUES ('${org}','general');
      INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,pay_code,role_code,service_type,effective_from) VALUES
        ('537a7504-61e8-49b0-84ce-bd66a8f31d83','${org}','pay','Guard 30','hourly',30,'GUARD-HOURLY',null,'Security Officer','2026-10-01'),
        ('6e82159c-9fb7-406b-a083-b954ed7144bd','${org}','pay','Operations Manager','hourly',35,'OPERATIONS_MANAGER',null,'Security','2026-10-01'),
        ('d3a665f9-fe48-4cf1-9fa4-49c8469dca0e','${org}','pay','Don Squires Field hourly pay rate','hourly',35,null,null,null,null),
        ('d32bb481-2c3c-4b32-b5c9-8955f09fcaa2','${org}','pay','Pay test','hourly',31,'ORD','CAS','MPP','2026-08-01'),
        ('004f6f8a-0556-4339-8790-ab3c8a8d6abd','${org}','billing','NZ Health','hourly',60,null,null,'Static guarding','2026-08-01'),
        ('a0255e4d-578a-4432-9231-c5eeb7dd8cd9','${branch}','billing','NCC Alarm Response','flat',85,null,null,'Alarm Response',null),
        (gen_random_uuid(),'${org}','billing','Camera review','hourly',70,null,null,'camera_review',null);
    `);
    sql(migration);
    sql(migration);
    sql(pickerMigration);
    sql(pickerMigration);

    const rule = (id) => sql(`SELECT concat_ws('|',coalesce(role_code,'-'),coalesce(service_type,'-'),coalesce(staff_id::text,'-'),active::text) FROM public.rate_rules WHERE id='${id}'`).trim();
    assert.equal(rule('537a7504-61e8-49b0-84ce-bd66a8f31d83'), 'SECURITY_OFFICER|-|-|true');
    assert.equal(rule('6e82159c-9fb7-406b-a083-b954ed7144bd'), `-|-|${don}|true`);
    assert.equal(rule('d3a665f9-fe48-4cf1-9fa4-49c8469dca0e'), '-|-|-|false');
    assert.equal(rule('d32bb481-2c3c-4b32-b5c9-8955f09fcaa2'), 'CAS|MPP|-|false');
    assert.equal(rule('004f6f8a-0556-4339-8790-ab3c8a8d6abd'), '-|static_guarding|-|true');
    assert.equal(rule('a0255e4d-578a-4432-9231-c5eeb7dd8cd9'), '-|alarm_response|-|true');
    assert.equal(sql(`SELECT name FROM public.reference_codes WHERE organization_id='${branch}' AND code='alarm_response'`).trim(), 'Alarm Response');
    assert.equal(sql(`SELECT count(*) FROM public.reference_codes WHERE code_type='service_code' AND code IN ('camera_review','general')`).trim(), '2');
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='rate_rule_owner_correction'`).trim(), '4');

    const list = (user, target) => sql(`BEGIN; ${as(user)} SELECT string_agg(code||'='||name, ',' ORDER BY code) FROM public.list_service_codes('${target}'); COMMIT;`).trim();
    assert.equal(list(officer, org), 'camera_review=Camera review,general=General,static_guarding=Static guarding');
    assert.equal(list(admin, branch), 'alarm_response=Alarm Response');
    assert.equal(sql(`SELECT count(*) FROM public.service_code_catalog('${org}') WHERE code IN ('patrol','hr')`).trim(), '2');
    fails(`BEGIN; ${as(outsider)} SELECT * FROM public.list_service_codes('${org}'); COMMIT;`, /cannot read task codes/);

    fails(`INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,service_type) VALUES ('${org}','pay','Bad','hourly',30,'Security Officer')`, /not a task code/);
    fails(`UPDATE public.shifts SET service_type='Security' WHERE organization_id='${org}'`, /not a task code/);
    sql(`UPDATE public.rate_rules SET amount=31 WHERE id='d32bb481-2c3c-4b32-b5c9-8955f09fcaa2'`);

    fails(`BEGIN; ${as(officer)} SELECT public.manage_service_code('create','Excavator hire'); COMMIT;`, /administrator required/);
    sql(`INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,service_type) VALUES ('${org}','billing','Patrol','hourly',50,'patrol')`);
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT code||'='||name FROM public.manage_service_code('create','Patrol'); COMMIT;`).trim(), 'patrol=Patrol');
    assert.match(list(officer, org), /patrol=Patrol/);
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT code FROM public.manage_service_code('create','Excavator hire'); COMMIT;`).trim(), 'excavator_hire');
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT code FROM public.manage_service_code('create','Excavator  hire!'); COMMIT;`).trim(), 'excavator_hire');
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='service_code_created'`).trim(), '2');
    assert.equal(sql(`BEGIN; ${as(admin)} SELECT organization_id FROM public.manage_service_code('create','Alarm monitoring',null,'${branch}'); COMMIT;`).trim(), branch);
    sql(`INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,service_type) VALUES ('${branch}','billing','Monitoring','hourly',20,'alarm_monitoring')`);
    fails(`INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,service_type) VALUES ('${org}','billing','Monitoring','hourly',20,'alarm_monitoring')`, /not a task code/);
    sql(`INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,service_type) VALUES ('${org}','billing','Excavator','hourly',90,'excavator_hire')`);
    fails(`BEGIN; ${as(admin)} SELECT public.manage_service_code('deactivate',null,'excavator_hire'); COMMIT;`, /Move every active rate rule/);

    const pay = (args) => sql(`BEGIN; ${as(admin)} SELECT coalesce(service_type,'all') FROM public.manage_staff_pay_rate(${args}); COMMIT;`).trim();
    assert.equal(pay(`gen_random_uuid(),'create','${don}',null,null,'hourly',40,'GUARD-HOURLY','excavator_hire','2026-12-01',null,'Plant work'`), 'excavator_hire');
    fails(`BEGIN; ${as(admin)} SELECT public.manage_staff_pay_rate(gen_random_uuid(),'create','${don}',null,null,'hourly',40,'GUARD-HOURLY','Security','2026-12-01',null,'x'); COMMIT;`, /Choose a task from the list/);
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
