const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261117000200_organization_operating_settings.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n') : '';

test('organisation operating settings migration declares its surface', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.organization_operating_settings\(/);
  assert.match(migration, /ALTER TABLE public\.organization_operating_settings ENABLE ROW LEVEL SECURITY;/);
  for (const fn of ['get_organization_operating_settings', 'set_organization_operating_setting', 'can_set_up_static_post', 'create_static_roster_work_unit_internal', 'create_operating_roster_work_unit']) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
  }
  assert.match(migration, /public\.can_set_up_static_post\(agreement\.provider_organization_id, p_operating_organization_id\)/);
  assert.doesNotMatch(migration, /\bDROP\b/i);
});

describe('organisation operating settings against disposable PostgreSQL', { skip: process.env.BOB_TEST_POSTGRES !== '1' }, () => {
  const container = `fcm-org-operating-settings-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = (sql) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres'], sql);
  let created = false;
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const provider = id(1); const branch = id(2); const unrelated = id(3); const client = id(4);
  const providerAdmin = id(11); const branchAdmin = id(12); const unrelatedAdmin = id(13); const officer = id(14); const secondAdmin = id(15);
  const agreement = id(20); const agreementLocation = id(21); const agreementModule = id(22);
  const as = (user) => `SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE authenticated;`;
  const reset = 'RESET ROLE;';
  const setSetting = (request, org, setting, value) => `public.set_organization_operating_setting('${request}','${org}','${setting}',${value})`;
  const gatePost = (org) => `public.create_operating_roster_work_unit('${org}','Gate post','static','static_guarding',NULL,'${agreementLocation}','${agreementModule}')`;

  before(async () => {
    docker(['run', '--detach', '--name', container, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    psql(`
      CREATE ROLE anon;
      CREATE ROLE authenticated;
      CREATE ROLE service_role;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE SCHEMA fixture;
      GRANT USAGE ON SCHEMA fixture TO authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY, parent_organization_id uuid, name text);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, employer_organization_id uuid, role text, deactivated_at timestamptz);
      CREATE TABLE public.audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, actor_user_id uuid, action text NOT NULL, target_table text, target_id uuid, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.service_agreements(id uuid PRIMARY KEY, provider_organization_id uuid, client_organization_id uuid, agreement_type text, ends_on date);
      CREATE TABLE public.service_agreement_locations(id uuid PRIMARY KEY, service_agreement_id uuid, status text);
      CREATE TABLE public.service_agreement_modules(id uuid PRIMARY KEY, service_agreement_id uuid, module_key text, enabled boolean);
      CREATE TABLE public.patrol_routes(id uuid PRIMARY KEY, organization_id uuid, is_active boolean);
      CREATE TABLE public.roster_work_units(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, name text NOT NULL, work_unit_type text NOT NULL, service_type text NOT NULL, active boolean NOT NULL DEFAULT true, patrol_route_id uuid, service_agreement_location_id uuid, service_agreement_module_id uuid, workplace_id uuid, team_id uuid, cost_centre_id uuid, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE FUNCTION public.get_descendant_organizations(org_id uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $fn$
        WITH RECURSIVE org_tree AS (SELECT id FROM public.organizations WHERE id = org_id UNION ALL SELECT o.id FROM public.organizations o JOIN org_tree t ON o.parent_organization_id = t.id)
        SELECT coalesce(array_agg(id), array[]::uuid[]) FROM org_tree $fn$;
      CREATE FUNCTION public.can_approve_action(p_user_id uuid, p_action_org_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id = p_user_id AND up.deactivated_at IS NULL AND up.role = 'admin' AND p_action_org_id = ANY(public.get_descendant_organizations(up.organization_id))) $fn$;
      CREATE FUNCTION public.is_admin_for_org(target_org_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT public.can_approve_action(auth.uid(), target_org_id) $fn$;
      CREATE FUNCTION public.user_can_operate_organization(p_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id = auth.uid() AND up.deactivated_at IS NULL AND p_organization_id = ANY(public.get_descendant_organizations(up.organization_id))) $fn$;
      CREATE FUNCTION fixture.check(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION fixture.raises(command text, expected text, expected_message text DEFAULT NULL) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE command; EXCEPTION WHEN OTHERS THEN
          IF SQLSTATE = expected AND (expected_message IS NULL OR SQLERRM = expected_message) THEN RETURN; END IF;
          RAISE;
        END;
        RAISE EXCEPTION 'Expected SQLSTATE %',expected;
      END $fn$;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA fixture TO authenticated;
      GRANT SELECT ON public.audit_log, public.roster_work_units TO authenticated;
      INSERT INTO public.organizations VALUES('${provider}',NULL,'Provider'),('${branch}','${provider}','Provider north branch'),('${unrelated}',NULL,'Unrelated'),('${client}',NULL,'Client council');
      INSERT INTO public.user_profiles VALUES
        ('${providerAdmin}','${provider}','${provider}','admin',NULL),
        ('${branchAdmin}','${branch}','${provider}','admin',NULL),
        ('${unrelatedAdmin}','${unrelated}','${unrelated}','admin',NULL),
        ('${officer}','${provider}','${provider}','officer',NULL),
        ('${secondAdmin}','${unrelated}','${unrelated}','admin','2026-01-01');
      INSERT INTO public.service_agreements VALUES('${agreement}','${provider}','${client}','operational',NULL);
      INSERT INTO public.service_agreement_locations VALUES('${agreementLocation}','${agreement}','active');
      INSERT INTO public.service_agreement_modules VALUES('${agreementModule}','${agreement}','static_guarding',true);
      ${migration}
    `);
  });

  after(() => { if (created) docker(['rm', '--force', container]); });

  test('settings default off', () => {
    psql(`
      ${as(branchAdmin)}
      SELECT fixture.check((SELECT s->>'place_changes_need_second_approver'='false' AND s->>'branches_may_set_up_static_posts'='false' FROM (SELECT public.get_organization_operating_settings('${branch}') s) x),'a fresh organisation has both settings off');
      SELECT fixture.check((SELECT (public.get_organization_operating_settings('${branch}')->>'other_approver_available')::boolean),'the provider administrator can approve for the branch');
      ${reset}
      ${as(unrelatedAdmin)}
      SELECT fixture.check((SELECT NOT (public.get_organization_operating_settings('${unrelated}')->>'other_approver_available')::boolean),'a deactivated administrator is not another approver');
      SELECT fixture.raises($q$ SELECT public.get_organization_operating_settings('${branch}') $q$,'42501');
      ${reset}
      SELECT fixture.check(NOT has_function_privilege('anon','public.get_organization_operating_settings(uuid)','EXECUTE'),'anon cannot read settings');
      SELECT fixture.check(NOT has_table_privilege('authenticated','public.organization_operating_settings','INSERT'),'settings are not written through the Data API');
    `);
  });

  test('setting change is audited and idempotent', () => {
    const request = randomUUID();
    psql(`
      ${as(providerAdmin)}
      SELECT fixture.check((SELECT r->>'from'='false' AND r->>'to'='true' FROM (SELECT ${setSetting(request, provider, 'place_changes_need_second_approver', 'true')} r) x),'the change reports from and to');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='organization_operating_setting_change' AND metadata->>'client_request_id'='${request}' AND metadata->>'setting'='place_changes_need_second_approver' AND metadata->>'from'='false' AND metadata->>'to'='true'),'the change is audited once');
      SELECT fixture.check((SELECT r->>'from'='false' AND r->>'to'='true' FROM (SELECT ${setSetting(request, provider, 'place_changes_need_second_approver', 'true')} r) x),'a replay returns the first result');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='organization_operating_setting_change' AND metadata->>'client_request_id'='${request}'),'a replay is not audited twice');
      SELECT fixture.check((SELECT (s->>'place_changes_need_second_approver')::boolean AND NOT (s->>'branches_may_set_up_static_posts')::boolean FROM (SELECT public.get_organization_operating_settings('${provider}') s) x),'only the named setting changed');
      SELECT fixture.raises($q$ SELECT ${setSetting(randomUUID(), provider, 'something_else', 'true')} $q$,'22023');
      ${reset}
    `);
  });

  test('non-admin cannot change settings', () => {
    psql(`
      ${as(officer)}
      SELECT fixture.raises($q$ SELECT ${setSetting(randomUUID(), provider, 'branches_may_set_up_static_posts', 'true')} $q$,'42501');
      ${reset}
      ${as(unrelatedAdmin)}
      SELECT fixture.raises($q$ SELECT ${setSetting(randomUUID(), provider, 'branches_may_set_up_static_posts', 'true')} $q$,'42501');
      ${reset}
      SELECT fixture.check(NOT has_function_privilege('anon','public.set_organization_operating_setting(uuid,uuid,text,boolean)','EXECUTE'),'anon cannot change settings');
      SELECT fixture.check(NOT has_function_privilege('authenticated','public.create_static_roster_work_unit_internal(uuid,uuid,text,text,uuid,uuid)','EXECUTE'),'the static unit helper is internal');
      SELECT fixture.check(has_function_privilege('service_role','public.create_static_roster_work_unit_internal(uuid,uuid,text,text,uuid,uuid)','EXECUTE'),'the service role can create static units');
      ${as(providerAdmin)}
      SELECT fixture.check((SELECT NOT (s->>'branches_may_set_up_static_posts')::boolean FROM (SELECT public.get_organization_operating_settings('${provider}') s) x),'refused changes change nothing');
      ${reset}
    `);
  });

  test('branch static post follows the setting', () => {
    const missing = 'Active static guarding agreement location and module required';
    psql(`
      ${as(branchAdmin)}
      SELECT fixture.raises($q$ SELECT ${gatePost(branch)} $q$,'P0001','${missing}');
      ${reset}
      ${as(providerAdmin)}
      SELECT fixture.check((SELECT organization_id='${provider}' FROM ${gatePost(provider)}),'the provider can always set up its own static post');
      SELECT ${setSetting(randomUUID(), provider, 'branches_may_set_up_static_posts', 'true')};
      ${reset}
      ${as(branchAdmin)}
      SELECT fixture.check((SELECT organization_id='${branch}' AND work_unit_type='static' AND service_agreement_location_id='${agreementLocation}' AND created_by='${branchAdmin}' FROM ${gatePost(branch)}),'the branch can set up a static post once allowed');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='roster_work_unit_created' AND organization_id='${branch}' AND actor_user_id='${branchAdmin}'),'the branch static post is audited');
      ${reset}
      ${as(unrelatedAdmin)}
      SELECT fixture.raises($q$ SELECT ${gatePost(unrelated)} $q$,'P0001','${missing}');
      ${reset}
    `);
  });
});
