const test = require('node:test');
if (process.env.BOB_TEST_POSTGRES === '1') require('./admin-timesheet-recovery-migration.test.js');
if (process.env.BOB_TEST_POSTGRES === '1') require('./timesheet-pay-links-migration.test.js');
if (process.env.BOB_TEST_POSTGRES === '1') require('./service-task-codes-migration.test.js');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261101150000_admin_officer_parity.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const consolidationMigration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261102140000_rm_verified_only_operational_custody_consolidation.sql'), 'utf8');
const catalogFunction = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
};
const catalogPolicy = (name, table = 'notifications') => {
  const start = schema.indexOf(`CREATE POLICY "${name}" ON "public"."${table}"`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf(';', start) + 1);
};
const ADMIN_READ_POLICIES = [
  ['bob_job_runs_select', 'bob_job_runs'],
  ['bob_job_rollback_refs_select', 'bob_job_rollback_refs'],
  ['Admins can view audit records for their org', 'user_management_audit'],
  ['sba_select', 'staff_branch_authorisations'],
];

const PARITY_FUNCTIONS = [
  '_entitled_org_ids_for', 'accept_client_invitation', 'apply_bob_tentative_roster_block', 'can_approve_action',
  'can_manage_r_and_m_identity', 'file_restricted_access_allowed', 'get_agreement_service_delivery',
  'get_approvals_activity', 'get_crm_onboarding_assignees', 'get_operating_organization_contexts',
  'get_payroll_setup_readiness', 'get_staff_branch_authorisations', 'get_vehicle_owner_access',
  'identity_actor_can_admin', 'is_admin_for_org', 'is_tenant_import_admin', 'manage_crm_onboarding_workflow',
  'manage_pay_code', 'manage_pay_role_code', 'manage_user_identity_access', 'notify_place_hazard_report',
  'notify_safety_review', 'org_access_allowed', 'report_provider_custodian_for_actor', 'resolve_org_invitation',
  'review_leave_request', 'staff_branch_authorisation_manager_can_manage', 'sweep_place_hazard_reviews',
];

