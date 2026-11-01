const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20261103090000_staff_biometrics_self_admin_read.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const catalogFunction = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
};
const catalogPolicy = name => {
  const start = schema.indexOf(`CREATE POLICY "${name}" ON "public"."staff_biometrics"`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf(';', start) + 1);
};

test('staff biometrics select is limited to the enrolled person and org administrators', () => {
  assert.match(migration, /ALTER POLICY "staff_biometrics_select" ON public\."staff_biometrics"/);
  assert.match(migration, /accessible_org_ids\(\)/);
  assert.match(migration, /OR user_id = \(SELECT auth\.uid\(\)\) OR public\.is_admin_for_org\(organization_id\)/);
  assert.doesNotMatch(migration, /\b(GRANT|DROP|CREATE POLICY)\b/);
});

test('staff biometrics read boundary holds as real database roles', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-staff-biometrics-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const org = id(1), other = id(2);
  const admin = id(10), officer = id(11), colleague = id(12), inactiveAdmin = id(13), otherAdmin = id(14);
  const actor = user => `RESET ROLE; SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE authenticated;`;
  const visible = ids => `(SELECT coalesce(array_agg(user_id ORDER BY user_id), '{}') FROM public.staff_biometrics)
    = ARRAY[${ids.map(u => `'${u}'`).join(',')}]::uuid[]`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL ready');
    const sql = `
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $f$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY,parent_organization_id uuid);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,role text,organization_id uuid,employer_organization_id uuid,
        authorized_organization_ids uuid[] DEFAULT '{}',deactivated_at timestamptz);
      CREATE TABLE public.service_agreements(provider_organization_id uuid,client_organization_id uuid,ends_on date,
        agreement_type text,invitation_status text);
      CREATE TABLE public.provider_client_access_grants(provider_organization_id uuid,client_organization_id uuid,ends_at timestamptz);
      CREATE FUNCTION public.get_descendant_organizations(p uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
        WITH RECURSIVE tree AS (SELECT id FROM public.organizations WHERE id=p UNION ALL
          SELECT o.id FROM public.organizations o JOIN tree t ON o.parent_organization_id=t.id)
        SELECT array_agg(id) FROM tree $f$;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND role='grand_master' AND deactivated_at IS NULL) $f$;
      SET check_function_bodies = off;
      ${catalogFunction('accessible_org_ids')}
      ${catalogFunction('is_admin_for_org')}
      RESET check_function_bodies;
      CREATE TABLE public.staff_biometrics(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,
        user_id uuid NOT NULL,method text NOT NULL,face_embedding jsonb,active boolean DEFAULT true);
      ALTER TABLE public.staff_biometrics ENABLE ROW LEVEL SECURITY;
      ${catalogPolicy('staff_biometrics_select')}
      GRANT SELECT ON public.staff_biometrics TO authenticated;
      ${migration}

      CREATE FUNCTION pg_temp.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $f$
        BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $f$;
      INSERT INTO public.organizations VALUES ('${org}',NULL),('${other}',NULL);
      INSERT INTO public.user_profiles(id,role,organization_id,employer_organization_id,deactivated_at) VALUES
        ('${admin}','admin','${org}','${org}',NULL),('${officer}','officer','${org}','${org}',NULL),
        ('${colleague}','officer','${org}','${org}',NULL),('${inactiveAdmin}','admin','${org}','${org}',now()),
        ('${otherAdmin}','admin','${other}','${other}',NULL);
      INSERT INTO public.staff_biometrics(organization_id,user_id,method) VALUES
        ('${org}','${officer}','face'),('${org}','${colleague}','face'),('${other}','${otherAdmin}','face');

      ${actor(officer)}
      SELECT pg_temp.check(${visible([officer])},'officer reads only own enrolment');
      ${actor(colleague)}
      SELECT pg_temp.check(${visible([colleague])},'colleague cannot read another officer enrolment');
      ${actor(admin)}
      SELECT pg_temp.check(${visible([officer, colleague])},'admin reads own-org enrolments only');
      ${actor(inactiveAdmin)}
      SELECT pg_temp.check(${visible([])},'deactivated admin reads nothing');
      ${actor(otherAdmin)}
      SELECT pg_temp.check(${visible([otherAdmin])},'other tenant admin stays inside tenant');
      RESET ROLE;
    `;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
        input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) { throw new Error(`${error.message}\n${error.stderr ?? ''}`); }
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
