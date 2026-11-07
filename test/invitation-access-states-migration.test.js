'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(join(__dirname, '../supabase/migrations/20261107220000_invitation_access_states.sql'), 'utf8');
const schema = readFileSync(join(__dirname, '../supabase/schema.sql'), 'utf8');
const original = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  const end = schema.indexOf('$function$;', start) + '$function$;'.length;
  assert.ok(start >= 0 && end > start, `Snapshot contains ${name}`);
  return schema.slice(start, end);
};

test('invitation access states stay read-only, scoped and server-only for anon', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_user_sign_in_states\(uuid\[\]\) FROM PUBLIC, anon;/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.get_client_portal_access\(uuid\) FROM PUBLIC, anon;/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.prepare_crm_client_invitation\(uuid\) FROM PUBLIC, anon;/);
  assert.match(migration, /\(status = 'prospect' AND NOT active\) OR \(status = 'active' AND active\)/);
  const reads = migration.slice(0, migration.indexOf('CREATE OR REPLACE FUNCTION public.prepare_crm_client_invitation'));
  assert.doesNotMatch(reads, /\b(INSERT|UPDATE|DELETE)\b/);
});

test('sign-in states and active-client invitations enforce authority', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-invitation-access-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
  });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = query => docker(['exec', '-i', name, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], query).trim();
    const provider = '10000000-0000-4000-8000-000000000001';
    const otherProvider = '10000000-0000-4000-8000-000000000002';
    const activeClient = '10000000-0000-4000-8000-000000000003';
    const prospect = '10000000-0000-4000-8000-000000000004';
    const archived = '10000000-0000-4000-8000-000000000005';
    const seated = '10000000-0000-4000-8000-000000000006';
    const noPlace = '10000000-0000-4000-8000-000000000007';
    const gm = '20000000-0000-4000-8000-000000000001';
    const admin = '20000000-0000-4000-8000-000000000002';
    const officer = '20000000-0000-4000-8000-000000000003';
    const noLogin = '20000000-0000-4000-8000-000000000004';
    const invited = '20000000-0000-4000-8000-000000000005';
    const master = '20000000-0000-4000-8000-000000000006';
    const foreign = '20000000-0000-4000-8000-000000000007';
    const clientAdmin = '20000000-0000-4000-8000-000000000008';
    const clientViewer = '20000000-0000-4000-8000-000000000009';
    const as = (actor, query) => `SET ROLE authenticated; SET request.jwt.claim.sub='${actor}'; ${query}`;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, last_sign_in_at timestamptz, invited_at timestamptz, confirmation_sent_at timestamptz);
      CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text, status text, active boolean,
        parent_organization_id uuid, contact_email text);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY, organization_id uuid, role text, deactivated_at timestamptz);
      CREATE TABLE public.crm_contacts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, email text,
        first_name text, last_name text, is_primary boolean, deactivated_at timestamptz, updated_at timestamptz DEFAULT now());
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_organization_id uuid, active boolean);
      CREATE TABLE public.locations(id uuid PRIMARY KEY, organization_id uuid);
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), location_id uuid, is_active boolean);
      CREATE TABLE public.service_agreements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), provider_organization_id uuid,
        client_organization_id uuid, name text, starts_on date, ends_on date, agreement_type text, invitation_status text,
        client_portal_access_mode text, external_refs jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE public.audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
        actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb);
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT auth.uid() IN ('${gm}'::uuid, '${admin}'::uuid) AND $1 = '${provider}'::uuid $$;
      CREATE FUNCTION public.crm_actor_can_manage_account(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT $1 IN ('${activeClient}'::uuid, '${prospect}'::uuid, '${archived}'::uuid, '${seated}'::uuid, '${noPlace}'::uuid) $$;
      CREATE FUNCTION public.get_descendant_organizations(uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[$1] $$;
      ${original('identity_role_level')}
      INSERT INTO public.organizations VALUES
        ('${provider}','Provider','active',true,NULL,NULL),('${otherProvider}','Other','active',true,NULL,NULL),
        ('${activeClient}','Active client','active',true,'${provider}','Owner@Client.example '),
        ('${prospect}','Prospect','prospect',false,'${provider}',NULL),
        ('${archived}','Archived','archived',false,'${provider}','old@client.example'),
        ('${seated}','Seated','active',true,'${provider}','seat@client.example'),
        ('${noPlace}','No place','active',true,'${provider}','np@client.example');
      INSERT INTO public.crm_contacts(organization_id,email,first_name,last_name,is_primary) VALUES ('${prospect}','lead@prospect.example','Lee','Lead',true);
      INSERT INTO public.client_sites(client_organization_id,active) VALUES ('${activeClient}',true),('${archived}',true),('${seated}',true);
      INSERT INTO public.locations VALUES ('30000000-0000-4000-8000-000000000001','${prospect}');
      INSERT INTO public.location_zones(location_id,is_active) VALUES ('30000000-0000-4000-8000-000000000001',true);
      INSERT INTO public.user_profiles VALUES
        ('${gm}','${provider}','grand_master',NULL),('${admin}','${provider}','admin',NULL),
        ('${officer}','${provider}','officer',NULL),('${noLogin}','${provider}','officer',NULL),
        ('${invited}','${provider}','officer',NULL),('${master}','${provider}','master',NULL),
        ('${foreign}','${otherProvider}','officer',NULL),
        ('${clientAdmin}','${seated}','client_admin',NULL),('${clientViewer}','${seated}','client_viewer',NULL);
      INSERT INTO auth.users VALUES
        ('${gm}',now(),NULL,NULL),('${admin}',now(),NULL,NULL),('${officer}',now() - interval '1 day',now() - interval '9 days',NULL),
        ('${invited}',NULL,now() - interval '2 days',NULL),('${master}',NULL,NULL,now()),('${foreign}',now(),NULL,NULL),
        ('${clientAdmin}',now(),NULL,NULL),('${clientViewer}',NULL,now(),NULL);
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
      ${migration}
    `);

    const everyone = [gm, admin, officer, noLogin, invited, master, foreign, clientAdmin, clientViewer];
    const states = actor => Object.fromEntries(sql(as(actor,
      `SELECT user_id || '=' || sign_in_state FROM public.get_user_sign_in_states(ARRAY['${everyone.join("','")}']::uuid[])`))
      .split('\n').filter(Boolean).map(line => line.split('=')));
    assert.deepEqual(states(admin), { [admin]: 'signed_in', [officer]: 'signed_in', [noLogin]: 'no_login', [invited]: 'invited' },
      'An admin sees own-organisation people at or below their authority, never higher roles or other tenants');
    assert.equal(Object.keys(states(gm)).length, everyone.length, 'A grand master sees every requested person');
    assert.deepEqual(states(clientAdmin), { [clientAdmin]: 'signed_in', [clientViewer]: 'invited' }, 'A client administrator sees only their client people');
    assert.throws(() => states(officer), /Active identity administrator required/);
    assert.throws(() => sql(as(admin, `SELECT count(*) FROM public.get_user_sign_in_states(array_fill(gen_random_uuid(), ARRAY[501]))`)), /at most 500/);
    for (const fn of ['get_user_sign_in_states(uuid[])', 'get_client_portal_access(uuid)', 'prepare_crm_client_invitation(uuid)']) {
      assert.equal(sql(`SELECT has_function_privilege('anon','public.${fn}','execute')`), 'f', `${fn} denies anon`);
      assert.equal(sql(`SELECT has_function_privilege('authenticated','public.${fn}','execute')`), 't', `${fn} allows authenticated`);
    }

    const portal = account => JSON.parse(sql(as(admin, `SELECT public.get_client_portal_access('${account}')`)));
    assert.deepEqual([portal(activeClient).can_invite, portal(activeClient).contact_email, portal(activeClient).place_count], [true, 'owner@client.example', 1]);
    assert.deepEqual([portal(seated).can_invite, portal(seated).client_user_count, portal(seated).signed_in_user_count, portal(seated).pending_user_count], [false, 2, 1, 1]);
    assert.equal(portal(noPlace).invite_blocker, 'Add at least one place before inviting the client.');
    assert.equal(portal(archived).invite_blocker, 'This account is not active.');
    assert.throws(() => sql(as(officer, `SELECT public.get_client_portal_access('${activeClient}')`)), /provider CRM administrator required/);

    const prepare = account => JSON.parse(sql(as(admin, `SELECT public.prepare_crm_client_invitation('${account}')`)));
    const activeInvite = prepare(activeClient);
    assert.equal(activeInvite.email, 'owner@client.example', 'An active client with no login can be invited');
    assert.equal(activeInvite.provider_organization_id, provider);
    assert.equal(prepare(prospect).email, 'lead@prospect.example', 'Prospects still invite as before');
    assert.throws(() => prepare(archived), /Managed client account not found/);
    assert.throws(() => prepare(seated), /already has a user who can sign in/);
    assert.throws(() => prepare(noPlace), /at least one place/);
    assert.throws(() => sql(as(officer, `SELECT public.prepare_crm_client_invitation('${activeClient}')`)), /provider CRM administrator required/);
    assert.equal(sql(`SELECT metadata->>'account_status' FROM public.audit_log WHERE metadata->>'account_organization_id'='${activeClient}'`), 'active');
    assert.equal(sql(`SELECT count(*) FROM public.service_agreements WHERE client_organization_id='${activeClient}'`), '1', 'Re-preparing reuses the agreement');
    prepare(activeClient);
    assert.equal(sql(`SELECT count(*) FROM public.service_agreements WHERE client_organization_id='${activeClient}'`), '1');
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