test('every admin grant in the parity migration also names admin_officer', () => {
  const defined = [...migration.matchAll(/CREATE OR REPLACE FUNCTION "public"\."(\w+)"\(/g)].map(m => m[1]);
  assert.deepEqual(defined.sort(), [...PARITY_FUNCTIONS].sort());
  for (const name of PARITY_FUNCTIONS) {
    const start = migration.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
    const body = migration.slice(start, migration.indexOf('$function$;', start));
    assert.match(body, /'admin_officer'/, name);
    for (const [, column, list] of body.matchAll(/([\w.]*role\w*)\s*(?:not\s+)?in\s*\(([^()]*)\)/gi)) {
      if (/role_at_branch$|recipient_role$/i.test(column) || !/'admin'/.test(list)) continue;
      assert.match(list, /'admin_officer'/, `${name}: ${column} in (${list})`);
    }
    for (const [whole, column] of body.matchAll(/([\w.]*role\w*)\s*=\s*'admin'(?!\w)/gi)) {
      assert.match(column, /recipient_role$/i, `${name}: ${whole}`);
    }
  }
  for (const policy of ['notifications_select', 'notifications_update']) {
    assert.match(migration, new RegExp(`ALTER POLICY "${policy}" ON "public"\\."notifications"`));
  }
  for (const [policy, table] of ADMIN_READ_POLICIES) {
    assert.ok(migration.includes(`ALTER POLICY "${policy}" ON "public"."${table}"`));
  }
  assert.doesNotMatch(migration, /\b(GRANT|REVOKE|DROP)\b/);
});

test('identity-management handlers require an active caller before granting authority', () => {
  for (const name of ['create-user', 'invite-org', 'resend-invite']) {
    const source = fs.readFileSync(path.join(__dirname, `../supabase/functions/${name}/index.ts`), 'utf8');
    assert.match(source, /const \{ data: (?:callerProfile|currentProfile)[^\n]*\.eq\('id', (?:caller|user)\.id\)\.is\('deactivated_at', null\)\.single\(\)/, name);
  }

  const deactivateSource = fs.readFileSync(path.join(__dirname, '../supabase/functions/deactivate-user/index.ts'), 'utf8');
  const deactivationStart = consolidationMigration.indexOf('CREATE OR REPLACE FUNCTION public.set_user_deactivation(');
  const deactivationFunction = consolidationMigration.slice(
    deactivationStart,
    consolidationMigration.indexOf('$function$;', deactivationStart),
  );
  assert.match(deactivateSource, /rpc\('set_user_deactivation'/);
  assert.match(deactivationFunction, /p\.deactivated_at IS NULL/);
  assert.match(deactivationFunction, /public\.log_user_management_action/);
});

test('admin_officer resolves exactly like admin as a real database role', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-admin-officer-parity-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const id = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const org = id(1), child = id(2), other = id(3);
  const admin = id(10), adminOfficer = id(11), officer = id(12), otherAdminOfficer = id(13), inactiveAdminOfficer = id(14);
  const clientAdmin = id(15);
  const n = k => id(100 + k);
  const actor = user => `RESET ROLE; SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE authenticated;`;
  const visible = ids => `(SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM public.notifications) = ARRAY[${ids.map(k => `'${n(k)}'`).join(',')}]::uuid[]`;
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
      CREATE TABLE public.organizations(id uuid PRIMARY KEY,name text,parent_organization_id uuid);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,role text,organization_id uuid,employer_organization_id uuid,
        authorized_organization_ids uuid[] DEFAULT '{}',deactivated_at timestamptz,display_name text);
      CREATE TABLE public.service_agreements(id uuid PRIMARY KEY,name text,invitation_status text,
        provider_organization_id uuid,client_organization_id uuid,ends_on date,agreement_type text);
      CREATE TABLE public.audit_log(organization_id uuid,actor_user_id uuid,action text,target_table text,
        target_id uuid,metadata jsonb,created_at timestamptz DEFAULT clock_timestamp());
      CREATE TABLE public.provider_client_access_grants(provider_organization_id uuid,client_organization_id uuid,ends_at timestamptz);
      CREATE FUNCTION public.get_descendant_organizations(p uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
        WITH RECURSIVE tree AS (SELECT id FROM public.organizations WHERE id=p UNION ALL
          SELECT o.id FROM public.organizations o JOIN tree t ON o.parent_organization_id=t.id)
        SELECT array_agg(id) FROM tree $f$;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND role='grand_master' AND deactivated_at IS NULL) $f$;
      ${catalogFunction('current_user_role')}
      ${catalogFunction('org_access_allowed')}
      ${catalogFunction('accessible_org_ids')}
      CREATE TABLE public.notifications(id uuid PRIMARY KEY,organization_id uuid,recipient_user_id uuid,recipient_role text,
        read_at timestamptz,dedup_key text);
      CREATE FUNCTION public.enqueue_notification(p_organization_id uuid,p_category text,p_title text,p_body text,
        p_severity text,p_recipient_user_id uuid,p_recipient_role text,p_link_page text,p_link_payload jsonb,p_dedup_key text)
        RETURNS uuid LANGUAGE sql AS $f$
          INSERT INTO public.notifications(id,organization_id,recipient_user_id,recipient_role,dedup_key)
          VALUES(gen_random_uuid(),p_organization_id,p_recipient_user_id,p_recipient_role,p_dedup_key) RETURNING id $f$;
      ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
      ${catalogPolicy('notifications_select')}
      ${catalogPolicy('notifications_update')}
      GRANT SELECT, UPDATE ON public.notifications TO authenticated;
      -- Row types named by parity function signatures; their columns are irrelevant to role checks.
      CREATE TABLE public.crm_onboarding_ledgers(id uuid);
      CREATE TABLE public.leave_requests(id uuid);
      CREATE TABLE public.reference_codes(id uuid);
      CREATE TABLE public.bob_job_runs(id uuid PRIMARY KEY,job_id uuid,organization_id uuid);
      CREATE TABLE public.bob_job_rollback_refs(id uuid PRIMARY KEY,job_id uuid);
      CREATE TABLE public.user_management_audit(id uuid PRIMARY KEY,target_user_id uuid);
      CREATE TABLE public.staff_branch_authorisations(id uuid PRIMARY KEY,user_id uuid,branch_org_id uuid,status text);
      CREATE FUNCTION public.user_managed_branch_ids() RETURNS uuid[] LANGUAGE sql AS $f$ SELECT '{}'::uuid[] $f$;
      GRANT SELECT ON public.user_profiles TO authenticated;
      ${ADMIN_READ_POLICIES.map(([policy, table]) => `
        ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
        ${catalogPolicy(policy, table)}
        GRANT SELECT ON public.${table} TO authenticated;
      `).join('\n')}

      SET check_function_bodies = off;
      ${migration}
      RESET check_function_bodies;

      CREATE FUNCTION pg_temp.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $f$
        BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $f$;
      INSERT INTO public.organizations(id,name,parent_organization_id) VALUES
        ('${org}','Provider',NULL),('${child}','Provider branch','${org}'),('${other}','Other tenant',NULL);
      INSERT INTO public.user_profiles(id,role,organization_id,deactivated_at) VALUES
        ('${admin}','admin','${org}',NULL),('${adminOfficer}','admin_officer','${org}',NULL),
        ('${officer}','officer','${org}',NULL),('${otherAdminOfficer}','admin_officer','${other}',NULL),
        ('${inactiveAdminOfficer}','admin_officer','${org}',now()),('${clientAdmin}','client_admin','${other}',NULL);
      UPDATE public.user_profiles SET employer_organization_id=organization_id;
      INSERT INTO public.bob_job_runs VALUES ('${n(1)}','${id(301)}','${org}'),('${n(2)}','${id(302)}','${other}');
      INSERT INTO public.bob_job_rollback_refs VALUES ('${n(1)}','${id(301)}'),('${n(2)}','${id(302)}');
      INSERT INTO public.user_management_audit VALUES ('${n(1)}','${officer}'),('${n(2)}','${otherAdminOfficer}');
      INSERT INTO public.staff_branch_authorisations VALUES
        ('${n(1)}','${officer}','${child}','active'),('${n(2)}','${otherAdminOfficer}','${other}','active');
      INSERT INTO public.notifications(id,organization_id,recipient_user_id,recipient_role) VALUES
        ('${n(1)}','${org}',NULL,'admin'),('${n(2)}','${org}',NULL,'officer'),('${n(3)}','${org}',NULL,'admin_officer'),
        ('${n(4)}','${other}',NULL,'admin'),('${n(5)}','${org}','${adminOfficer}',NULL);

      SELECT pg_temp.check(public.can_approve_action('${admin}','${child}'),'admin approves branch work');
      SELECT pg_temp.check(public.can_approve_action('${adminOfficer}','${child}'),'admin officer approves branch work');
      SELECT pg_temp.check(public.can_approve_action('${adminOfficer}','${org}'),'admin officer approves own org work');
      SELECT pg_temp.check(NOT public.can_approve_action('${officer}','${org}'),'officer cannot approve');
      SELECT pg_temp.check(NOT public.can_approve_action('${otherAdminOfficer}','${org}'),'other tenant admin officer cannot approve');
      SELECT pg_temp.check(NOT public.can_approve_action('${inactiveAdminOfficer}','${org}'),'inactive admin officer cannot approve');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,agreement_type)
        VALUES('${id(190)}','${org}','${other}','financial');
      SELECT pg_temp.check(NOT public.can_approve_action('${adminOfficer}','${other}'),'billing agreement cannot authorise approval');
      UPDATE public.service_agreements SET agreement_type='operational' WHERE id='${id(190)}';
      SELECT pg_temp.check(public.can_approve_action('${adminOfficer}','${other}'),'operational agreement permits approval');
      DELETE FROM public.service_agreements WHERE id='${id(190)}';

      ${[admin, adminOfficer].map(user => `
        ${actor(user)}
        ${ADMIN_READ_POLICIES.map(([, table]) => `
          SELECT pg_temp.check((SELECT array_agg(id) FROM public.${table})=ARRAY['${n(1)}']::uuid[],
            'admin parity and tenant boundary for ${table}');
        `).join('\n')}
      `).join('\n')}

      ${actor(admin)}
      SELECT pg_temp.check(public.is_admin_for_org('${org}') AND public.is_admin_for_org('${child}'),'admin administers org and branch');
      SELECT pg_temp.check(public.org_access_allowed('${child}'),'admin reaches branch');
      SELECT pg_temp.check(${visible([1])},'admin sees admin inbox');

      ${actor(adminOfficer)}
      SELECT pg_temp.check(public.is_admin_for_org('${org}') AND public.is_admin_for_org('${child}'),'admin officer administers org and branch');
      SELECT pg_temp.check(public.org_access_allowed('${child}'),'admin officer reaches branch');
      SELECT pg_temp.check('${child}' = ANY(public.accessible_org_ids()),'admin officer set reach includes branch');
      SELECT pg_temp.check(NOT public.is_admin_for_org('${other}'),'admin officer stays inside the tenant');
      SELECT pg_temp.check(${visible([1, 3, 5])},'admin officer sees admin, own-role and direct notifications');
      WITH u AS (UPDATE public.notifications SET read_at=now() WHERE id='${n(1)}' RETURNING 1)
        SELECT pg_temp.check(count(*)=1,'admin officer marks admin notification read') FROM u;

      ${actor(officer)}
      SELECT pg_temp.check(NOT public.is_admin_for_org('${org}'),'officer is not an administrator');
      SELECT pg_temp.check(NOT public.org_access_allowed('${child}'),'officer does not reach branch');
      SELECT pg_temp.check(${visible([2])},'officer sees only officer inbox');
      WITH u AS (UPDATE public.notifications SET read_at=now() WHERE id='${n(1)}' RETURNING 1)
        SELECT pg_temp.check(count(*)=0,'officer cannot touch admin notification') FROM u;

      ${actor(otherAdminOfficer)}
      SELECT pg_temp.check(NOT public.is_admin_for_org('${org}'),'other tenant admin officer refused');
      SELECT pg_temp.check(${visible([4])},'other tenant admin officer sees only own tenant admin inbox');

      ${actor(inactiveAdminOfficer)}
      SELECT pg_temp.check(NOT public.is_admin_for_org('${org}'),'deactivated admin officer refused');
      SELECT pg_temp.check(NOT public.org_access_allowed('${child}'),'deactivated admin officer has no reach');
      SELECT pg_temp.check(cardinality(public.accessible_org_ids())=0,'deactivated admin officer has no set reach');
      ${ADMIN_READ_POLICIES.map(([, table]) => `
        SELECT pg_temp.check((SELECT count(*) FROM public.${table})=0,'inactive admin officer cannot read ${table}');
      `).join('\n')}
      RESET ROLE;

      ${[adminOfficer, inactiveAdminOfficer].map((inviter, i) => `
        INSERT INTO public.service_agreements(id,name,invitation_status,provider_organization_id,client_organization_id,agreement_type)
          VALUES('${id(200 + i)}','Client service','invited','${org}','${other}','operational');
        INSERT INTO public.audit_log(actor_user_id,action,target_id)
          VALUES('${inviter}','crm_client_invitation_prepared','${id(200 + i)}');
        ${actor(clientAdmin)}
        SELECT pg_temp.check((public.accept_client_invitation()->>'accepted')::integer=1,'client accepts invitation');
        RESET ROLE;
        SELECT pg_temp.check(count(*)=${i},'inactive inviter gets an active admin notification fallback')
          FROM public.notifications WHERE dedup_key='crm_client_accepted:${id(200 + i)}:admin';
      `).join('\n')}
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
