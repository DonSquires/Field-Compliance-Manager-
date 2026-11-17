const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261117000300_patrol_catalogues.sql');
const migration = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8').replace(/\r\n/g, '\n') : '';

test('patrol catalogues migration declares its surface', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.patrol_check_types\(/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.place_service_seasons\(/);
  assert.match(migration, /ALTER TABLE public\.patrol_check_types ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /ALTER TABLE public\.place_service_seasons ENABLE ROW LEVEL SECURITY;/);
  for (const fn of ['manage_patrol_check_type', 'active_check_keys_for']) {
    assert.match(migration, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(`));
  }
  assert.doesNotMatch(migration, /\bDROP\b/i);
});

describe('patrol catalogues against disposable PostgreSQL', { skip: process.env.BOB_TEST_POSTGRES !== '1' }, () => {
  const container = `fcm-patrol-catalogues-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const psql = (sql) => docker(['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', 'postgres'], sql);
  let created = false;
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const provider = id(1); const branch = id(2); const other = id(3);
  const providerAdmin = id(11); const officer = id(12); const otherAdmin = id(13); const otherOfficer = id(14);
  const as = (user) => `SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE authenticated;`;
  const reset = 'RESET ROLE;';
  const sqlValue = (value) => (value === null ? 'NULL' : typeof value === 'string' ? `'${value}'` : String(value));
  const manage = (request, action, org, typeId, label, photo = null, note = null) =>
    `public.manage_patrol_check_type('${request}','${action}','${org}',${sqlValue(typeId)},${sqlValue(label)},${sqlValue(photo)},${sqlValue(note)})`;
  const globalKeys = ['bed_down', 'gate_check', 'key_pickup', 'key_return', 'lock_up', 'random_check', 'unlock', 'welfare_check'];

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
      CREATE FUNCTION public.get_descendant_organizations(org_id uuid) RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
        WITH RECURSIVE org_tree AS (SELECT id FROM public.organizations WHERE id = org_id UNION ALL SELECT o.id FROM public.organizations o JOIN org_tree t ON o.parent_organization_id = t.id)
        SELECT coalesce(array_agg(id), array[]::uuid[]) FROM org_tree $fn$;
      CREATE FUNCTION public.can_approve_action(p_user_id uuid, p_action_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id = p_user_id AND up.deactivated_at IS NULL AND up.role = 'admin' AND p_action_org_id = ANY(public.get_descendant_organizations(up.organization_id))) $fn$;
      CREATE FUNCTION public.is_admin_for_org(target_org_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$ SELECT public.can_approve_action(auth.uid(), target_org_id) $fn$;
      CREATE FUNCTION public.user_can_operate_organization(p_organization_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
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
      GRANT SELECT ON public.audit_log TO authenticated;
      INSERT INTO public.organizations VALUES('${provider}',NULL,'Provider'),('${branch}','${provider}','Provider north branch'),('${other}',NULL,'Other provider');
      INSERT INTO public.user_profiles VALUES
        ('${providerAdmin}','${provider}','${provider}','admin',NULL),
        ('${officer}','${provider}','${provider}','officer',NULL),
        ('${otherAdmin}','${other}','${other}','admin',NULL),
        ('${otherOfficer}','${other}','${other}','officer',NULL);
      ${migration}
    `);
  });

  after(() => { if (created) docker(['rm', '--force', container]); });

  test('seeds exactly the default check types and the four seasons', () => {
    psql(`
      SELECT fixture.check((SELECT array_agg(check_key ORDER BY check_key) = ARRAY['${globalKeys.join("','")}'] FROM public.patrol_check_types WHERE organization_id IS NULL),'exactly the eight default keys are seeded');
      SELECT fixture.check((SELECT label='Lock-up' AND active AND NOT needs_photo AND NOT needs_note FROM public.patrol_check_types WHERE organization_id IS NULL AND check_key='lock_up'),'default labels are seeded verbatim');
      SELECT fixture.check((SELECT array_agg(season_key || ':' || months::text ORDER BY sort_order) = ARRAY['summer:{12,1,2}','autumn:{3,4,5}','winter:{6,7,8}','spring:{9,10,11}'] FROM public.place_service_seasons),'the four seasons are seeded');
      ${as(otherOfficer)}
      SELECT fixture.check((SELECT count(*)=8 FROM public.patrol_check_types),'any signed-in user sees the defaults');
      SELECT fixture.check((SELECT count(*)=4 FROM public.place_service_seasons),'any signed-in user sees the seasons');
      SELECT fixture.check((SELECT public.active_check_keys_for('${other}') = ARRAY['${globalKeys.join("','")}']),'active keys start with the defaults');
      ${reset}
      SELECT fixture.check(NOT has_table_privilege('anon','public.patrol_check_types','SELECT'),'anon cannot read check types');
      SELECT fixture.check(NOT has_table_privilege('authenticated','public.patrol_check_types','INSERT'),'check types are not written through the Data API');
      SELECT fixture.check(NOT has_table_privilege('authenticated','public.patrol_check_types','UPDATE') AND NOT has_table_privilege('authenticated','public.patrol_check_types','DELETE'),'check types are not changed or deleted through the Data API');
      SELECT fixture.check(NOT has_table_privilege('authenticated','public.place_service_seasons','UPDATE') AND NOT has_table_privilege('authenticated','public.place_service_seasons','INSERT'),'seasons are not written through the Data API');
      SELECT fixture.check(NOT has_function_privilege('anon','public.manage_patrol_check_type(uuid,text,uuid,uuid,text,boolean,boolean)','EXECUTE'),'anon cannot manage check types');
      SELECT fixture.check(NOT has_function_privilege('anon','public.active_check_keys_for(uuid)','EXECUTE'),'anon cannot list active keys');
    `);
  });

  test('org admin creates, updates and deactivates a check type', () => {
    const createRequest = randomUUID();
    psql(`
      ${as(providerAdmin)}
      CREATE TEMP TABLE created_type AS SELECT ${manage(createRequest, 'create', provider, null, '  Alarm panel check ', true, false)} AS r;
      SELECT fixture.check((SELECT r->>'check_key'='alarm_panel_check' AND r->>'label'='Alarm panel check' AND (r->>'needs_photo')::boolean AND NOT (r->>'needs_note')::boolean AND (r->>'active')::boolean FROM created_type),'the key is derived from the label');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='patrol_check_type_create' AND organization_id='${provider}' AND metadata->>'client_request_id'='${createRequest}'),'creation is audited');
      SELECT fixture.check((SELECT ${manage(createRequest, 'create', provider, null, '  Alarm panel check ', true, false)} = r FROM created_type),'a replay returns the first result');
      SELECT fixture.check((SELECT count(*)=1 FROM public.patrol_check_types WHERE check_key='alarm_panel_check'),'a replay creates nothing');
      SELECT fixture.raises($q$ SELECT ${manage(createRequest, 'create', provider, null, 'Fire panel check', true, false)} $q$,'22023');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, 'Lock-up')} $q$,'P0001','A check called Lock-up already exists');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, 'ALARM panel-check')} $q$,'P0001','A check called Alarm panel check already exists');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, '24 hour check')} $q$,'P0001','Use a check name that starts with a letter and is no longer than 40 letters or numbers');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, 'A' + 'a'.repeat(80))} $q$,'P0001','Use a check name of 80 characters or fewer');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'update', provider, '__ID__', 'A' + 'a'.repeat(80))} $q$,'P0001','Use a check name of 80 characters or fewer');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'update', provider, '__ID__', ' lock-UP ')} $q$,'P0001','A check called Lock-up already exists');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'update', provider, '__ID__', null)} $q$,'22023');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, ' -- ')} $q$,'P0001');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'update', provider, randomUUID(), 'Nope')} $q$,'P0002');
      SELECT fixture.raises(format($q$ SELECT ${manage(randomUUID(), 'update', provider, '%s', 'Locking up', false, true)} $q$,(SELECT id FROM public.patrol_check_types WHERE organization_id IS NULL AND check_key='lock_up')),'P0001','Default check types cannot be changed');
      SELECT fixture.raises(format($q$ SELECT ${manage(randomUUID(), 'deactivate', provider, '%s', null)} $q$,(SELECT id FROM public.patrol_check_types WHERE organization_id IS NULL AND check_key='lock_up')),'P0001','Default check types cannot be changed');
      SELECT fixture.check((SELECT r->>'check_key'='alarm_panel_check' AND r->>'label'='Alarm panel inspection' AND NOT (r->>'needs_photo')::boolean AND (r->>'needs_note')::boolean
        FROM (SELECT ${manage(randomUUID(), 'update', provider, '__ID__', 'Alarm panel inspection', false, true)} r) x),'update changes the label and flags but not the key');
      SELECT fixture.check((SELECT 'alarm_panel_check' = ANY(public.active_check_keys_for('${provider}'))),'the new key is active');
      SELECT fixture.check((SELECT NOT (r->>'active')::boolean FROM (SELECT ${manage(randomUUID(), 'deactivate', provider, '__ID__', null)} r) x),'deactivate turns the type off');
      SELECT fixture.check((SELECT NOT ('alarm_panel_check' = ANY(public.active_check_keys_for('${provider}'))) AND cardinality(public.active_check_keys_for('${provider}'))=8),'a deactivated type leaves the active keys');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='patrol_check_type_update') AND (SELECT count(*)=1 FROM public.audit_log WHERE action='patrol_check_type_deactivate'),'every change is audited');
      SELECT fixture.check((SELECT (r->>'reactivated')::boolean AND (r->>'active')::boolean AND r->>'check_type_id' = (SELECT r->>'check_type_id' FROM created_type) AND r->>'label'='Alarm Panel Check!' AND NOT (r->>'needs_photo')::boolean AND (r->>'needs_note')::boolean
        FROM (SELECT ${manage(randomUUID(), 'create', provider, null, 'Alarm Panel Check!', false, true)} r) x),'creating an inactive own key reactivates that row with the new details');
      SELECT fixture.check((SELECT NOT (r->>'reactivated')::boolean FROM created_type),'a fresh create is not a reactivation');
      SELECT fixture.check((SELECT count(*)=1 FROM public.patrol_check_types WHERE check_key='alarm_panel_check') AND 'alarm_panel_check' = ANY(public.active_check_keys_for('${provider}')),'reactivation reuses the row and the key is active again');
      SELECT fixture.check((SELECT count(*)=2 FROM public.audit_log WHERE action='patrol_check_type_create' AND organization_id='${provider}'),'reactivation is audited as a create');
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, 'Alarm panel check')} $q$,'P0001','A check called Alarm Panel Check! already exists');
      ${reset}
    `.replaceAll("'__ID__'", "(SELECT (r->>'check_type_id')::uuid FROM created_type)"));
  });

  test('reactivate brings back a renamed own type by its ID', () => {
    const reactivateRequest = randomUUID();
    psql(`
      ${as(providerAdmin)}
      CREATE TEMP TABLE hatch AS SELECT ${manage(randomUUID(), 'create', provider, null, 'Hatch check', true, false)} AS r;
      SELECT ${manage(randomUUID(), 'update', provider, '__ID__', 'Hatch inspection')};
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'reactivate', provider, '__ID__', null)} $q$,'P0001','This check is already active');
      SELECT ${manage(randomUUID(), 'deactivate', provider, '__ID__', null)};
      CREATE TEMP TABLE revived AS SELECT ${manage(reactivateRequest, 'reactivate', provider, '__ID__', null)} AS r;
      SELECT fixture.check((SELECT (r->>'active')::boolean AND r->>'check_key'='hatch_check' AND r->>'label'='Hatch inspection' AND (r->>'needs_photo')::boolean
        AND r->>'check_type_id'=(SELECT r->>'check_type_id' FROM hatch) FROM revived),'the same row comes back with its renamed label and needs');
      SELECT fixture.check((SELECT 'hatch_check' = ANY(public.active_check_keys_for('${provider}'))),'the key is active again');
      SELECT fixture.check((SELECT ${manage(reactivateRequest, 'reactivate', provider, '__ID__', null)} = r FROM revived),'a replay returns the first result');
      SELECT fixture.check((SELECT count(*)=1 FROM public.audit_log WHERE action='patrol_check_type_reactivate' AND metadata->>'client_request_id'='${reactivateRequest}'),'reactivation is audited');
      SELECT fixture.raises(format($q$ SELECT ${manage(randomUUID(), 'reactivate', provider, '%s', null)} $q$,(SELECT id FROM public.patrol_check_types WHERE organization_id IS NULL AND check_key='lock_up')),'P0001','Default check types cannot be changed');
      SELECT ${manage(randomUUID(), 'deactivate', provider, '__ID__', null)};
      SELECT ${manage(randomUUID(), 'create', provider, null, 'Hatch inspection')};
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'reactivate', provider, '__ID__', null)} $q$,'P0001','A check called Hatch inspection already exists');
      ${reset}
    `.replaceAll("'__ID__'", "(SELECT (r->>'check_type_id')::uuid FROM hatch)"));
  });

  test('non-admins and other organisations cannot manage or see the type', () => {
    psql(`
      ${as(providerAdmin)}
      CREATE TEMP TABLE branch_type AS SELECT ${manage(randomUUID(), 'create', branch, null, 'Bin check')} AS r;
      ${reset}
      ${as(officer)}
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, 'Officer check')} $q$,'42501');
      SELECT fixture.check((SELECT count(*)=1 FROM public.patrol_check_types WHERE check_key='bin_check'),'an officer of the organisation sees its types');
      ${reset}
      ${as(otherAdmin)}
      SELECT fixture.raises($q$ SELECT ${manage(randomUUID(), 'create', provider, null, 'Stray check')} $q$,'42501');
      SELECT fixture.raises(format($q$ SELECT ${manage(randomUUID(), 'deactivate', other, '%s', null)} $q$,(SELECT r->>'check_type_id' FROM branch_type)),'P0002');
      SELECT fixture.check((SELECT count(*)=0 FROM public.patrol_check_types WHERE organization_id IS NOT NULL),'another organisation sees none of the first organisation''s types');
      SELECT fixture.check((SELECT NOT ('bin_check' = ANY(public.active_check_keys_for('${other}')))),'another organisation''s active keys exclude them');
      SELECT fixture.check((SELECT count(*)=1 FROM (SELECT ${manage(randomUUID(), 'create', other, null, 'Bin check')}) x),'the same name is free in another organisation');
      ${reset}
    `);
  });
});
