'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
const migrations = path.join(root, 'supabase', 'migrations');
const id = number => `62000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const arg = (value, type) => `${literal(value)}::${type}`;

function table(name) {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, `Live snapshot contains ${name}`);
  return `${schema.slice(start, schema.indexOf('\n);', start) + 3)}
    ALTER TABLE public.${name} ADD PRIMARY KEY (${name === 'module_catalog' ? 'module_key' : 'id'});`;
}

function definition(name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `Live snapshot contains ${name}`);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
}

function policy(name, tableName) {
  const start = schema.indexOf(`CREATE POLICY "${name}" ON "public"."${tableName}"`);
  assert.ok(start >= 0, `Live snapshot contains ${tableName} policy ${name}`);
  return schema.slice(start, schema.indexOf(';', start) + 1);
}

test('rate-card lifecycle never disables existing triggers', () => {
  const file = fs.readdirSync(migrations)
    .find(name => /^\d{14}_rate_card_version_lifecycle\.sql$/.test(name));
  assert.ok(file, 'Lifecycle migration exists');
  assert.doesNotMatch(fs.readFileSync(path.join(migrations, file), 'utf8'), /\bDISABLE\s+TRIGGER\b/i);
});

test('real PostgreSQL governs versioned rate-card approvals', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 480000,
}, async t => {
  const foundationName = fs.readdirSync(migrations)
    .find(file => /^\d{14}_rate_card_foundation\.sql$/.test(file));
  assert.ok(foundationName, 'The committed foundation migration exists');
  const lifecycleNames = fs.readdirSync(migrations)
    .filter(file => /^\d{14}_rate_card_version_lifecycle\.sql$/.test(file));
  assert.ok(lifecycleNames.length <= 1, 'At most one lifecycle migration exists');
  const foundation = fs.readFileSync(path.join(migrations, foundationName), 'utf8');
  const lifecycle = lifecycleNames.length
    ? fs.readFileSync(path.join(migrations, lifecycleNames[0]), 'utf8') : '';
  const container = `fcm-rate-approval-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
  const sql = input => docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input).trim();
  const concurrentSql = input => {
    const process = spawn('docker', ['exec', '-i', container, 'psql', '-h', '127.0.0.1',
      '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    process.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const completed = new Promise((resolve, reject) => {
      process.once('error', reject);
      process.once('close', code => resolve({ code, stdout, stderr }));
    });
    process.stdin.end(input);
    return completed;
  };
  const waitForBackend = async (application, condition) => {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${literal(application)}
        AND state='active' AND ${condition};`) === '1') return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`Concurrent transaction ${application} did not reach its barrier`);
  };
  const waitForSleepingBackend = application => waitForBackend(application, "query LIKE '%pg_sleep%'");
  const waitForBlockedBackend = application => waitForBackend(application, "wait_event_type='Lock'");
  const releaseSleepingBackend = application => {
    assert.equal(sql(`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE application_name=${literal(application)} AND state='active' AND query LIKE '%pg_sleep%';`), 't');
  };
  const json = input => JSON.parse(sql(input));
  const fails = (input, message) => assert.throws(() => sql(input), error =>
    message.test(String(error.stderr ?? error.message)), `Expected database refusal: ${message}`);
  const actor = who => `SET request.jwt.claim.sub = '${who}'; SET ROLE authenticated;`;
  const rpc = (who, expression, prefix = '') => json(`${prefix} ${actor(who)} SELECT ${expression};`);
  const [provider, branch, other, lone, clientA, clientB, clientC, clientD,
    admin, reviewer, outsider, loneAdmin, branchAdmin, officer, inactive,
    homeAsset, foreignAsset, retiredAsset, agreementA, agreementB,
    legacyA, legacyB, legacyC, legacyStandard] = Array.from({ length: 24 }, (_, i) => id(i + 1));
  const foreignClient = id(201), agreementD = id(202), localStaff = id(203), foreignStaff = id(204);
  const scopeAsset = id(205), shiftProbe = id(206);
  const tieClient = id(207), tieOlder = id(208), tieNewer = id(209);
  const clientReader = id(220), foreignZone = id(221), missingZone = id(222), foreignHouse = id(223);
  const foreignPlace = id(224), clientZone = id(225), clientHouse = id(226), clientPlace = id(227);
  const providerOfficer = id(228), branchOfficer = id(229), branchAgreement = id(230);
  const assignedReviewer = id(231), clientSite = id(232), missingSite = id(233);
  const ownHouse = id(234), ownPlace = id(235), ownZone = id(236), ownSite = id(237);
  const unlinkedClientZone = id(238);
  const byId = (name, value) => json(`SELECT row_to_json(t) FROM public.${name} t WHERE id=${arg(value, 'uuid')};`);
  const cardFor = client => sql(`SELECT id FROM public.rate_cards
    WHERE organization_id='${provider}' AND client_organization_id='${client}' AND is_client_default;`);
  const versionFor = card => json(`SELECT row_to_json(v) FROM public.rate_card_versions v
    WHERE rate_card_id=${arg(card, 'uuid')} AND status='approved';`);
  const version = value => byId('rate_card_versions', value);
  const line = value => byId('rate_rules', value);
  const args = values => values.map(([value, type]) => arg(value, type)).join(',');
  const manage = (who, options) => {
    const o = { request: randomUUID(), org: provider, action: 'create', card: null,
      kind: 'charge', name: 'New client card', client: clientD, isDefault: false,
      agreement: null, expectedCardAt: null, expectedPrevious: null, payrollRole: null, ...options };
    const expression = `public.manage_rate_card(${args([
      [o.request, 'uuid'], [o.org, 'uuid'], [o.action, 'text'], [o.card, 'uuid'],
      [o.kind, 'text'], [o.name, 'text'], [o.client, 'uuid'], [o.isDefault, 'boolean'],
      [o.agreement, 'uuid'], [o.expectedCardAt, 'timestamptz'], [o.expectedPrevious, 'uuid'],
      [o.payrollRole, 'text'],
    ])})`;
    return { ...o, expression, result: rpc(who, expression) };
  };
  const start = (who, card, expected = versionFor(card)?.id ?? null, request = randomUUID()) =>
    rpc(who, `public.start_rate_card_version(${args([[request, 'uuid'], [card, 'uuid'], [expected, 'uuid']])})`);
  const draftExpression = o => `public.manage_rate_card_draft_line(${args([
    [o.request, 'uuid'], [o.version, 'uuid'], [o.expectedAt, 'timestamptz'],
    [o.action, 'text'], [o.rule, 'uuid'], [o.name, 'text'], [o.type, 'text'],
    [o.amount, 'numeric'], [o.group, 'text'], [JSON.stringify(o.scope), 'jsonb'],
    [o.from, 'date'], [o.to, 'date'], [o.asset, 'uuid'],
  ])})`;
  const draft = (who, options) => {
    const o = { request: randomUUID(), action: 'create', rule: null, name: 'New labour',
      type: 'hourly', amount: 80, group: null, scope: {}, from: null, to: null, asset: null, ...options };
    return { ...o, expression: draftExpression(o), result: rpc(who, draftExpression(o)) };
  };
  const submitExpression = (request, versionId, from, note, expectedAt) =>
    `public.submit_rate_card_version(${args([[request, 'uuid'], [versionId, 'uuid'],
      [from, 'date'], [note, 'text'], [expectedAt, 'timestamptz']])})`;
  const submit = (who, versionId, from, expectedAt, request = randomUUID()) =>
    rpc(who, submitExpression(request, versionId, from, 'Finance review', expectedAt));
  const decideExpression = (request, versionId, decision, reason, expectedAt) =>
    `public.decide_rate_card_version(${args([[request, 'uuid'], [versionId, 'uuid'],
      [decision, 'text'], [reason, 'text'], [expectedAt, 'timestamptz']])})`;
  const decide = (who, versionId, decision, expectedAt, request = randomUUID(), reason = 'Reviewed') =>
    rpc(who, decideExpression(request, versionId, decision, reason, expectedAt));
  const resolve = (client, when = '2026-11-18T12:00:00+13:00') => json(`
    SELECT row_to_json(r) FROM public.resolve_rate_rule(
      '${provider}','billing','${when}','patrol',NULL,NULL,'${client}',
      NULL,NULL,NULL,5,'weekday','hourly') r;`);
  let created = false;

  try {
    docker(['run', '--detach', '--pull', 'never', '--name', container, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolveReady => setTimeout(resolveReady, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready without network access');
    sql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, email text);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      ${['organizations', 'user_profiles', 'staff_branch_authorisations', 'staff_profiles', 'service_agreements',
        'provider_client_access_grants', 'canonical_places', 'locations', 'client_sites', 'location_zones',
        'service_agreement_locations', 'assets', 'audit_log', 'reference_codes', 'rate_rules',
        'roster_work_units', 'shifts', 'module_catalog'].map(table).join('\n')}
      ALTER TABLE public.locations ADD FOREIGN KEY (canonical_place_id) REFERENCES public.canonical_places(id);
      ALTER TABLE public.client_sites ADD FOREIGN KEY (location_id) REFERENCES public.locations(id);
      ALTER TABLE public.location_zones ADD FOREIGN KEY (location_id) REFERENCES public.locations(id);
      ALTER TABLE public.service_agreement_locations ADD FOREIGN KEY (service_agreement_id)
        REFERENCES public.service_agreements(id);
      ALTER TABLE public.service_agreement_locations ADD FOREIGN KEY (zone_id) REFERENCES public.location_zones(id);
      ALTER TABLE public.service_agreement_locations ADD FOREIGN KEY (site_id) REFERENCES public.client_sites(id);
      ${['get_descendant_organizations', 'get_operating_organization_contexts',
        'user_can_operate_organization', 'is_admin_for_org', 'is_grand_master', 'is_platform_owner',
        'accessible_org_ids',
        'can_approve_action', 'tg_touch_updated_at', 'resolve_rate_rule',
        'manage_operating_branch_rate_rule', 'service_code_catalog', 'is_known_service_code',
        'tg_require_known_service_code'].map(definition).join('\n')}
      GRANT SELECT, UPDATE ON public.service_agreements TO service_role;
      GRANT TRUNCATE, TRIGGER ON public.rate_rules, public.service_agreements TO anon, authenticated, service_role;
      GRANT TRUNCATE, TRIGGER ON public.audit_log TO anon, authenticated, service_role;
      GRANT SELECT, INSERT ON public.audit_log TO authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.audit_log TO service_role;
      ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
      ${['audit_log_insert', 'audit_log_select', 'bob_full_read'].map(name => policy(name, 'audit_log')).join('\n')}
      GRANT SELECT ON public.rate_rules TO authenticated;
      ALTER TABLE public.rate_rules ENABLE ROW LEVEL SECURITY;
      ${['rate_rules_select', 'gm_full_access', 'bob_full_read'].map(name => policy(name, 'rate_rules')).join('\n')}
      CREATE FUNCTION public.test_noop_rate_trigger() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER trg_rate_rules_touch BEFORE UPDATE ON public.rate_rules
        FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
      CREATE TRIGGER trg_rate_rules_known_service_code BEFORE INSERT OR UPDATE OF service_type ON public.rate_rules
        FOR EACH ROW EXECUTE FUNCTION public.tg_require_known_service_code();
      CREATE TRIGGER trg_shifts_known_service_code BEFORE UPDATE OF service_type ON public.shifts
        FOR EACH ROW EXECUTE FUNCTION public.tg_require_known_service_code();
      INSERT INTO public.organizations(id,name,organization_type,parent_organization_id,active) VALUES
        ('${provider}','Provider','service_provider',NULL,true),
        ('${branch}','Branch','branch','${provider}',true),
        ('${other}','Other provider','service_provider',NULL,true),
        ('${lone}','Lone provider','service_provider',NULL,true),
        ('${clientA}','Client A','client',NULL,true),
        ('${clientB}','Client B','client',NULL,true),
        ('${clientC}','Client C','client',NULL,true),
        ('${clientD}','Client D','client',NULL,true),
        ('${tieClient}','Tie-break client','client',NULL,true),
        ('${foreignClient}','Foreign client','client',NULL,true);
      INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role,deactivated_at) VALUES
        ('${admin}','${provider}','${provider}','admin',NULL),
        ('${reviewer}','${provider}','${provider}','admin_officer',NULL),
        ('${outsider}','${other}','${other}','admin',NULL),
        ('${loneAdmin}','${lone}','${lone}','admin',NULL),
        ('${branchAdmin}','${branch}','${provider}','admin',NULL),
        ('${officer}','${lone}','${lone}','officer',NULL),
        ('${inactive}','${lone}','${lone}','admin',now()),
        ('${clientReader}','${clientA}',NULL,'officer',NULL),
        ('${providerOfficer}','${provider}','${provider}','officer',NULL),
        ('${branchOfficer}','${branch}','${provider}','officer',NULL);
      INSERT INTO public.staff_branch_authorisations(user_id,branch_org_id,role_at_branch,status) VALUES
        ('${branchAdmin}','${branch}','branch_manager','active'),
        ('${officer}','${branch}','officer','active'),
        ('${branchOfficer}','${branch}','officer','active');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,starts_on)
        VALUES ('${agreementA}','${provider}','${clientA}','Agreement A','2024-01-01'),
          ('${agreementB}','${other}','${foreignClient}','Foreign agreement','2024-01-01'),
          ('${agreementD}','${provider}','${clientD}','Agreement D','2024-01-01'),
          ('${branchAgreement}','${branch}','${clientD}','Branch agreement','2024-01-01');
      INSERT INTO public.staff_profiles(id,organization_id) VALUES
        ('${localStaff}','${provider}'), ('${foreignStaff}','${other}');
      INSERT INTO public.canonical_places(id,place_kind,canonical_key,display_name,normalized_name) VALUES
        ('${foreignPlace}','zone','zone:${foreignHouse}','Unrelated zone','unrelated zone'),
        ('${clientPlace}','zone','zone:${clientHouse}','Client zone','client zone'),
        ('${ownPlace}','zone','zone:${ownHouse}','Self-managed zone','self-managed zone');
      INSERT INTO public.locations(id,organization_id,name,canonical_place_id) VALUES
        ('${foreignHouse}','${foreignClient}','Unrelated house','${foreignPlace}'),
        ('${clientHouse}','${clientD}','Client house','${clientPlace}'),
        ('${ownHouse}','${provider}','Self-managed house','${ownPlace}');
      INSERT INTO public.location_zones(id,organization_id,name,location_id)
        VALUES ('${foreignZone}','${foreignClient}','Unrelated zone','${foreignHouse}'),
          ('${clientZone}','${clientD}','Client zone','${clientHouse}'),
          ('${ownZone}','${provider}','Self-managed zone','${ownHouse}'),
          ('${unlinkedClientZone}','${clientD}','Unlinked client zone','${clientHouse}');
      INSERT INTO public.client_sites(id,client_organization_id,name,location_id)
        VALUES ('${clientSite}','${clientD}','Client site','${clientHouse}'),
          ('${ownSite}','${provider}','Self-managed site','${ownHouse}');
      INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id)
        VALUES ('${agreementB}','${foreignZone}'), ('${agreementD}','${clientZone}');
      INSERT INTO public.service_agreement_locations(service_agreement_id,site_id)
        VALUES ('${agreementD}','${clientSite}');
      INSERT INTO public.reference_codes(organization_id,code_type,code,name,is_active) VALUES
        ('${provider}','pay_item','PAY1','Standard pay',true),
        ('${provider}','pay_item','OLD','Inactive pay',false),
        ('${provider}','role_code','GUARD','Guard',true),
        ('${provider}','role_code','SUPERVISOR','Supervisor',true),
        ('${provider}','role_code','OLD_ROLE','Inactive role',false),
        ('${other}','role_code','GUARD','Other guard',true),
        ('${other}','role_code','FOREIGN_ROLE','Foreign role',true),
        ('${provider}','service_code','patrol','Patrol',true),
        ('${provider}','service_code','excavator','Excavator',true),
        ('${provider}','service_code','historic_task','Historic task',true),
        ('${provider}','service_code','retired_scope','Retired scope',true),
        ('${provider}','service_code','retired_aux','Other retired task',false),
        ('${provider}','service_code','retired_pending','Pending task',true),
        ('${provider}','service_code','retired_review','Review task',true),
        ('${provider}','service_code','retired_race_draft','Draft race task',true),
        ('${provider}','service_code','retired_race_approval','Approval race task',true),
        ('${provider}','service_code','retired_changed','Changed task',true),
        ('${other}','service_code','retired_scope','Other scope',true);
      INSERT INTO public.assets(id,organization_id,asset_type,name,status) VALUES
        ('${homeAsset}','${provider}','equipment','Excavator','available'),
        ('${foreignAsset}','${other}','equipment','Foreign excavator','available'),
        ('${retiredAsset}','${provider}','equipment','Retired excavator','retired'),
        ('${scopeAsset}','${provider}','equipment','Scope equipment','available');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end)
        VALUES ('${shiftProbe}','${provider}','${admin}','patrol',now(),now()+interval '1 hour');
      INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,
        client_org_id,service_type,region_code,job_code,vehicle_type,outside_area,
        distance_min_km,distance_max_km,effective_from,active)
      VALUES
        ('${legacyA}','${provider}','billing','Client A patrol','hourly',50,'${clientA}',
          'patrol','NZ-TAS','patrol-job','van',false,2,20,'2024-01-01',true),
        ('${legacyB}','${provider}','billing','Client B patrol','hourly',55,'${clientB}',
          'patrol',NULL,NULL,NULL,NULL,NULL,NULL,'2024-01-01',true),
        ('${legacyC}','${provider}','billing','Client C patrol','hourly',60,'${clientC}',
          'patrol',NULL,NULL,NULL,NULL,NULL,NULL,'2024-01-01',true),
        ('${legacyStandard}','${provider}','billing','Standard patrol','hourly',40,NULL,
          'patrol',NULL,NULL,NULL,NULL,NULL,NULL,'2024-01-01',true);
      INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,
        client_org_id,service_type,effective_from,active,updated_at)
      VALUES
        ('${tieOlder}','${provider}','billing','Older matching rate','hourly',71,'${tieClient}',
          'patrol','2024-01-01',true,'2025-01-01 00:00:00+00'),
        ('${tieNewer}','${provider}','billing','Newer matching rate','hourly',72,'${tieClient}',
          'patrol','2024-01-01',true,'2026-01-01 00:00:00+00');
      CREATE TABLE public.test_priced_work(id uuid PRIMARY KEY, rate_rule_id uuid, amount numeric);
      INSERT INTO public.test_priced_work VALUES ('${id(100)}','${legacyA}',50);
      CREATE FUNCTION public.test_fail_rate_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.fail_rate_audit', true) = 'yes'
          AND NEW.action = 'rate_card_version_approved' THEN
          RAISE EXCEPTION 'injected audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_fail_rate_audit BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.test_fail_rate_audit();
      CREATE FUNCTION public.test_tamper_rate_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('test.tamper_rate_audit', true) = 'yes'
          AND NEW.action = 'rate_card_line_create' THEN
          NEW.metadata := NEW.metadata || '{"tampered":true}'::jsonb;
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_tamper_rate_audit BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.test_tamper_rate_audit();
      CREATE FUNCTION public.test_pause_rate_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (current_setting('test.pause_rate_audit', true) = 'yes'
            AND NEW.action = 'rate_card_version_approved')
          OR (current_setting('test.pause_rate_line_audit', true) = 'yes'
            AND NEW.action = 'rate_card_line_create') THEN
          PERFORM pg_catalog.pg_advisory_xact_lock(620231::bigint);
        END IF;
        RETURN NEW;
      END $$;
      ${foundation}
      CREATE TABLE public.test_legacy_rate_revisions AS
        SELECT id, updated_at, active FROM public.rate_rules;
    `);

    await t.test('refuses_unreviewed_audit_triggers_during_migration', () => {
      const transactionalLifecycle = lifecycle.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
      fails(`BEGIN; ${transactionalLifecycle} ROLLBACK;`, /audit.*trigger|trigger.*audit/i);
    });
    sql(`
      DROP TRIGGER test_fail_rate_audit ON public.audit_log;
      DROP TRIGGER test_tamper_rate_audit ON public.audit_log;
      ${lifecycle}
      CREATE TRIGGER test_fail_rate_audit BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.test_fail_rate_audit();
      CREATE TRIGGER test_tamper_rate_audit BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.test_tamper_rate_audit();
      CREATE TRIGGER test_pause_rate_audit BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.test_pause_rate_audit();
    `);

    await t.test('preserves_legacy_rule_revisions_and_enabled_state', () => {
      assert.equal(sql(`SELECT count(*) FROM public.test_legacy_rate_revisions prior
        JOIN public.rate_rules r ON r.id=prior.id
        WHERE r.updated_at IS DISTINCT FROM prior.updated_at
          OR coalesce(r.rate_card_line_enabled,r.active) IS DISTINCT FROM prior.active;`), '0');
    });

    await t.test('legacy_writer_deactivation_remains_disabled_for_card_cutover', () => {
      const created = rpc(admin, `row_to_json(public.manage_operating_branch_rate_rule(
        p_operating_organization_id => '${provider}', p_client_request_id => '${randomUUID()}',
        p_action => 'create', p_rule_kind => 'billing', p_name => 'Legacy temporary rate',
        p_rate_type => 'hourly', p_amount => 35, p_client_org_id => '${clientD}'))`);
      assert.equal(created.rate_card_version_id, null);
      assert.equal(created.active, true);
      const retired = rpc(admin, `row_to_json(public.manage_operating_branch_rate_rule(
        p_operating_organization_id => '${provider}', p_client_request_id => '${randomUUID()}',
        p_action => 'deactivate', p_rate_rule_id => '${created.id}',
        p_expected_updated_at => '${created.updated_at}'))`);
      assert.equal(retired.active, false);
      assert.equal(sql(`SELECT coalesce(rate_card_line_enabled, active)
        FROM public.rate_rules WHERE id='${created.id}';`), 'f');
    });

    await t.test('requires_finance_for_decision', () => {
      const card = cardFor(clientB);
      const v = start(admin, card).version;
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      const pending = version(v.id);
      const expression = decideExpression(randomUUID(), v.id, 'approve', 'No authority', pending.updated_at);
      fails(`${actor(outsider)} SELECT ${expression};`, /finance|authori[sz]|permission/i);
      fails(`${actor(inactive)} SELECT ${expression};`, /finance|authori[sz]|permission/i);
      fails(`SET ROLE anon; SELECT ${expression};`, /permission denied/i);
      const submittedLine = sql(`SELECT id FROM public.rate_rules WHERE rate_card_version_id='${v.id}' LIMIT 1;`);
      fails(`UPDATE public.rate_rules SET amount=999 WHERE id='${submittedLine}';`, /submitted|immutable/i);
      assert.equal(version(v.id).status, 'draft');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE target_id='${v.id}'
        AND action='rate_card_version_approved';`), '0');
    });

    await t.test('keeps_draft_prices_out_of_resolution', () => {
      const card = cardFor(clientA);
      const old = versionFor(card);
      const v = start(admin, card, old.id).version;
      const copied = json(`SELECT row_to_json(r) FROM public.rate_rules r
        WHERE rate_card_version_id='${v.id}' AND rate_line_key=(SELECT rate_line_key FROM public.rate_rules WHERE id='${legacyA}');`);
      assert.deepEqual(
        [copied.region_code, copied.job_code, copied.vehicle_type, copied.outside_area,
          Number(copied.distance_min_km), Number(copied.distance_max_km)],
        ['NZ-TAS', 'patrol-job', 'van', false, 2, 20]);
      draft(admin, { version: v.id, expectedAt: version(v.id).updated_at, action: 'update',
        rule: copied.id, name: copied.name, type: copied.rate_type, amount: 99,
        group: copied.rate_group, scope: {}, from: copied.effective_from });
      assert.equal(line(copied.id).job_code, 'patrol-job', 'A partial scope edit preserves untouched dimensions');
      assert.equal(Number(resolve(clientA).amount), 50);
      assert.equal(line(copied.id).active, false);
      assert.equal(copied.rate_card_line_enabled, true);
      submit(admin, v.id, '2099-01-01', version(v.id).updated_at);
      assert.equal(Number(resolve(clientA).amount), 50);
      decide(reviewer, v.id, 'approve', version(v.id).updated_at);
      assert.equal(Number(resolve(clientA).amount), 50);
      assert.equal(Number(resolve(clientA, '2099-06-01T12:00:00+12:00').amount), 50);
      assert.equal(line(copied.id).active, false, 'Task 3, not approval, owns resolver activation');
      assert.equal(sql(`SELECT amount FROM public.test_priced_work WHERE id='${id(100)}';`), '50');
      assert.equal(sql(`SELECT rate_rule_id FROM public.test_priced_work WHERE id='${id(100)}';`), legacyA);
    });

    await t.test('rejects_overlapping_or_non_monotonic_version_dates', () => {
      const card = cardFor(clientC);
      const old = versionFor(card);
      const v = start(admin, card, old.id).version;
      const before = version(v.id);
      for (const date of ['2024-01-01', '2023-12-31']) {
        fails(`${actor(admin)} SELECT ${submitExpression(randomUUID(), v.id, date, 'Too early', before.updated_at)};`,
          /start|overlap|after|chronolog/i);
      }
      assert.equal(versionFor(card).id, old.id);
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      decide(reviewer, v.id, 'approve', version(v.id).updated_at);
      assert.equal(version(old.id).status, 'superseded');
      assert.equal(version(old.id).effective_to, '2026-12-31');
      const next = start(admin, card, v.id).version;
      fails(`${actor(admin)} SELECT ${submitExpression(randomUUID(), next.id, '2027-01-01',
        'Same date', version(next.id).updated_at)};`, /start|overlap|after|chronolog/i);
    });

    await t.test('copies_lineage_but_not_approved_mutability', () => {
      const card = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${provider}'
        AND kind='charge' AND is_standard;`);
      const old = versionFor(card);
      const v = start(admin, card, old.id).version;
      const original = line(legacyStandard);
      const copy = json(`SELECT row_to_json(r) FROM public.rate_rules r
        WHERE rate_card_version_id='${v.id}' AND rate_line_key='${original.rate_line_key}';`);
      assert.notEqual(copy.id, original.id);
      assert.equal(copy.rate_line_key, original.rate_line_key);
      assert.equal(copy.active, false);
      fails(`UPDATE public.rate_rules SET amount=999 WHERE id='${legacyStandard}';`, /immutable|approved/i);
      fails(`DELETE FROM public.rate_rules WHERE id='${legacyStandard}';`, /immutable|approved/i);
      fails(`UPDATE public.rate_card_versions SET change_note='rewrite' WHERE id='${old.id}';`, /immutable|approved/i);
      const opened = version(v.id).updated_at;
      draft(admin, { version: v.id, expectedAt: opened, action: 'update', rule: copy.id,
        name: copy.name, type: copy.rate_type, amount: 41, group: copy.rate_group, scope: {},
        from: copy.effective_from });
      fails(`${actor(admin)} SELECT ${draftExpression({ request: randomUUID(), version: v.id,
        expectedAt: opened, action: 'update', rule: copy.id, name: copy.name, type: copy.rate_type,
        amount: 42, group: copy.rate_group, scope: {}, from: copy.effective_from, to: null, asset: null })};`,
      /changed|stale|revision/i);
      assert.equal(Number(line(copy.id).amount), 41);
      assert.equal(Number(line(legacyStandard).amount), 40);
    });

    await t.test('copy_preserves_the_existing_resolver_updated_at_tiebreak', () => {
      const card = cardFor(tieClient);
      const prior = versionFor(card);
      const resolved = resolve(tieClient);
      assert.equal(resolved.rate_rule_id, tieNewer);
      assert.equal(Number(resolved.amount), 72);
      const next = start(admin, card, prior.id).version;
      const preservesWinner = versionId => sql(`SELECT newer.updated_at > older.updated_at
          FROM public.rate_rules newer
          JOIN public.rate_rules older ON older.rate_card_version_id = newer.rate_card_version_id
          WHERE newer.rate_card_version_id = '${versionId}'
            AND newer.rate_line_key = (SELECT rate_line_key FROM public.rate_rules WHERE id='${tieNewer}')
            AND older.rate_line_key = (SELECT rate_line_key FROM public.rate_rules WHERE id='${tieOlder}');`);
      assert.equal(preservesWinner(next.id), 't', 'Copying equal-scope rates must retain their former winner');
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules copied
        JOIN public.rate_rules original ON original.rate_line_key=copied.rate_line_key
          AND original.rate_card_version_id='${prior.id}'
        WHERE copied.rate_card_version_id='${next.id}'
          AND (copied.updated_at IS DISTINCT FROM original.updated_at OR copied.active);`), '0');
      submit(admin, next.id, '2027-01-01', version(next.id).updated_at);
      decide(reviewer, next.id, 'approve', version(next.id).updated_at);
      const following = start(admin, card, next.id).version;
      assert.equal(preservesWinner(following.id), 't', 'Ordering survives subsequent version copies');
      assert.equal(Number(resolve(tieClient).amount), 72, 'The legacy resolver remains unchanged');
    });

    await t.test('legacy_writer_cannot_bypass_the_draft_revision', () => {
      const card = manage(admin, { client: clientD, name: 'Protected draft' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at });
      const savedVersion = version(v.id);
      const savedLine = saved.result.line;
      assert.deepEqual(rpc(admin, saved.expression), saved.result);
      fails(`${actor(admin)} SELECT ${draftExpression({ ...saved, amount: 81 })};`, /request|retry|replay/i);
      fails(`${actor(admin)} SELECT public.manage_operating_branch_rate_rule(
        p_operating_organization_id => '${provider}',
        p_client_request_id => '${randomUUID()}', p_action => 'update',
        p_rate_rule_id => '${savedLine.id}', p_expected_updated_at => '${savedLine.updated_at}',
        p_name => 'Unversioned change', p_rate_type => 'hourly', p_amount => 123,
        p_client_org_id => '${clientD}');`, /governed|draft|approval|permission/i);
      assert.equal(Number(line(savedLine.id).amount), 80);
      assert.equal(version(v.id).updated_at, savedVersion.updated_at);
      assert.equal(sql('SELECT count(*) FROM public._rate_card_write_context;'), '0');
      fails(`${actor(admin)} INSERT INTO public._rate_card_write_context
        VALUES (pg_backend_pid(), txid_current(), '${v.id}');`, /permission denied/i);
    });

    await t.test('makes_approval_atomic_and_idempotent', () => {
      const card = manage(admin, { client: clientD, name: 'Atomic card' }).result.card;
      const v = start(admin, card.id, null).version;
      draft(admin, { version: v.id, expectedAt: version(v.id).updated_at });
      submit(admin, v.id, '2028-01-01', version(v.id).updated_at);
      const pending = version(v.id);
      const failedRequest = randomUUID();
      const failed = decideExpression(failedRequest, v.id, 'approve', 'Audited', pending.updated_at);
      fails(`SET test.fail_rate_audit='yes'; ${actor(reviewer)} SELECT ${failed};`, /injected audit failure/i);
      assert.equal(version(v.id).status, 'draft', 'Failed audit rolled back approval');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE target_id='${v.id}'
        AND action='rate_card_version_approved';`), '0');
      const request = randomUUID();
      const expression = decideExpression(request, v.id, 'approve', 'Audited', pending.updated_at);
      const first = rpc(reviewer, expression);
      const replay = rpc(reviewer, expression);
      assert.deepEqual(replay, first);
      assert.equal(version(v.id).status, 'approved');
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE target_id='${v.id}'
        AND action='rate_card_version_approved';`), '1');
      fails(`${actor(reviewer)} SELECT ${decideExpression(request, v.id, 'reject', 'Changed', pending.updated_at)};`,
        /request|retry|replay/i);
      fails(`${actor(admin)} SELECT ${expression};`, /request|retry|replay/i);
      fails(`${actor(reviewer)} SELECT ${decideExpression(randomUUID(), v.id, 'approve', 'Again', pending.updated_at)};`,
        /changed|stale|already|draft|pending/i);
    });

    await t.test('retains_full_receipt_if_the_legacy_audit_log_is_truncated', () => {
      const card = manage(admin, { client: clientD, name: 'Receipt evidence card' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at });
      const audit = json(`SELECT row_to_json(a) FROM public.audit_log a
        WHERE a.metadata->>'client_request_id'='${saved.request}';`);
      const receipt = json(`SELECT row_to_json(r) FROM public.rate_card_request_receipts r
        WHERE r.client_request_id='${saved.request}';`);
      assert.equal(receipt.audit_log_id, audit.id);
      assert.equal(receipt.target_table, audit.target_table);
      assert.equal(receipt.target_id, audit.target_id);
      assert.equal(receipt.audit_created_at, audit.created_at);
      assert.deepEqual(receipt.audit_metadata, audit.metadata);
      assert.equal(receipt.audit_metadata.client_request_id, saved.request);
      assert.equal(receipt.audit_metadata.version_id, v.id);
      assert.equal(receipt.audit_metadata.before, null);
      assert.deepEqual(receipt.audit_metadata.after, saved.result.line);
      const afterTruncate = json(`BEGIN; SET ROLE anon; TRUNCATE public.audit_log; RESET ROLE;
        SELECT row_to_json(r) FROM public.rate_card_request_receipts r
        WHERE r.client_request_id='${saved.request}'; ROLLBACK;`);
      assert.deepEqual(afterTruncate, receipt);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        fails(`SET ROLE ${role}; TRUNCATE public.rate_card_request_receipts;`, /permission denied/i);
      }
    });

    await t.test('rejects_tampered_audit_evidence_atomically', () => {
      const card = manage(admin, { client: clientD, name: 'Tampered audit card' }).result.card;
      const v = start(admin, card.id, null).version;
      const expectedAt = version(v.id).updated_at;
      const request = randomUUID();
      const expression = draftExpression({ request, version: v.id, expectedAt, action: 'create',
        rule: null, name: 'Tampered evidence', type: 'hourly', amount: 80, group: null,
        scope: {}, from: null, to: null, asset: null });
      fails(`SET test.tamper_rate_audit='yes'; ${actor(admin)} SELECT ${expression};`, /audit|receipt|evidence/i);
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_card_version_id='${v.id}';`), '0');
      assert.equal(version(v.id).updated_at, expectedAt);
      assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts WHERE client_request_id='${request}';`), '0');
    });

    await t.test('client_cannot_read_provider_private_pay_snapshots_from_audit', () => {
      const card = manage(admin, { kind: 'pay', client: null, name: 'Private pay' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        name: 'Private staff pay', amount: 63.75,
        scope: { pay_code: 'PAY1', role_code: 'GUARD', staff_id: localStaff } });
      assert.equal(sql(`${actor(clientReader)} SELECT '${provider}'::uuid = ANY(public.accessible_org_ids());`), 't');
      assert.equal(sql(`${actor(clientReader)} SELECT public.user_can_operate_organization('${provider}');`), 'f');
      assert.equal(sql(`${actor(clientReader)} SELECT count(*) FROM public.rate_rules
        WHERE id='${saved.result.line.id}';`), '0');
      assert.equal(sql(`SELECT audit_metadata->'after'->>'amount' FROM public.rate_card_request_receipts
        WHERE client_request_id='${saved.request}';`), '63.75');
      assert.equal(sql(`${actor(admin)} SELECT count(*) FROM public.audit_log
        WHERE target_id='${saved.result.line.id}' AND action='rate_card_line_create';`), '1');
      const exposed = sql(`${actor(clientReader)} SELECT count(*) FROM public.audit_log
        WHERE target_id='${saved.result.line.id}' AND action='rate_card_line_create'
          AND (metadata->'after'->>'amount'='63.75' OR metadata->'after'->>'staff_id'='${localStaff}'
            OR metadata->'after'->>'pay_code'='PAY1');`);
      assert.equal(exposed, '0', 'The client must not see the provider pay snapshot');
    });

    await t.test('client_cannot_read_another_clients_charge_snapshot_from_audit', () => {
      const card = manage(admin, { client: clientD, name: 'Other client prices' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        name: 'Private client charge', amount: 937.12 });
      assert.equal(sql(`${actor(clientReader)} SELECT '${clientD}'::uuid = ANY(public.accessible_org_ids());`), 'f');
      assert.equal(sql(`${actor(clientReader)} SELECT count(*) FROM public.rate_rules
        WHERE id='${saved.result.line.id}';`), '0');
      assert.equal(sql(`SELECT audit_metadata->'after'->>'amount' FROM public.rate_card_request_receipts
        WHERE client_request_id='${saved.request}';`), '937.12');
      assert.equal(sql(`${actor(admin)} SELECT count(*) FROM public.audit_log
        WHERE target_id='${saved.result.line.id}' AND action='rate_card_line_create';`), '1');
      const exposed = sql(`${actor(clientReader)} SELECT count(*) FROM public.audit_log
        WHERE target_id='${saved.result.line.id}' AND action='rate_card_line_create'
          AND (metadata->'after'->>'amount'='937.12'
            OR metadata->'after'->>'client_org_id'='${clientD}');`);
      assert.equal(exposed, '0', 'The client must not see another client’s rate snapshot');
    });

    await t.test('operating_officer_cannot_read_finance_audit_snapshots', () => {
      const card = manage(branchAdmin, { org: branch, client: clientD, name: 'Branch private audit' }).result.card;
      const v = start(branchAdmin, card.id, null).version;
      const saved = draft(branchAdmin, { version: v.id, expectedAt: version(v.id).updated_at, amount: 741.25 });
      assert.equal(sql(`${actor(branchOfficer)} SELECT public.user_can_operate_organization('${branch}')
        AND NOT public.is_admin_for_org('${branch}');`), 't');
      assert.equal(sql(`${actor(branchOfficer)} SELECT count(*) FROM public.rate_rules
        WHERE id='${saved.result.line.id}';`), '1', 'The existing rate-rules policy is unchanged');
      assert.equal(sql(`${actor(branchAdmin)} SELECT metadata->'after'->>'amount' FROM public.audit_log
        WHERE target_id='${saved.result.line.id}' AND action='rate_card_line_create';`), '741.25');
      assert.equal(sql(`${actor(branchOfficer)} SELECT count(*) FROM public.audit_log
        WHERE target_id='${saved.result.line.id}' AND action='rate_card_line_create';`), '0');
    });

    await t.test('ordinary_accessible_users_keep_their_existing_audit_insert_path', () => {
      const eventId = randomUUID();
      sql(`${actor(clientReader)} INSERT INTO public.audit_log
        (id,organization_id,actor_user_id,action)
        VALUES ('${eventId}','${clientA}','${clientReader}','ordinary_test_event');`);
      assert.equal(sql(`${actor(clientReader)} SELECT count(*) FROM public.audit_log WHERE id='${eventId}';`), '1');
      const bob = '00000000-0000-0000-0000-00000000b0b0';
      assert.equal(sql(`${actor(bob)} SELECT count(*) FROM public.audit_log WHERE id='${eventId}';`), '1');
      sql(`SET ROLE service_role; UPDATE public.audit_log SET metadata='{"ordinary":true}' WHERE id='${eventId}';`);
      assert.equal(sql(`SELECT metadata->>'ordinary' FROM public.audit_log WHERE id='${eventId}';`), 'true');
    });

    await t.test('bob_special_reader_cannot_bypass_new_finance_audit_privacy', () => {
      const card = manage(admin, { client: clientD, name: 'Bob finance privacy' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at, amount: 481.19 });
      const bob = '00000000-0000-0000-0000-00000000b0b0';
      assert.equal(sql(`${actor(bob)} SELECT count(*) FROM public.audit_log
        WHERE target_id='${saved.result.line.id}' AND action='rate_card_line_create';`), '0');
    });

    for (const role of ['anon', 'authenticated', 'service_role']) {
      await t.test(`${role}_cannot_install_shared_audit_triggers`, () => {
        fails(`BEGIN; SET ROLE ${role}; CREATE TRIGGER forged_rate_audit BEFORE INSERT ON public.audit_log
          FOR EACH ROW EXECUTE FUNCTION public.test_noop_rate_trigger(); ROLLBACK;`, /permission denied/i);
      });
    }

    for (const [label, prefix] of [['finance', actor(admin)], ['service_role', 'SET ROLE service_role;']]) {
      await t.test(`${label}_cannot_forge_lifecycle_audit_actions`, () => {
        fails(`${prefix} INSERT INTO public.audit_log
          (organization_id,actor_user_id,action,target_table,target_id,metadata)
          VALUES ('${provider}','${admin}','rate_card_version_approved','rate_card_versions',
            '${randomUUID()}',jsonb_build_object('client_request_id','${randomUUID()}'));`,
        /permission|forbidden|reserved|authori[sz]|audit/i);
      });
    }

    await t.test('service_role_cannot_rewrite_or_delete_lifecycle_audit_evidence', () => {
      const card = manage(admin, { client: clientD, name: 'Immutable audit evidence' }).result.card;
      const auditId = sql(`SELECT audit_log_id FROM public.rate_card_request_receipts
        WHERE target_id='${card.id}' AND operation='rate_card_create';`);
      const accepted = [];
      for (const statement of [
        `UPDATE public.audit_log SET metadata='{"forged":true}' WHERE id='${auditId}'`,
        `DELETE FROM public.audit_log WHERE id='${auditId}'`,
        `UPDATE public.audit_log SET action='rate_card_version_approved'
          WHERE action='ordinary_test_event'`,
      ]) {
        try {
          sql(`BEGIN; SET ROLE service_role; ${statement}; ROLLBACK;`);
          accepted.push(true);
        } catch (error) {
          assert.match(String(error.stderr ?? error.message), /permission|immutable|reserved|audit/i);
          accepted.push(false);
        }
      }
      assert.deepEqual(accepted, [false, false, false]);
      assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE id='${auditId}'
        AND action='rate_card_create';`), '1');
    });

    for (const [label, who] of [['client', clientReader], ['provider_officer', providerOfficer]]) {
      await t.test(`${label}_cannot_forge_lifecycle_audit_actions`, () => {
        const card = manage(admin, { client: clientD, name: 'Audit forgery probe' }).result.card;
        const v = start(admin, card.id, null).version;
        submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
        const request = randomUUID();
        assert.equal(sql(`${actor(who)} SELECT '${provider}'::uuid = ANY(public.accessible_org_ids());`), 't');
        assert.equal(sql(`${actor(who)} SELECT public.is_admin_for_org('${provider}');`), 'f');
        let accepted = false;
        try {
          sql(`${actor(who)} INSERT INTO public.audit_log
            (organization_id,actor_user_id,action,target_table,target_id,metadata)
            VALUES ('${provider}','${who}','rate_card_version_approved','rate_card_versions',
              '${v.id}',jsonb_build_object('client_request_id','${request}','after',
                jsonb_build_object('status','approved')));`);
          accepted = true;
        } catch (error) {
          assert.match(String(error.stderr ?? error.message), /permission|forbidden|reserved|authori[sz]|audit/i);
        }
        assert.equal(version(v.id).status, 'draft', 'An audit insert must not approve a version');
        assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
          WHERE client_request_id='${request}';`), '0');
        assert.equal(accepted, false, 'A non-finance user must not create an authentic-looking approval event');
      });
    }

    await t.test('audits_lone_finance_self_approval', () => {
      const card = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${lone}'
        AND kind='charge' AND is_standard;`);
      const old = versionFor(card);
      const v = start(loneAdmin, card, old.id).version;
      draft(loneAdmin, { version: v.id, expectedAt: version(v.id).updated_at });
      submit(loneAdmin, v.id, '2027-01-01', version(v.id).updated_at);
      decide(loneAdmin, v.id, 'approve', version(v.id).updated_at);
      const audit = json(`SELECT metadata FROM public.audit_log WHERE target_id='${v.id}'
        AND action='rate_card_version_approved';`);
      assert.equal(audit.self_approval_exception, true);
      assert.equal(version(v.id).approved_by, loneAdmin);

      const branchCard = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${branch}'
        AND kind='charge' AND is_standard;`);
      const branchOld = versionFor(branchCard);
      const b = start(admin, branchCard, branchOld.id).version;
      draft(admin, { version: b.id, expectedAt: version(b.id).updated_at });
      submit(admin, b.id, '2027-01-01', version(b.id).updated_at);
      fails(`${actor(officer)} SELECT ${decideExpression(randomUUID(), b.id, 'approve',
        'Branch officer without finance access', version(b.id).updated_at)};`, /finance|authori[sz]|permission/i);
      fails(`${actor(admin)} SELECT ${decideExpression(randomUUID(), b.id, 'approve',
        'Another authorized finance user exists', version(b.id).updated_at)};`, /another|self.approv/i);
      decide(branchAdmin, b.id, 'approve', version(b.id).updated_at);
    });

    await t.test('self_approval_fails_closed_during_concurrent_authority_change', async () => {
      const card = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${lone}'
        AND kind='charge' AND is_standard;`);
      const v = start(loneAdmin, card, versionFor(card).id).version;
      submit(loneAdmin, v.id, '2028-01-01', version(v.id).updated_at);
      const expectedAt = version(v.id).updated_at;
      const request = randomUUID();
      const expression = decideExpression(request, v.id, 'approve', 'One finance user', expectedAt);
      const first = concurrentSql(`SET application_name='fcm_authority_race'; BEGIN;
        UPDATE public.user_profiles SET deactivated_at=NULL WHERE id='${inactive}';
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; ROLLBACK;`);
      let sleeping = false;
      try {
        await waitForSleepingBackend('fcm_authority_race');
        sleeping = true;
        fails(`${actor(loneAdmin)} SELECT ${expression};`, /could not obtain lock|lock.*not available/i);
        assert.equal(version(v.id).status, 'draft');
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_authority_race');
        const result = await first;
        assert.equal(result.code, 0, result.stderr);
      }
      assert.equal(decide(loneAdmin, v.id, 'approve', expectedAt, request, 'One finance user')
        .self_approval_exception, true);
    });

    await t.test('revoked_reviewer_cannot_approve_after_waiting_for_the_card_lock', async () => {
      const card = manage(admin, { client: clientD, name: 'Revoked reviewer' }).result.card;
      const v = start(admin, card.id, null).version;
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      const request = randomUUID();
      const expression = decideExpression(request, v.id, 'approve', 'Review', version(v.id).updated_at);
      const lockHolder = concurrentSql(`SET application_name='fcm_card_lock_holder'; BEGIN;
        SELECT id FROM public.rate_cards WHERE id='${card.id}' FOR UPDATE;
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false;
      let decision;
      let result;
      let revokedBeforeDecision = false;
      try {
        await waitForSleepingBackend('fcm_card_lock_holder');
        sleeping = true;
        decision = concurrentSql(`SET application_name='fcm_revoked_reviewer'; ${actor(reviewer)}
          SELECT ${expression};`);
        await waitForBlockedBackend('fcm_revoked_reviewer');
        try {
          sql(`SET lock_timeout='2s'; UPDATE public.user_profiles SET deactivated_at=clock_timestamp()
            WHERE id='${reviewer}';`);
          revokedBeforeDecision = true;
        } catch (error) {
          assert.match(String(error.stderr ?? error.message), /lock timeout/i);
        }
        if (revokedBeforeDecision) {
          assert.equal(sql(`${actor(reviewer)} SELECT
            public.user_can_operate_organization('${provider}') AND public.is_admin_for_org('${provider}');`), 'f');
        }
        releaseSleepingBackend('fcm_card_lock_holder');
        sleeping = false;
        result = await decision;
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_card_lock_holder');
        const held = await lockHolder;
        assert.equal(held.code, 0, held.stderr);
        if (decision) await decision;
        sql(`UPDATE public.user_profiles SET deactivated_at=NULL WHERE id='${reviewer}';`);
      }
      if (revokedBeforeDecision) {
        assert.notEqual(result.code, 0, 'Approval must fail when authority was revoked before the card lock');
        assert.match(result.stderr, /finance|authori[sz]|permission|concurr|lock/i);
        assert.equal(version(v.id).status, 'draft');
        assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
          WHERE client_request_id='${request}';`), '0');
      } else if (result.code !== 0) {
        assert.match(result.stderr, /finance|authori[sz]|permission|concurr|lock/i);
        assert.equal(version(v.id).status, 'draft');
      } else {
        assert.equal(version(v.id).status, 'approved');
      }
    });

    await t.test('revoked_branch_assignment_cannot_approve_after_waiting_for_the_card_lock', async () => {
      sql(`INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role)
        VALUES ('${assignedReviewer}','${branch}','${other}','admin');
        INSERT INTO public.staff_branch_authorisations(user_id,branch_org_id,role_at_branch,status)
        VALUES ('${assignedReviewer}','${branch}','branch_manager','active');`);
      const card = manage(branchAdmin, { org: branch, client: clientD, name: 'Branch assignment race' }).result.card;
      const v = start(branchAdmin, card.id, null).version;
      submit(branchAdmin, v.id, '2027-01-01', version(v.id).updated_at);
      assert.equal(sql(`${actor(assignedReviewer)} SELECT public.user_can_operate_organization('${branch}')
        AND public.is_admin_for_org('${branch}');`), 't');
      const request = randomUUID();
      const expression = decideExpression(request, v.id, 'approve', 'Review', version(v.id).updated_at);
      const lockHolder = concurrentSql(`SET application_name='fcm_assignment_card_lock'; BEGIN;
        SELECT id FROM public.rate_cards WHERE id='${card.id}' FOR UPDATE;
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false, decision;
      try {
        await waitForSleepingBackend('fcm_assignment_card_lock');
        sleeping = true;
        decision = concurrentSql(`SET application_name='fcm_assignment_reviewer'; ${actor(assignedReviewer)}
          SELECT ${expression};`);
        await waitForBlockedBackend('fcm_assignment_reviewer');
        sql(`UPDATE public.staff_branch_authorisations SET status='ended'
          WHERE user_id='${assignedReviewer}' AND branch_org_id='${branch}';`);
        assert.equal(sql(`${actor(assignedReviewer)} SELECT public.user_can_operate_organization('${branch}');`), 'f');
        releaseSleepingBackend('fcm_assignment_card_lock');
        sleeping = false;
        const result = await decision;
        assert.notEqual(result.code, 0, 'Revoked branch assignment must not authorize the decision');
        assert.match(result.stderr, /finance|authori[sz]|permission|concurr|lock/i);
        assert.equal(version(v.id).status, 'draft');
        assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
          WHERE client_request_id='${request}';`), '0');
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_assignment_card_lock');
        const held = await lockHolder;
        assert.equal(held.code, 0, held.stderr);
        if (decision) await decision;
        sql(`UPDATE public.user_profiles SET deactivated_at=clock_timestamp() WHERE id='${assignedReviewer}';`);
      }
    });

    await t.test('revoked_ancestor_cannot_approve_after_waiting_for_the_card_lock', async () => {
      const card = manage(branchAdmin, { org: branch, client: clientD, name: 'Branch ancestry race' }).result.card;
      const v = start(branchAdmin, card.id, null).version;
      submit(branchAdmin, v.id, '2027-01-01', version(v.id).updated_at);
      assert.equal(sql(`${actor(reviewer)} SELECT public.user_can_operate_organization('${branch}')
        AND public.is_admin_for_org('${branch}');`), 't');
      const request = randomUUID();
      const expression = decideExpression(request, v.id, 'approve', 'Review', version(v.id).updated_at);
      const lockHolder = concurrentSql(`SET application_name='fcm_ancestry_card_lock'; BEGIN;
        SELECT id FROM public.rate_cards WHERE id='${card.id}' FOR UPDATE;
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false, decision;
      try {
        await waitForSleepingBackend('fcm_ancestry_card_lock');
        sleeping = true;
        decision = concurrentSql(`SET application_name='fcm_ancestry_reviewer'; ${actor(reviewer)}
          SELECT ${expression};`);
        await waitForBlockedBackend('fcm_ancestry_reviewer');
        sql(`UPDATE public.organizations SET parent_organization_id='${other}' WHERE id='${branch}';`);
        assert.equal(sql(`${actor(reviewer)} SELECT public.user_can_operate_organization('${branch}');`), 'f');
        releaseSleepingBackend('fcm_ancestry_card_lock');
        sleeping = false;
        const result = await decision;
        assert.notEqual(result.code, 0, 'Revoked ancestor must not authorize the decision');
        assert.match(result.stderr, /finance|authori[sz]|permission|concurr|lock/i);
        assert.equal(version(v.id).status, 'draft');
        assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
          WHERE client_request_id='${request}';`), '0');
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_ancestry_card_lock');
        const held = await lockHolder;
        assert.equal(held.code, 0, held.stderr);
        if (decision) await decision;
        sql(`UPDATE public.organizations SET parent_organization_id='${provider}' WHERE id='${branch}';`);
      }
    });

    await t.test('revoked_author_cannot_edit_after_waiting_for_the_card_lock', async () => {
      const card = manage(admin, { client: clientD, name: 'Draft authority race' }).result.card;
      const v = start(admin, card.id, null).version;
      const request = randomUUID(), expectedAt = version(v.id).updated_at;
      const expression = draftExpression({ request, version: v.id, expectedAt, action: 'create',
        rule: null, name: 'Revoked draft edit', type: 'hourly', amount: 80, group: null,
        scope: {}, from: null, to: null, asset: null });
      const lockHolder = concurrentSql(`SET application_name='fcm_draft_author_card_lock'; BEGIN;
        SELECT id FROM public.rate_cards WHERE id='${card.id}' FOR UPDATE;
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false, editor;
      try {
        await waitForSleepingBackend('fcm_draft_author_card_lock');
        sleeping = true;
        editor = concurrentSql(`SET application_name='fcm_revoked_draft_author'; ${actor(reviewer)}
          SELECT ${expression};`);
        await waitForBlockedBackend('fcm_revoked_draft_author');
        sql(`UPDATE public.user_profiles SET deactivated_at=clock_timestamp() WHERE id='${reviewer}';`);
        releaseSleepingBackend('fcm_draft_author_card_lock');
        sleeping = false;
        const result = await editor;
        assert.notEqual(result.code, 0, 'Revoked author must not edit a draft');
        assert.match(result.stderr, /finance|authori[sz]|permission|concurr|lock/i);
        assert.equal(version(v.id).updated_at, expectedAt);
        assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_card_version_id='${v.id}';`), '0');
        assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
          WHERE client_request_id='${request}';`), '0');
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_draft_author_card_lock');
        const held = await lockHolder;
        assert.equal(held.code, 0, held.stderr);
        if (editor) await editor;
        sql(`UPDATE public.user_profiles SET deactivated_at=NULL WHERE id='${reviewer}';`);
      }
    });

    await t.test('revoked_user_cannot_replay_after_waiting_for_the_request_lock', async () => {
      const card = manage(admin, { client: clientD, name: 'Replay authority race' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(reviewer, { version: v.id, expectedAt: version(v.id).updated_at, amount: 457.50 });
      const lockHolder = concurrentSql(`SET application_name='fcm_replay_request_lock'; BEGIN;
        SELECT pg_advisory_xact_lock(hashtextextended('rate-card-request:${saved.request}',0));
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false, replay;
      try {
        await waitForSleepingBackend('fcm_replay_request_lock');
        sleeping = true;
        replay = concurrentSql(`SET application_name='fcm_revoked_replay'; ${actor(reviewer)}
          SELECT ${saved.expression};`);
        await waitForBlockedBackend('fcm_revoked_replay');
        sql(`UPDATE public.user_profiles SET deactivated_at=clock_timestamp() WHERE id='${reviewer}';`);
        releaseSleepingBackend('fcm_replay_request_lock');
        sleeping = false;
        const result = await replay;
        assert.notEqual(result.code, 0, 'A revoked user must not retrieve a protected replay');
        assert.match(result.stderr, /finance|authori[sz]|permission|concurr|lock/i);
        assert.doesNotMatch(result.stdout, /457\.5/);
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_replay_request_lock');
        const held = await lockHolder;
        assert.equal(held.code, 0, held.stderr);
        if (replay) await replay;
        sql(`UPDATE public.user_profiles SET deactivated_at=NULL WHERE id='${reviewer}';`);
      }
    });

    await t.test('approval_locks_its_authority_without_blocking_an_unrelated_profile', async () => {
      const card = manage(admin, { client: clientD, name: 'Narrow authority locks' }).result.card;
      const v = start(admin, card.id, null).version;
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      const expression = decideExpression(randomUUID(), v.id, 'approve', 'Review', version(v.id).updated_at);
      const lockHolder = concurrentSql(`SET application_name='fcm_audit_pause_holder'; BEGIN;
        SELECT pg_advisory_xact_lock(620231::bigint);
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false, decision;
      try {
        await waitForSleepingBackend('fcm_audit_pause_holder');
        sleeping = true;
        decision = concurrentSql(`SET application_name='fcm_authority_row_locks';
          SET test.pause_rate_audit='yes'; ${actor(reviewer)} SELECT ${expression};`);
        await waitForBlockedBackend('fcm_authority_row_locks');
        sql(`BEGIN; SET lock_timeout='1s'; UPDATE public.user_profiles SET role=role
          WHERE id='${outsider}'; ROLLBACK;`);
        fails(`BEGIN; SET lock_timeout='1s'; UPDATE public.user_profiles SET deactivated_at=clock_timestamp()
          WHERE id='${reviewer}'; ROLLBACK;`, /lock timeout/i);
        releaseSleepingBackend('fcm_audit_pause_holder');
        sleeping = false;
        const result = await decision;
        assert.equal(result.code, 0, result.stderr);
        assert.equal(version(v.id).status, 'approved');
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_audit_pause_holder');
        const held = await lockHolder;
        assert.equal(held.code, 0, held.stderr);
        if (decision) await decision;
      }
    });

    await t.test('groups_rates_with_explicit_override', () => {
      const card = manage(admin, { client: clientD, name: 'Equipment card' }).result.card;
      const v = start(admin, card.id, null).version;
      const first = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        name: 'Excavator', type: 'hourly', amount: 120, group: 'Response',
        scope: { service_type: 'excavator', region_code: 'NZ-TAS' }, asset: homeAsset }).result.line;
      assert.equal(first.rate_group, 'Response', 'An explicit display group wins over derivation');
      assert.equal(first.asset_id, homeAsset);
      fails(`${actor(admin)} SELECT ${draftExpression({ request: randomUUID(), version: v.id,
        expectedAt: version(v.id).updated_at, action: 'create', rule: null, name: 'Foreign equipment',
        type: 'hourly', amount: 120, group: 'Equipment & hire', scope: {}, from: null, to: null,
        asset: foreignAsset })};`, /asset|organisation|organization/i);
      fails(`${actor(admin)} SELECT ${draftExpression({ request: randomUUID(), version: v.id,
        expectedAt: version(v.id).updated_at, action: 'create', rule: null, name: 'Retired equipment',
        type: 'hourly', amount: 120, group: null, scope: {}, from: null, to: null, asset: retiredAsset })};`,
      /asset|retired|available/i);
      const derived = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        name: 'Mileage', type: 'per_km', amount: 1.5, scope: {} }).result.line;
      assert.equal(derived.rate_group, 'Travel');
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      decide(reviewer, v.id, 'approve', version(v.id).updated_at);
      fails(`DELETE FROM public.assets WHERE id='${homeAsset}';`, /foreign key|referenced/i);
      fails(`UPDATE public.assets SET organization_id='${other}' WHERE id='${homeAsset}';`, /foreign key|referenced/i);
      sql(`UPDATE public.assets SET status='retired' WHERE id='${homeAsset}';`);
      const next = start(admin, card.id, v.id).version;
      const copied = json(`SELECT row_to_json(r) FROM public.rate_rules r
        WHERE rate_card_version_id='${next.id}' AND rate_line_key='${first.rate_line_key}';`);
      assert.equal(copied.asset_id, homeAsset);
      assert.equal(copied.region_code, 'NZ-TAS');
      assert.equal(line(first.id).asset_id, homeAsset);
      fails(`UPDATE public.rate_rules SET asset_id='${foreignAsset}' WHERE id='${copied.id}';`,
        /asset|foreign key|organisation|organization|governed|draft/i);
    });

    await t.test('allows_a_client_zone_covered_by_the_providers_active_agreement', () => {
      const card = manage(admin, { client: clientD, name: 'Covered client zone' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        scope: { zone_id: clientZone } });
      assert.equal(saved.result.line.zone_id, clientZone);
    });

    await t.test('allows_a_client_site_covered_by_the_providers_active_agreement', () => {
      const card = manage(admin, { client: clientD, name: 'Covered client site' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        scope: { site_id: clientSite } });
      assert.equal(saved.result.line.site_id, clientSite);
    });

    await t.test('rejects_a_zone_linked_to_a_different_client_of_the_same_provider', () => {
      const card = manage(admin, { client: clientA, name: 'Wrong client zone' }).result.card;
      const v = start(admin, card.id, null).version;
      const options = { request: randomUUID(), version: v.id, expectedAt: version(v.id).updated_at,
        action: 'create', rule: null, name: 'Wrong client zone rate', type: 'hourly', amount: 80,
        group: null, scope: { zone_id: clientZone }, from: null, to: null, asset: null };
      fails(`${actor(admin)} SELECT ${draftExpression(options)};`, /zone|place|scope|foreign/i);
      assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
        WHERE client_request_id='${options.request}';`), '0');
    });

    await t.test('allows_a_third_party_zone_explicitly_linked_to_the_client_agreement', () => {
      const card = manage(admin, { client: clientD, name: 'Third-party linked place' }).result.card;
      const v = start(admin, card.id, null).version;
      const options = { request: randomUUID(), version: v.id, expectedAt: version(v.id).updated_at,
        action: 'create', rule: null, name: 'Linked zone rate', type: 'hourly', amount: 80,
        group: null, scope: { zone_id: foreignZone }, from: null, to: null, asset: null };
      const result = json(`BEGIN;
        INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id)
          VALUES ('${agreementD}','${foreignZone}');
        ${actor(admin)} SELECT ${draftExpression(options)}; ROLLBACK;`);
      assert.equal(result.line.zone_id, foreignZone);
    });

    await t.test('an_ended_third_party_link_cannot_be_approved_or_repriced_but_history_copies', () => {
      const card = manage(admin, { client: clientD, name: 'Third-party link changed' }).result.card;
      const v = start(admin, card.id, null).version;
      const linkId = randomUUID();
      sql(`INSERT INTO public.service_agreement_locations(id,service_agreement_id,zone_id)
        VALUES ('${linkId}','${agreementD}','${foreignZone}');`);
      try {
        const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
          amount: 217, scope: { zone_id: foreignZone } }).result.line;
        submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
        sql(`UPDATE public.service_agreement_locations SET status='ended' WHERE id='${linkId}';`);
        fails(`BEGIN; ${actor(reviewer)} SELECT ${decideExpression(randomUUID(), v.id,
          'approve', 'Link ended', version(v.id).updated_at)}; ROLLBACK;`, /zone|place|scope|agreement/i);
        assert.equal(version(v.id).status, 'draft');
        sql(`UPDATE public.service_agreement_locations SET status='active' WHERE id='${linkId}';`);
        decide(reviewer, v.id, 'approve', version(v.id).updated_at);
        sql(`UPDATE public.service_agreement_locations SET status='ended' WHERE id='${linkId}';`);
        const next = start(admin, card.id, v.id).version;
        const copied = json(`SELECT row_to_json(r) FROM public.rate_rules r
          WHERE rate_card_version_id='${next.id}' AND rate_line_key='${saved.rate_line_key}';`);
        assert.equal(copied.zone_id, foreignZone);
        assert.equal(line(saved.id).amount, 217);
        fails(`BEGIN; ${actor(admin)} SELECT ${draftExpression({ request: randomUUID(), version: next.id,
          expectedAt: version(next.id).updated_at, action: 'update', rule: copied.id,
          name: copied.name, type: copied.rate_type, amount: 218, group: copied.rate_group,
          scope: {}, from: copied.effective_from, to: copied.effective_to, asset: copied.asset_id })}; ROLLBACK;`,
        /zone|place|scope|agreement/i);
        fails(`BEGIN; ${actor(admin)} SELECT ${submitExpression(randomUUID(), next.id,
          '2028-01-01', 'Link ended', version(next.id).updated_at)}; ROLLBACK;`,
        /zone|place|scope|agreement/i);
        assert.equal(version(next.id).status, 'draft');
      } finally {
        sql(`DELETE FROM public.service_agreement_locations WHERE id='${linkId}';`);
      }
    });

    await t.test('rejects_nonexistent_site_scope_for_a_client_card', () => {
      const card = manage(admin, { client: clientD, name: 'Missing client site' }).result.card;
      const v = start(admin, card.id, null).version;
      const options = { request: randomUUID(), version: v.id, expectedAt: version(v.id).updated_at,
        action: 'create', rule: null, name: 'Missing site rate', type: 'hourly', amount: 80,
        group: null, scope: { site_id: missingSite }, from: null, to: null, asset: null };
      fails(`${actor(admin)} SELECT ${draftExpression(options)};`, /site|place|scope|foreign/i);
      assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
        WHERE client_request_id='${options.request}';`), '0');
    });

    for (const [label, zoneId] of [['nonexistent', missingZone], ['unrelated', foreignZone]]) {
      await t.test(`rejects_${label}_zone_scope_for_a_client_card`, () => {
        const card = manage(admin, { client: clientD, name: `${label} zone` }).result.card;
        const v = start(admin, card.id, null).version;
        draft(admin, { version: v.id, expectedAt: version(v.id).updated_at });
        const before = version(v.id).updated_at;
        assert.equal(sql(`SELECT count(*) FROM public.location_zones WHERE id='${zoneId}';`),
          label === 'nonexistent' ? '0' : '1');
        const options = { request: randomUUID(), version: v.id, expectedAt: version(v.id).updated_at,
          action: 'create', rule: null, name: 'Zone rate', type: 'hourly', amount: 80,
          group: null, scope: { zone_id: zoneId }, from: null, to: null, asset: null };
        fails(`${actor(admin)} SELECT ${draftExpression(options)};`, /zone|place|scope|foreign/i);
        assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_card_version_id='${v.id}';`), '1');
        assert.equal(version(v.id).updated_at, before);
        assert.equal(sql(`SELECT count(*) FROM public.rate_card_request_receipts
          WHERE client_request_id='${options.request}';`), '0');
      });
    }

    await t.test('standard_and_pay_place_scopes_need_an_agreement_or_own_place', () => {
      const standardCard = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${provider}'
        AND kind='charge' AND is_standard;`);
      const existing = sql(`SELECT id FROM public.rate_card_versions
        WHERE rate_card_id='${standardCard}' AND status='draft';`);
      const standard = existing || start(admin, standardCard, versionFor(standardCard).id).version.id;
      const payCard = manage(admin, { kind: 'pay', client: null, name: 'Place-scoped pay' }).result.card;
      const pay = start(admin, payCard.id, null).version.id;
      for (const [versionId, payLine] of [[standard, false], [pay, true]]) {
        const valid = draft(admin, { version: versionId, expectedAt: version(versionId).updated_at,
          scope: payLine ? { zone_id: clientZone, pay_code: 'PAY1' } : { zone_id: clientZone } });
        assert.equal(valid.result.line.zone_id, clientZone);
        const invalid = { request: randomUUID(), version: versionId, expectedAt: version(versionId).updated_at,
          action: 'create', rule: null, name: 'Unlinked place', type: 'hourly', amount: 80,
          group: null, scope: payLine ? { zone_id: foreignZone, pay_code: 'PAY1' }
            : { zone_id: foreignZone }, from: null, to: null, asset: null };
        fails(`BEGIN; ${actor(admin)} SELECT ${draftExpression(invalid)}; ROLLBACK;`,
          /zone|place|scope|agreement/i);
      }
    });

    await t.test('allows_branch_finance_place_pricing_without_agreement_link', () => {
      assert.equal(sql(`SELECT count(*) FROM public.service_agreement_locations
        WHERE zone_id IN ('${ownZone}','${unlinkedClientZone}') OR site_id='${ownSite}';`), '0');
      const payCard = manage(admin, { kind: 'pay', client: null, name: 'Self-managed place pay' }).result.card;
      const pay = start(admin, payCard.id, null).version.id;
      const zoneLine = draft(admin, { version: pay, expectedAt: version(pay).updated_at,
        scope: { zone_id: ownZone, pay_code: 'PAY1' } }).result.line;
      assert.equal(zoneLine.zone_id, ownZone);
      const siteLine = draft(admin, { version: pay, expectedAt: version(pay).updated_at,
        scope: { site_id: ownSite, pay_code: 'PAY1' } }).result.line;
      assert.equal(siteLine.site_id, ownSite);
      const updated = draft(admin, { version: pay, expectedAt: version(pay).updated_at, action: 'update',
        rule: zoneLine.id, name: zoneLine.name, type: zoneLine.rate_type, amount: 91, scope: {} }).result.line;
      assert.equal(Number(updated.amount), 91);
      submit(admin, pay, '2027-01-01', version(pay).updated_at);
      assert.equal(decide(reviewer, pay, 'approve', version(pay).updated_at).version.status, 'approved');

      const clientCard = manage(admin, { client: clientD, name: 'Self-managed client place' }).result.card;
      const clientVersion = start(admin, clientCard.id, null).version.id;
      assert.equal(draft(admin, { version: clientVersion, expectedAt: version(clientVersion).updated_at,
        scope: { zone_id: ownZone } }).result.line.zone_id, ownZone);
      const attempt = (versionId, scope) => draftExpression({ request: randomUUID(), version: versionId,
        expectedAt: version(versionId).updated_at, action: 'create', rule: null, name: 'Unlinked place',
        type: 'hourly', amount: 80, group: null, scope, from: null, to: null, asset: null });
      // A client's own place is not operated by the branch merely because the card is that client's.
      fails(`BEGIN; ${actor(admin)} SELECT ${attempt(clientVersion, { zone_id: unlinkedClientZone })}; ROLLBACK;`,
        /zone|place|scope|agreement/i);
      // A non-finance user of the same branch is still denied for the same place.
      fails(`BEGIN; ${actor(providerOfficer)} SELECT ${attempt(clientVersion, { zone_id: ownZone })}; ROLLBACK;`,
        /finance|authori[sz]|permission/i);
      // Another operating organisation, and a child branch of the owner, cannot price the place.
      const foreignCard = manage(outsider, { org: other, client: foreignClient, name: 'Other provider place' })
        .result.card;
      const foreignVersion = start(outsider, foreignCard.id, null).version.id;
      fails(`BEGIN; ${actor(outsider)} SELECT ${attempt(foreignVersion, { zone_id: ownZone })}; ROLLBACK;`,
        /zone|place|scope|agreement/i);
      const branchCard = manage(branchAdmin, { org: branch, client: clientD, name: 'Branch place' }).result.card;
      const branchVersion = start(branchAdmin, branchCard.id, null).version.id;
      fails(`BEGIN; ${actor(branchAdmin)} SELECT ${attempt(branchVersion, { site_id: ownSite })}; ROLLBACK;`,
        /site|place|scope|agreement/i);
      for (const versionId of [foreignVersion, branchVersion]) {
        assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_card_version_id='${versionId}';`), '0');
      }
    });

    await t.test('allows_future_and_backdated_agreement_card_links', () => {
      const card = manage(admin, { client: clientD, name: 'Dated agreement scope' }).result.card;
      const v = start(admin, card.id, null).version;
      const placeAttempt = () => draftExpression({ request: randomUUID(), version: v.id,
        expectedAt: version(v.id).updated_at, action: 'create', rule: null, name: 'Dated agreement rate',
        type: 'hourly', amount: 80, group: null, scope: { zone_id: clientZone }, from: null, to: null,
        asset: null });
      const previous = byId('service_agreements', agreementD).rate_card_id;
      const linkAttempt = () => `public.manage_rate_card(${args([
        [randomUUID(), 'uuid'], [provider, 'uuid'], ['link_agreement', 'text'], [card.id, 'uuid'],
        [null, 'text'], [null, 'text'], [null, 'uuid'], [null, 'boolean'], [agreementD, 'uuid'],
        [card.updated_at, 'timestamptz'], [previous, 'uuid'], [null, 'text'],
      ])})`;
      const future = 'starts_on=current_date+30, ends_on=NULL';
      const backdated = "starts_on='2020-01-01', ends_on=current_date-1";
      // ends_on = starts_on - 1 is the schema's "cancelled before it took effect" (end_service_agreement).
      const cancelled = 'starts_on=current_date+30, ends_on=current_date+29';
      for (const dates of [future, backdated]) {
        const line = json(`BEGIN; UPDATE public.service_agreements SET ${dates} WHERE id='${agreementD}';
          ${actor(admin)} SELECT ${placeAttempt()}; ROLLBACK;`).line;
        assert.equal(line.zone_id, clientZone, dates);
        const linked = json(`BEGIN; UPDATE public.service_agreements SET ${dates} WHERE id='${agreementD}';
          ${actor(admin)} SELECT ${linkAttempt()}; ROLLBACK;`);
        assert.equal(linked.rate_card_id, card.id, dates);
      }
      fails(`BEGIN; UPDATE public.service_agreements SET ${cancelled} WHERE id='${agreementD}';
        ${actor(admin)} SELECT ${placeAttempt()}; ROLLBACK;`, /zone|place|scope|agreement|cancel/i);
      fails(`BEGIN; UPDATE public.service_agreements SET ${cancelled} WHERE id='${agreementD}';
        ${actor(admin)} SELECT ${linkAttempt()}; ROLLBACK;`, /agreement|cancel/i);
      for (const status of ['suspended', 'ended']) {
        fails(`BEGIN; UPDATE public.service_agreement_locations SET status='${status}'
          WHERE service_agreement_id='${agreementD}' AND zone_id='${clientZone}';
          ${actor(admin)} SELECT ${placeAttempt()}; ROLLBACK;`, /zone|place|scope|agreement/i);
      }
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_card_version_id='${v.id}';`), '0');
      assert.equal(byId('service_agreements', agreementD).rate_card_id, previous);
    });

    await t.test('keeps_retired_place_repricing_fail_closed', () => {
      const card = manage(admin, { client: clientD, name: 'Retired place scope' }).result.card;
      const v = start(admin, card.id, null).version;
      const saved = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        amount: 219, scope: { zone_id: clientZone } }).result.line;
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      decide(reviewer, v.id, 'approve', version(v.id).updated_at);
      sql(`UPDATE public.location_zones SET is_active=false WHERE id='${clientZone}';`);
      try {
        const next = start(admin, card.id, v.id).version;
        const copied = json(`SELECT row_to_json(r) FROM public.rate_rules r
          WHERE rate_card_version_id='${next.id}' AND rate_line_key='${saved.rate_line_key}';`);
        assert.equal(copied.zone_id, clientZone);
        assert.equal(line(saved.id).amount, 219);
        fails(`BEGIN; ${actor(admin)} SELECT ${draftExpression({ request: randomUUID(), version: next.id,
          expectedAt: version(next.id).updated_at, action: 'update', rule: copied.id,
          name: copied.name, type: copied.rate_type, amount: 220, group: copied.rate_group,
          scope: {}, from: copied.effective_from, to: copied.effective_to, asset: copied.asset_id })}; ROLLBACK;`,
        /zone|place|scope|retired/i);
        fails(`BEGIN; ${actor(admin)} SELECT ${submitExpression(randomUUID(), next.id,
          '2028-01-01', 'Retired place', version(next.id).updated_at)}; ROLLBACK;`,
        /zone|place|scope|retired/i);
        const retired = draft(admin, { version: next.id, expectedAt: version(next.id).updated_at,
          action: 'retire', rule: copied.id }).result.line;
        assert.equal(retired.rate_card_line_enabled, false);
        assert.equal(submit(admin, next.id, '2028-01-01', version(next.id).updated_at)
          .version.review_state, 'submitted');
      } finally {
        sql(`UPDATE public.location_zones SET is_active=true WHERE id='${clientZone}';`);
      }
      // Self-management does not reopen retired places or ended coverage.
      const ownCard = manage(admin, { client: clientD, name: 'Retired self-managed place' }).result.card;
      const own = start(admin, ownCard.id, null).version;
      const ownAttempt = scope => draftExpression({ request: randomUUID(), version: own.id,
        expectedAt: version(own.id).updated_at, action: 'create', rule: null, name: 'Retired own place',
        type: 'hourly', amount: 80, group: null, scope, from: null, to: null, asset: null });
      fails(`BEGIN; UPDATE public.location_zones SET is_active=false WHERE id='${ownZone}';
        ${actor(admin)} SELECT ${ownAttempt({ zone_id: ownZone })}; ROLLBACK;`, /zone|place|scope|retired/i);
      fails(`BEGIN; UPDATE public.client_sites SET active=false WHERE id='${ownSite}';
        ${actor(admin)} SELECT ${ownAttempt({ site_id: ownSite })}; ROLLBACK;`, /site|place|scope|retired/i);
      fails(`BEGIN; INSERT INTO public.service_agreement_locations(service_agreement_id,site_id,status)
          VALUES ('${agreementD}','${ownSite}','ended');
        ${actor(admin)} SELECT ${ownAttempt({ site_id: ownSite })}; ROLLBACK;`, /site|place|scope|agreement/i);
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_card_version_id='${own.id}';`), '0');
    });

    await t.test('approval_locks_its_place_agreement_until_commit', async () => {
      const card = manage(admin, { client: clientD, name: 'Place agreement lock' }).result.card;
      const v = start(admin, card.id, null).version;
      draft(admin, { version: v.id, expectedAt: version(v.id).updated_at, scope: { zone_id: clientZone } });
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      const expression = decideExpression(randomUUID(), v.id, 'approve', 'Review', version(v.id).updated_at);
      const lockHolder = concurrentSql(`SET application_name='fcm_place_audit_pause'; BEGIN;
        SELECT pg_advisory_xact_lock(620231::bigint);
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false, decision;
      try {
        await waitForSleepingBackend('fcm_place_audit_pause');
        sleeping = true;
        decision = concurrentSql(`SET application_name='fcm_place_decision';
          SET test.pause_rate_audit='yes'; ${actor(reviewer)} SELECT ${expression};`);
        await waitForBlockedBackend('fcm_place_decision');
        fails(`BEGIN; SET lock_timeout='1s'; UPDATE public.service_agreement_locations SET status='ended'
          WHERE service_agreement_id='${agreementD}' AND zone_id='${clientZone}'; ROLLBACK;`, /lock timeout/i);
        releaseSleepingBackend('fcm_place_audit_pause');
        sleeping = false;
        const result = await decision;
        assert.equal(result.code, 0, result.stderr);
        assert.equal(version(v.id).status, 'approved');
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_place_audit_pause');
        const held = await lockHolder;
        assert.equal(held.code, 0, held.stderr);
        if (decision) await decision;
      }
    });

    await t.test('only_one_active_pay_card_exists_per_operating_org_and_role', () => {
      const first = manage(admin, { kind: 'pay', client: null, payrollRole: 'GUARD',
        name: 'Guard pay' }).result.card;
      assert.equal(first.payroll_role_code, 'GUARD');
      fails(`${actor(admin)} SELECT public.manage_rate_card(${args([
        [randomUUID(), 'uuid'], [provider, 'uuid'], ['create', 'text'], [null, 'uuid'],
        ['pay', 'text'], ['Duplicate guard pay', 'text'], [null, 'uuid'], [false, 'boolean'],
        [null, 'uuid'], [null, 'timestamptz'], [null, 'uuid'], ['GUARD', 'text'],
      ])});`, /unique|duplicate|pay|role/i);
      const anotherRole = manage(admin, { kind: 'pay', client: null, payrollRole: 'SUPERVISOR',
        name: 'Supervisor pay' }).result.card;
      const anotherOrg = manage(outsider, { org: other, kind: 'pay', client: null,
        payrollRole: 'GUARD', name: 'Other guard pay' }).result.card;
      assert.equal(anotherRole.payroll_role_code, 'SUPERVISOR');
      assert.equal(anotherOrg.organization_id, other);
    });

    await t.test('pay_card_role_must_be_active_in_the_actors_payroll_organization', () => {
      for (const role of ['MISSING_ROLE', 'OLD_ROLE', 'FOREIGN_ROLE']) {
        fails(`${actor(admin)} SELECT public.manage_rate_card(${args([
          [randomUUID(), 'uuid'], [provider, 'uuid'], ['create', 'text'], [null, 'uuid'],
          ['pay', 'text'], ['Invalid payroll role', 'text'], [null, 'uuid'], [false, 'boolean'],
          [null, 'uuid'], [null, 'timestamptz'], [null, 'uuid'], [role, 'text'],
        ])});`, /active|payroll|role/i);
      }
      assert.equal(sql(`SELECT count(*) FROM public.rate_cards
        WHERE organization_id='${provider}' AND payroll_role_code IN ('MISSING_ROLE','OLD_ROLE','FOREIGN_ROLE');`), '0');
    });

    await t.test('card_and_agreement_compare_expected_previous_state', () => {
      const first = manage(admin, { client: clientA, name: 'Alternative A' }).result.card;
      const second = manage(admin, { client: clientA, name: 'Alternative B' }).result.card;
      const originalDefault = cardFor(clientA);
      const set = manage(admin, { action: 'set_default', card: first.id, kind: null, name: null,
        client: null, isDefault: true, expectedCardAt: first.updated_at, expectedPrevious: originalDefault });
      assert.equal(cardFor(clientA), first.id);
      fails(`${actor(admin)} SELECT public.manage_rate_card(${args([
        [randomUUID(), 'uuid'], [provider, 'uuid'], ['set_default', 'text'], [second.id, 'uuid'],
        [null, 'text'], [null, 'text'], [null, 'uuid'], [true, 'boolean'], [null, 'uuid'],
        [second.updated_at, 'timestamptz'], [originalDefault, 'uuid'], [null, 'text'],
      ])});`, /changed|stale|default/i);
      assert.equal(cardFor(clientA), first.id);
      const linked = manage(admin, { action: 'link_agreement', card: first.id, kind: null, name: null,
        client: null, isDefault: null, agreement: agreementA, expectedCardAt: set.result.card.updated_at,
        expectedPrevious: null });
      assert.equal(byId('service_agreements', agreementA).rate_card_id, first.id);
      fails(`${actor(admin)} SELECT public.manage_rate_card(${args([
        [randomUUID(), 'uuid'], [provider, 'uuid'], ['link_agreement', 'text'], [second.id, 'uuid'],
        [null, 'text'], [null, 'text'], [null, 'uuid'], [null, 'boolean'], [agreementA, 'uuid'],
        [second.updated_at, 'timestamptz'], [null, 'uuid'], [null, 'text'],
      ])});`, /changed|stale|agreement/i);
      assert.equal(byId('service_agreements', agreementA).rate_card_id, first.id);
      assert.ok(linked.result.card);
      fails(`SET ROLE service_role; UPDATE public.service_agreements
        SET rate_card_id='${second.id}' WHERE id='${agreementA}';`, /governed|finance|permission/i);
      assert.equal(byId('service_agreements', agreementA).rate_card_id, first.id);
      fails(`${actor(outsider)} SELECT ${set.expression};`, /finance|authori[sz]|permission/i);
      fails(`${actor(admin)} SELECT public.manage_rate_card(${args([
        [randomUUID(), 'uuid'], [provider, 'uuid'], ['create', 'text'], [null, 'uuid'],
        ['charge', 'text'], ['Foreign client card', 'text'], [foreignClient, 'uuid'], [false, 'boolean'],
        [null, 'uuid'], [null, 'timestamptz'], [null, 'uuid'], [null, 'text'],
      ])});`, /client|scope|agreement|organisation|organization/i);
      fails(`${actor(admin)} SELECT public.manage_rate_card(${args([
        [randomUUID(), 'uuid'], [provider, 'uuid'], ['link_agreement', 'text'], [second.id, 'uuid'],
        [null, 'text'], [null, 'text'], [null, 'uuid'], [null, 'boolean'], [agreementB, 'uuid'],
        [second.updated_at, 'timestamptz'], [null, 'uuid'], [null, 'text'],
      ])});`, /agreement|scope|organisation|organization/i);
    });

    await t.test('rejection_and_repeated_edits_require_fresh_versions', () => {
      const card = manage(admin, { client: clientD, name: 'Rejection card' }).result.card;
      const v = start(admin, card.id, null).version;
      draft(admin, { version: v.id, expectedAt: version(v.id).updated_at });
      const before = version(v.id);
      submit(admin, v.id, '2027-05-01', before.updated_at);
      fails(`${actor(reviewer)} SELECT ${decideExpression(randomUUID(), v.id, 'reject',
        'Reload needed', before.updated_at)};`, /changed|stale|revision/i);
      decide(reviewer, v.id, 'reject', version(v.id).updated_at, randomUUID(), 'Wrong rate');
      assert.equal(version(v.id).status, 'draft');
      assert.equal(version(v.id).decision_reason, 'Wrong rate');
      assert.equal(version(v.id).decided_by, reviewer);
      const revised = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        name: 'Corrected', amount: 85 });
      assert.equal(Number(revised.result.line.amount), 85);
      submit(admin, v.id, '2027-05-01', version(v.id).updated_at);
      decide(reviewer, v.id, 'approve', version(v.id).updated_at);
      assert.equal(version(v.id).status, 'approved');
    });

    await t.test('lone_exception_requires_both_exact_authority_predicates', () => {
      const contextOnly = id(210), globalAdmin = id(211), branchOfficer = id(212);
      const checks = json(`
        BEGIN;
        UPDATE public.user_profiles SET deactivated_at=now()
          WHERE id IN ('${admin}','${reviewer}','${branchAdmin}');
        INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role) VALUES
          ('${contextOnly}','${other}','${provider}','admin'),
          ('${globalAdmin}','${other}','${other}','grand_master'),
          ('${branchOfficer}','${other}','${other}','officer');
        INSERT INTO public.staff_branch_authorisations(user_id,branch_org_id,status)
          VALUES ('${branchOfficer}','${branch}','active');
        CREATE TEMP TABLE test_authority(value boolean);
        INSERT INTO test_authority SELECT public._rate_card_other_finance_exists('${branch}','${admin}');
        INSERT INTO public.staff_branch_authorisations(user_id,branch_org_id,status)
          VALUES ('${globalAdmin}','${branch}','active');
        INSERT INTO test_authority SELECT public._rate_card_other_finance_exists('${branch}','${admin}');
        UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${globalAdmin}';
        INSERT INTO test_authority SELECT public._rate_card_other_finance_exists('${branch}','${admin}');
        UPDATE public.user_profiles SET deactivated_at=NULL WHERE id='${branchAdmin}';
        INSERT INTO test_authority SELECT public._rate_card_other_finance_exists('${branch}','${admin}');
        SELECT json_agg(value ORDER BY ctid) FROM test_authority;
        ROLLBACK;
      `);
      assert.deepEqual(checks, [false, true, false, true]);
    });

    await t.test('lone_exception_counts_the_exact_assignment_and_agreement_authority_witness', () => {
      const agreementUser = id(213), authorityAgreement = id(214);
      const checks = json(`
        BEGIN;
        UPDATE public.user_profiles SET deactivated_at=now()
          WHERE id IN ('${admin}','${reviewer}','${branchAdmin}');
        INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role)
          VALUES ('${agreementUser}','${other}','${other}','admin');
        INSERT INTO public.staff_branch_authorisations(user_id,branch_org_id,status)
          VALUES ('${agreementUser}','${branch}','active');
        CREATE TEMP TABLE test_agreement_authority(value boolean);
        INSERT INTO test_agreement_authority
          SELECT public._rate_card_other_finance_exists('${branch}','${admin}');
        INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name)
          VALUES ('${authorityAgreement}','${other}','${branch}','Authority witness');
        INSERT INTO test_agreement_authority
          SELECT public._rate_card_other_finance_exists('${branch}','${admin}');
        UPDATE public.service_agreements SET ends_on=current_date-1 WHERE id='${authorityAgreement}';
        INSERT INTO test_agreement_authority
          SELECT public._rate_card_other_finance_exists('${branch}','${admin}');
        SELECT json_agg(value ORDER BY ctid) FROM test_agreement_authority;
        ROLLBACK;
      `);
      assert.deepEqual(checks, [false, true, false]);
    });

    await t.test('fails_closed_if_authority_function_configuration_drifts', () => {
      const card = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${branch}'
        AND kind='charge' AND is_standard;`);
      const v = start(admin, card, versionFor(card).id).version;
      draft(admin, { version: v.id, expectedAt: version(v.id).updated_at });
      submit(branchAdmin, v.id, '2028-01-01', version(v.id).updated_at);
      sql(`CREATE SCHEMA test_shadow;
        CREATE TABLE test_shadow.user_profiles (id uuid, role text, deactivated_at timestamptz,
          organization_id uuid, employer_organization_id uuid);
        ALTER FUNCTION public.can_approve_action(uuid,uuid) SET search_path = test_shadow, public;`);
      try {
        fails(`${actor(branchAdmin)} SELECT ${decideExpression(randomUUID(), v.id, 'approve',
          'Configuration changed', version(v.id).updated_at)};`, /cannot establish|authority|self.approv/i);
        assert.equal(version(v.id).status, 'draft');
      } finally {
        sql('ALTER FUNCTION public.can_approve_action(uuid,uuid) SET search_path = public;');
      }
    });

    await t.test('fails_closed_if_descendant_authority_dependency_drifts', () => {
      const card = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${branch}'
        AND kind='charge' AND is_standard;`);
      const v = json(`SELECT row_to_json(v) FROM public.rate_card_versions v
        WHERE v.rate_card_id='${card}' AND v.status='draft';`);
      sql(`CREATE OR REPLACE FUNCTION public.get_descendant_organizations(org_id uuid)
        RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public
        AS $$ SELECT ARRAY[]::uuid[] $$;`);
      try {
        fails(`${actor(branchAdmin)} SELECT ${decideExpression(randomUUID(), v.id, 'approve',
          'Hierarchy changed', v.updated_at)};`, /cannot establish|authority|self.approv/i);
        assert.equal(version(v.id).status, 'draft');
      } finally {
        sql(definition('get_descendant_organizations'));
      }
    });

    await t.test('fails_closed_if_authority_enumerator_cannot_see_all_profiles', () => {
      sql(`CREATE ROLE test_authority_viewer NOLOGIN;
        GRANT USAGE ON SCHEMA public TO test_authority_viewer;
        GRANT SELECT ON public.user_profiles, public.organizations, public.service_agreements,
          public.staff_branch_authorisations TO test_authority_viewer;
        ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
        ALTER FUNCTION public._rate_card_other_finance_exists(uuid,uuid) OWNER TO test_authority_viewer;`);
      try {
        fails(`SELECT public._rate_card_other_finance_exists('${branch}','${branchAdmin}');`,
          /cannot establish|authority/i);
      } finally {
        sql(`ALTER FUNCTION public._rate_card_other_finance_exists(uuid,uuid) OWNER TO postgres;
          ALTER TABLE public.user_profiles DISABLE ROW LEVEL SECURITY;`);
      }
    });

    await t.test('pay_lines_require_active_pay_codes_and_owned_staff', () => {
      const card = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${provider}'
        AND kind='pay' AND is_standard;`);
      const v = start(admin, card, versionFor(card).id).version;
      const payload = { request: randomUUID(), version: v.id, expectedAt: version(v.id).updated_at,
        action: 'create', rule: null, name: 'Pay', type: 'hourly', amount: 30,
        group: 'Labour', scope: {}, from: null, to: null, asset: null };
      fails(`${actor(admin)} SELECT ${draftExpression(payload)};`, /pay code|payroll/i);
      fails(`${actor(admin)} SELECT ${draftExpression({ ...payload, request: randomUUID(),
        scope: { pay_code: 'OLD' } })};`, /pay code|payroll/i);
      fails(`${actor(admin)} SELECT ${draftExpression({ ...payload, request: randomUUID(),
        scope: { pay_code: 'PAY1', staff_id: foreignStaff } })};`, /staff|organisation|organization/i);
      const valid = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        name: 'Guard pay', amount: 30, scope: { pay_code: 'PAY1', role_code: 'GUARD', staff_id: localStaff } });
      assert.equal(valid.result.line.pay_code, 'PAY1');
      assert.equal(valid.result.line.staff_id, localStaff);
    });

    await t.test('copies_an_approved_scope_after_its_service_code_is_retired', () => {
      const card = manage(admin, { client: clientD, name: 'Historic service scope' }).result.card;
      const v = start(admin, card.id, null).version;
      const original = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        scope: { service_type: 'historic_task' } }).result.line;
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      decide(reviewer, v.id, 'approve', version(v.id).updated_at);
      sql(`UPDATE public.reference_codes SET is_active=false
        WHERE organization_id='${provider}' AND code_type='service_code' AND code='historic_task';`);
      assert.equal(sql(`SELECT public.is_known_service_code('${provider}', 'historic_task');`), 'f');
      const next = start(admin, card.id, v.id).version;
      const copied = json(`SELECT row_to_json(r) FROM public.rate_rules r
        WHERE r.rate_card_version_id='${next.id}' AND r.rate_line_key='${original.rate_line_key}';`);
      assert.equal(copied.service_type, 'historic_task');
      const repriced = draft(admin, { version: next.id, expectedAt: version(next.id).updated_at,
        action: 'update', rule: copied.id, name: copied.name, type: copied.rate_type, amount: 86,
        group: copied.rate_group, scope: {}, from: copied.effective_from, to: copied.effective_to,
        asset: copied.asset_id });
      assert.equal(Number(repriced.result.line.amount), 86);
      submit(admin, next.id, '2028-01-01', version(next.id).updated_at);
      decide(reviewer, next.id, 'approve', version(next.id).updated_at);
      assert.equal(version(next.id).status, 'approved');
      assert.equal(line(copied.id).active, false);
    });

    let retiredScope;
    await t.test('prepares_identical_approved_scopes_for_retirement', () => {
      const card = manage(admin, { client: clientD, name: 'Retired scoped rate' }).result.card;
      const approved = start(admin, card.id, null).version;
      const original = draft(admin, { version: approved.id, expectedAt: version(approved.id).updated_at,
        scope: { service_type: 'retired_scope' } }).result.line;
      submit(admin, approved.id, '2027-01-01', version(approved.id).updated_at);
      decide(reviewer, approved.id, 'approve', version(approved.id).updated_at);
      const next = start(admin, card.id, approved.id).version;
      const copied = json(`SELECT row_to_json(r) FROM public.rate_rules r
        WHERE r.rate_card_version_id='${next.id}' AND r.rate_line_key='${original.rate_line_key}';`);

      const foreignCard = sql(`SELECT id FROM public.rate_cards WHERE organization_id='${other}'
        AND kind='charge' AND is_standard;`);
      const foreign = start(outsider, foreignCard, versionFor(foreignCard).id).version;
      const foreignLine = draft(outsider, { version: foreign.id, expectedAt: version(foreign.id).updated_at,
        scope: { service_type: 'retired_scope' } }).result.line;
      submit(outsider, foreign.id, '2027-01-01', version(foreign.id).updated_at);
      decide(outsider, foreign.id, 'approve', version(foreign.id).updated_at);
      sql(`UPDATE public.reference_codes SET is_active=false
        WHERE organization_id IN ('${provider}','${other}') AND code_type='service_code' AND code='retired_scope';`);
      assert.equal(sql(`SELECT public.is_known_service_code('${provider}', 'retired_scope');`), 'f');
      assert.equal(sql(`SELECT public.is_known_service_code('${other}', 'retired_scope');`), 'f');
      retiredScope = { card, approved, original, next, copied, foreign, foreignLine };
    });

    await t.test('reprices_identical_retired_scope_without_activating_it', () => {
      const { next, copied } = retiredScope;
      const result = draft(admin, { version: next.id, expectedAt: version(next.id).updated_at,
        action: 'update', rule: copied.id, name: copied.name, type: copied.rate_type, amount: 87,
        group: copied.rate_group, scope: {}, from: copied.effective_from, to: copied.effective_to,
        asset: copied.asset_id });
      assert.equal(Number(result.result.line.amount), 87);
      assert.equal(result.result.line.active, false);
    });

    await t.test('concurrent_draft_edits_reject_the_stale_revision', async () => {
      const { next, copied } = retiredScope;
      const expectedAt = version(next.id).updated_at;
      const options = { version: next.id, expectedAt, action: 'update', rule: copied.id,
        name: copied.name, type: copied.rate_type, group: copied.rate_group, scope: {},
        from: copied.effective_from, to: copied.effective_to, asset: copied.asset_id };
      const firstRequest = randomUUID(), secondRequest = randomUUID();
      const first = concurrentSql(`SET application_name='fcm_rate_edit_race'; BEGIN; ${actor(admin)}
        SELECT ${draftExpression({ ...options, request: firstRequest, amount: 88 })};
        DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
      let sleeping = false;
      let second;
      try {
        await waitForSleepingBackend('fcm_rate_edit_race');
        sleeping = true;
        second = concurrentSql(`SET application_name='fcm_rate_edit_competitor'; ${actor(admin)}
          SELECT ${draftExpression({ ...options, request: secondRequest, amount: 89 })};`);
        await waitForBlockedBackend('fcm_rate_edit_competitor');
        releaseSleepingBackend('fcm_rate_edit_race');
        sleeping = false;
        const conflict = await second;
        assert.notEqual(conflict.code, 0);
        assert.match(conflict.stderr, /changed|stale|revision/i);
      } finally {
        if (sleeping) releaseSleepingBackend('fcm_rate_edit_race');
        const result = await first;
        assert.equal(result.code, 0, result.stderr);
        if (second) await second;
      }
      assert.equal(Number(line(copied.id).amount), 88);
      assert.equal(sql(`SELECT count(*) FROM public.audit_log
        WHERE metadata->>'client_request_id'='${secondRequest}';`), '0');
    });

    await t.test('rejects_new_lines_using_retired_service_codes', () => {
      const { next } = retiredScope;
      fails(`${actor(admin)} SELECT ${draftExpression({ request: randomUUID(), version: next.id,
        expectedAt: version(next.id).updated_at, action: 'create', rule: null, name: 'New retired service',
        type: 'hourly', amount: 80, group: null, scope: { service_type: 'retired_scope' },
        from: null, to: null, asset: null })};`, /task|retired|scope/i);
    });

    await t.test('rejects_changed_retired_code_scope_on_disabled_lines', () => {
      const { next, copied } = retiredScope;
      const retire = draftExpression({ request: randomUUID(), version: next.id,
        expectedAt: version(next.id).updated_at, action: 'retire', rule: copied.id,
        name: null, type: null, amount: null, group: null, scope: {}, from: null, to: null, asset: null });
      const head = args([[randomUUID(), 'uuid'], [next.id, 'uuid']]);
      const tail = args([['update', 'text'], [copied.id, 'uuid'], [copied.name, 'text'],
        [copied.rate_type, 'text'], [90, 'numeric'], [copied.rate_group, 'text'],
        [JSON.stringify({ job_type: 'different' }), 'jsonb'],
        [copied.effective_from, 'date'], [copied.effective_to, 'date'], [copied.asset_id, 'uuid']]);
      fails(`BEGIN; ${actor(admin)} SELECT ${retire};
        SELECT public.manage_rate_card_draft_line(${head},
          (SELECT updated_at FROM public.rate_card_versions WHERE id='${next.id}'), ${tail});
        ROLLBACK;`, /task|retired|scope/i);
      assert.equal(line(copied.id).rate_card_line_enabled, true);
    });

    await t.test('allows_scope_changes_when_the_replacement_code_is_known', () => {
      const { next, copied } = retiredScope;
      const expression = draftExpression({ request: randomUUID(), version: next.id,
        expectedAt: version(next.id).updated_at, action: 'update', rule: copied.id,
        name: copied.name, type: copied.rate_type, amount: 90, group: copied.rate_group,
        scope: { service_type: 'patrol', job_type: 'different' },
        from: copied.effective_from, to: copied.effective_to, asset: copied.asset_id });
      const changed = json(`BEGIN; ${actor(admin)} SELECT ${expression}; ROLLBACK;`);
      assert.equal(changed.line.service_type, 'patrol');
      assert.equal(changed.line.job_type, 'different');
      assert.equal(line(copied.id).service_type, 'retired_scope');
    });

    const changedScopes = [
      ['service', { scope: { service_type: 'retired_aux' } }],
      ['site', { scope: { site_id: id(310) } }],
      ['zone', { scope: { zone_id: id(311) } }],
      ['job type', { scope: { job_type: 'emergency' } }],
      ['job code', { scope: { job_code: 'emergency' } }],
      ['module', { scope: { module_key: 'parking' } }],
      ['region', { scope: { region_code: 'NZ-WGN' } }],
      ['vehicle', { scope: { vehicle_type: 'truck' } }],
      ['distance', { scope: { distance_min_km: 5 } }],
      ['outside area', { scope: { outside_area: true } }],
      ['day category', { scope: { day_category: 'weekend' } }],
      ['priority', { scope: { priority: 1 } }],
      ['rate type', { type: 'daily' }],
      ['effective dates', { from: '2027-03-01' }],
      ['asset', { asset: scopeAsset }],
    ];
    for (const [label, changes] of changedScopes) {
      await t.test(`rejects_retired_code_with_changed_${label.replaceAll(' ', '_')}_scope`, () => {
        const { next, copied } = retiredScope;
        const options = { request: randomUUID(), version: next.id, expectedAt: version(next.id).updated_at,
          action: 'update', rule: copied.id, name: copied.name, type: copied.rate_type, amount: 90,
          group: copied.rate_group, scope: {}, from: copied.effective_from, to: copied.effective_to,
          asset: copied.asset_id, ...changes };
        fails(`BEGIN; ${actor(admin)} SELECT ${draftExpression(options)}; ROLLBACK;`, /task|retired|scope/i);
        assert.equal(line(copied.id).service_type, 'retired_scope');
      });
    }

    await t.test('rejects_unapproved_code_retired_before_submission', () => {
      const card = manage(admin, { client: clientD, name: 'Retired before submission' }).result.card;
      const v = start(admin, card.id, null).version;
      draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        scope: { service_type: 'retired_pending' } });
      sql(`UPDATE public.reference_codes SET is_active=false
        WHERE organization_id='${provider}' AND code_type='service_code' AND code='retired_pending';`);
      fails(`BEGIN; ${actor(admin)} SELECT ${submitExpression(randomUUID(), v.id,
        '2027-01-01', 'Retired before submission', version(v.id).updated_at)}; ROLLBACK;`,
      /task|retired|scope/i);
    });

    await t.test('rejects_unapproved_code_retired_before_decision', () => {
      const card = manage(admin, { client: clientD, name: 'Retired before decision' }).result.card;
      const v = start(admin, card.id, null).version;
      draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        scope: { service_type: 'retired_review' } });
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      sql(`UPDATE public.reference_codes SET is_active=false
        WHERE organization_id='${provider}' AND code_type='service_code' AND code='retired_review';`);
      fails(`BEGIN; ${actor(reviewer)} SELECT ${decideExpression(randomUUID(), v.id,
        'approve', 'Retired before decision', version(v.id).updated_at)}; ROLLBACK;`,
      /task|retired|scope/i);
    });

    await t.test('preserves_all_existing_service_catalog_witness_sources', () => {
      const card = manage(admin, { client: clientD, name: 'Catalog witness sources' }).result.card;
      const v = start(admin, card.id, null).version;
      const legacyWitness = randomUUID(), rosterWitness = randomUUID(), shiftWitness = randomUUID();
      sql(`
        INSERT INTO public.module_catalog(module_key) VALUES
          ('witness_rule'),('witness_roster'),('witness_shift'),('witness_module');
        INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,service_type,active)
          VALUES ('${legacyWitness}','${provider}','billing','Legacy witness','hourly',30,'witness_rule',true);
        INSERT INTO public.roster_work_units(id,organization_id,name,work_unit_type,service_type)
          VALUES ('${rosterWitness}','${provider}','Roster witness','site','witness_roster');
        INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end)
          VALUES ('${shiftWitness}','${provider}','${admin}','witness_shift',now(),now()+interval '1 hour');
        UPDATE public.module_catalog SET active=false
          WHERE module_key IN ('witness_rule','witness_roster','witness_shift');
      `);
      for (const [code, source] of [
        ['witness_rule', 'in_use'], ['witness_roster', 'rostered'],
        ['witness_shift', 'in_use'], ['witness_module', 'module'],
      ]) {
        assert.equal(sql(`SELECT source FROM public.service_code_catalog('${provider}') WHERE code='${code}';`), source);
        assert.equal(draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
          scope: { service_type: code } }).result.line.service_type, code);
      }
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      assert.equal(decide(reviewer, v.id, 'approve', version(v.id).updated_at).version.status, 'approved');

      const branchCard = manage(admin, { org: branch, client: clientD, name: 'Ancestor task code' }).result.card;
      const branchVersion = start(admin, branchCard.id, null).version;
      assert.equal(sql(`SELECT source FROM public.service_code_catalog('${branch}') WHERE code='excavator';`),
        'registered');
      assert.equal(draft(admin, { version: branchVersion.id, expectedAt: version(branchVersion.id).updated_at,
        scope: { service_type: 'excavator' } }).result.line.service_type, 'excavator');
      submit(admin, branchVersion.id, '2027-01-01', version(branchVersion.id).updated_at);
      assert.equal(decide(branchAdmin, branchVersion.id, 'approve', version(branchVersion.id).updated_at)
        .version.status, 'approved');
    });

    await t.test('fails_closed_if_service_catalog_configuration_drifts', () => {
      const card = manage(admin, { client: clientD, name: 'Catalog configuration drift' }).result.card;
      const v = start(admin, card.id, null).version;
      const options = { request: randomUUID(), version: v.id, expectedAt: version(v.id).updated_at,
        action: 'create', rule: null, name: 'Catalog drift', type: 'hourly', amount: 80,
        group: null, scope: { service_type: 'patrol' }, from: null, to: null, asset: null };
      sql("ALTER FUNCTION public.is_known_service_code(uuid,text) SET search_path=public;");
      try {
        fails(`BEGIN; ${actor(admin)} SELECT ${draftExpression(options)}; ROLLBACK;`, /catalog/i);
        assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_card_version_id='${v.id}';`), '0');
      } finally {
        sql("ALTER FUNCTION public.is_known_service_code(uuid,text) SET search_path='';");
      }
    });

    for (const stage of ['draft', 'approval']) {
      await t.test(`${stage}_locks_its_current_service_code_until_commit`, async () => {
        const code = `retired_race_${stage}`;
        const card = manage(admin, { client: clientD, name: `${stage} service-code lock` }).result.card;
        const v = start(admin, card.id, null).version;
        const options = { request: randomUUID(), version: v.id, expectedAt: version(v.id).updated_at,
          action: 'create', rule: null, name: 'Current service rate', type: 'hourly', amount: 80,
          group: null, scope: { service_type: code }, from: null, to: null, asset: null };
        let expression = draftExpression(options), who = admin, pauseSetting = 'test.pause_rate_line_audit';
        if (stage === 'approval') {
          draft(admin, options);
          submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
          expression = decideExpression(randomUUID(), v.id, 'approve', 'Review', version(v.id).updated_at);
          who = reviewer;
          pauseSetting = 'test.pause_rate_audit';
        }
        const holderName = `fcm_${stage}_service_code_holder`;
        const actorName = `fcm_${stage}_service_code_writer`;
        const lockHolder = concurrentSql(`SET application_name='${holderName}'; BEGIN;
          SELECT pg_advisory_xact_lock(620231::bigint);
          DO $$ BEGIN PERFORM pg_sleep(30); EXCEPTION WHEN query_canceled THEN NULL; END $$; COMMIT;`);
        let sleeping = false, write;
        try {
          await waitForSleepingBackend(holderName);
          sleeping = true;
          write = concurrentSql(`SET application_name='${actorName}';
            SET ${pauseSetting}='yes'; ${actor(who)} SELECT ${expression};`);
          await waitForBlockedBackend(actorName);
          fails(`BEGIN; SET lock_timeout='1s'; UPDATE public.reference_codes SET is_active=false
            WHERE organization_id='${provider}' AND code_type='service_code' AND code='${code}';
            ROLLBACK;`, /lock timeout/i);
          releaseSleepingBackend(holderName);
          sleeping = false;
          const result = await write;
          assert.equal(result.code, 0, result.stderr);
        } finally {
          if (sleeping) releaseSleepingBackend(holderName);
          const held = await lockHolder;
          assert.equal(held.code, 0, held.stderr);
          if (write) await write;
        }
      });
    }

    await t.test('rejects_changed_scope_when_its_code_retires_before_submission', () => {
      const card = manage(admin, { client: clientD, name: 'Changed before retirement' }).result.card;
      const v = start(admin, card.id, null).version;
      const original = draft(admin, { version: v.id, expectedAt: version(v.id).updated_at,
        scope: { service_type: 'retired_changed' } }).result.line;
      submit(admin, v.id, '2027-01-01', version(v.id).updated_at);
      decide(reviewer, v.id, 'approve', version(v.id).updated_at);
      const next = start(admin, card.id, v.id).version;
      const copied = json(`SELECT row_to_json(r) FROM public.rate_rules r
        WHERE r.rate_card_version_id='${next.id}' AND r.rate_line_key='${original.rate_line_key}';`);
      draft(admin, { version: next.id, expectedAt: version(next.id).updated_at,
        action: 'update', rule: copied.id, name: copied.name, type: copied.rate_type, amount: 80,
        group: copied.rate_group, scope: { job_type: 'different' }, from: copied.effective_from,
        to: copied.effective_to, asset: copied.asset_id });
      sql(`UPDATE public.reference_codes SET is_active=false
        WHERE organization_id='${provider}' AND code_type='service_code' AND code='retired_changed';`);
      fails(`BEGIN; ${actor(admin)} SELECT ${submitExpression(randomUUID(), next.id,
        '2028-01-01', 'Scope changed before retirement', version(next.id).updated_at)}; ROLLBACK;`,
      /task|retired|scope/i);
      const removed = draft(admin, { version: next.id, expectedAt: version(next.id).updated_at,
        action: 'retire', rule: copied.id });
      assert.equal(removed.result.line.rate_card_line_enabled, false);
    });

    await t.test('preserves_shift_service_code_validation', () => {
      fails(`UPDATE public.shifts SET service_type='retired_scope' WHERE id='${shiftProbe}';`,
        /task|code/i);
      sql(`UPDATE public.shifts SET service_type='excavator' WHERE id='${shiftProbe}';`);
      assert.equal(sql(`SELECT service_type FROM public.shifts WHERE id='${shiftProbe}';`), 'excavator');
      assert.equal(sql(`SELECT public.is_known_service_code('${provider}', 'retired_scope');`), 'f');
    });

    const copyContext = (draftId, previousId) => `
      INSERT INTO public._rate_card_write_context(backend_pid,transaction_id,version_id)
        VALUES (pg_backend_pid(),txid_current(),'${draftId}');
      DO $$ BEGIN
        IF to_regclass('public._rate_card_copy_context') IS NOT NULL THEN
          INSERT INTO public._rate_card_copy_context(backend_pid,transaction_id,draft_version_id,previous_version_id)
          VALUES (pg_backend_pid(),txid_current(),'${draftId}','${previousId}');
        END IF;
      END $$;`;
    const attemptCopiedInsert = ({ sourceId, draftId, org, client, lineage, jobType = null }) => `
      INSERT INTO public.rate_rules(organization_id,rule_kind,name,rate_type,amount,service_type,job_type,
        client_org_id,rate_card_version_id,rate_line_key,rate_group,active,rate_card_line_enabled)
      SELECT '${org}',rule_kind,name,rate_type,amount,service_type,${literal(jobType)},
        ${arg(client, 'uuid')},'${draftId}','${lineage}',rate_group,false,rate_card_line_enabled
      FROM public.rate_rules WHERE id='${sourceId}';`;

    await t.test('copy_context_cannot_be_forged_by_application_roles', () => {
      if (sql(`SELECT to_regclass('public._rate_card_copy_context') IS NOT NULL;`) === 't') {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          fails(`SET ROLE ${role}; INSERT INTO public._rate_card_copy_context
            VALUES (pg_backend_pid(),txid_current(),'${retiredScope.next.id}','${retiredScope.approved.id}');`,
          /permission denied/i);
        }
      }
    });

    await t.test('draft_lineage_cannot_be_reassigned_after_copy', () => {
      const { next, copied } = retiredScope;
      fails(`BEGIN;
        INSERT INTO public._rate_card_write_context(backend_pid,transaction_id,version_id)
          VALUES (pg_backend_pid(),txid_current(),'${next.id}');
        UPDATE public.rate_rules SET rate_line_key='${randomUUID()}' WHERE id='${copied.id}';
        ROLLBACK;`, /lineage|identity/i);
    });

    await t.test('copy_exception_rejects_forged_lineage', () => {
      const { next, approved, original } = retiredScope;
      fails(`BEGIN; ${copyContext(next.id, approved.id)} ${attemptCopiedInsert({
        sourceId: original.id, draftId: next.id, org: provider, client: clientD, lineage: randomUUID(),
      })} ROLLBACK;`, /task|retired|scope|lineage/i);
    });

    await t.test('copy_exception_rejects_altered_approved_scope', () => {
      const { next, approved, original, copied } = retiredScope;
      fails(`BEGIN; ${copyContext(next.id, approved.id)}
        DELETE FROM public.rate_rules WHERE id='${copied.id}';
        ${attemptCopiedInsert({ sourceId: original.id, draftId: next.id, org: provider,
          client: clientD, lineage: original.rate_line_key, jobType: 'altered' })} ROLLBACK;`,
      /task|retired|scope|lineage/i);
    });

    await t.test('copy_exception_rejects_cross_organization_predecessor', () => {
      const { next, foreign, foreignLine } = retiredScope;
      fails(`BEGIN; ${copyContext(next.id, foreign.id)} ${attemptCopiedInsert({
        sourceId: foreignLine.id, draftId: next.id, org: provider, client: clientD,
        lineage: foreignLine.rate_line_key,
      })} ROLLBACK;`, /task|retired|scope|lineage|organization|organisation/i);
    });

    for (const tableName of ['rate_rules', 'service_agreements']) {
      await t.test(`roles_cannot_truncate_${tableName}`, () => {
        const before = sql(`SELECT count(*) FROM public.${tableName};`);
        for (const role of ['anon', 'authenticated', 'service_role']) {
          fails(`BEGIN; SET ROLE ${role}; TRUNCATE public.${tableName}; ROLLBACK;`, /permission denied/i);
        }
        assert.equal(sql(`SELECT count(*) FROM public.${tableName};`), before);
      });

      await t.test(`roles_cannot_install_unguarded_${tableName}_triggers`, () => {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          fails(`BEGIN; SET ROLE ${role}; CREATE TRIGGER test_unguarded BEFORE UPDATE ON public.${tableName}
            FOR EACH ROW EXECUTE FUNCTION public.test_noop_rate_trigger(); ROLLBACK;`, /permission denied/i);
        }
      });
    }
  } finally {
    if (created) docker(['rm', '-f', container]);
  }
});
