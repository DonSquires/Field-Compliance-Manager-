'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return `${schema.slice(start, schema.indexOf('\n);', start) + 3)}
    ALTER TABLE public.${name} ADD PRIMARY KEY(id);`;
};
const definition = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
};
const literal = value => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;

test('location billing uses agreement-scoped sources with effective dates, authority and replay receipts', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const name = `fcm-location-client-billing-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
  const sql = input => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input).trim();
  const asyncSql = input => new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1',
      '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], { encoding: 'utf8' },
    (error, stdout, stderr) => {
      if (error) reject(new Error(stderr));
      else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
  const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [provider, client, other, admin, officer, inactive, house, site, zone,
    agreement, agreement2, link, link2, module, module2, rate, foreignRate, payRate, wrongUnit]
    = Array.from({ length: 19 }, (_, n) => id(n + 1));
  const runAs = (actor, query) => sql(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub=${literal(actor)}; ${query}; COMMIT;`);
  const failAs = (actor, query, pattern) => assert.throws(() => runAs(actor, query),
    error => pattern.test(String(error.stderr ?? error.message)));
  const save = ({ request, source = 'agreement', selected = null, effective = '2026-11-01',
    locationLink = link, agreementModule = module, expected = null, create = null, unit = 'hourly',
    patrol = false, billingUnit = null }) =>
    `SELECT public.${patrol ? 'save_location_patrol_billing_selection' : 'save_location_billing_selection'}(
      p_provider_id=>${literal(provider)},p_location_id=>${literal(house)},
      p_client_request_id=>${literal(request)},
      p_service_agreement_location_id=>${literal(locationLink)},
      p_service_agreement_module_id=>${literal(agreementModule)},
      p_rate_type=>${literal(unit)},p_source=>${literal(source)},p_rate_rule_id=>${literal(selected)},
      p_effective_from=>${literal(effective)},
      p_expected_selection_id=>${literal(expected?.id)},
      p_expected_updated_at=>${literal(expected?.updated_at)},
      p_new_rate=>${literal(create && JSON.stringify(create))}::jsonb${patrol
        ? `,p_billing_unit_code=>${literal(billingUnit)}` : ''})`;
  const resolve = (date, agreementId = agreement, unit = 'hourly', place = site, area = null, job = null) =>
    JSON.parse(sql(`SELECT row_to_json(r) FROM public.resolve_agreement_place_billing_rate(
      ${literal(agreementId)},${literal(place)},${literal(area)},${literal(`${date}T12:00:00+13:00`)},
      'static_guard','static_guard',${literal(job)},NULL,'weekday',${literal(unit)}) r`));
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    sql(`
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      ${['organizations', 'user_profiles', 'locations', 'client_sites', 'location_zones',
        'service_agreements', 'service_agreement_locations', 'service_agreement_modules',
        'rate_rules', 'crm_commercial_settings', 'audit_log'].map(table).join('\n')}
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=auth.uid()
          AND p.organization_id=$1 AND p.role IN('admin','admin_officer') AND p.deactivated_at IS NULL) $$;
      CREATE FUNCTION public.user_can_operate_organization(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT public.is_admin_for_org($1) $$;
      ${definition('manage_operating_branch_rate_rule')}
      ${definition('resolve_rate_rule')}
      INSERT INTO public.organizations(id,name,organization_type,active,status) VALUES
        ('${provider}','Provider','service_provider',true,'active'),
        ('${client}','Client','client',true,'active'),('${other}','Other','service_provider',true,'active');
      INSERT INTO public.user_profiles(id,organization_id,role,display_name,deactivated_at) VALUES
        ('${admin}','${provider}','admin','Test admin',NULL),
        ('${officer}','${provider}','officer','Test officer',NULL),
        ('${inactive}','${provider}','admin','Inactive admin',now()),
        ('${id(51)}','${other}','admin','Other provider admin',NULL),
        ('${id(52)}','${provider}','admin','Second test admin',NULL);
      INSERT INTO public.locations(id,organization_id,name,canonical_place_id)
        VALUES ('${house}','${client}','Test location','${id(50)}');
      INSERT INTO public.client_sites(id,location_id,client_organization_id,organization_id,name,active)
        VALUES ('${site}','${house}','${client}','${client}','Test site',true);
      INSERT INTO public.location_zones(id,location_id,organization_id,name,module_key,is_active)
        VALUES ('${zone}','${house}','${client}','Test zone','static_guard',true);
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,starts_on,ends_on)
        VALUES ('${agreement}','${provider}','${client}','Agreement one','2026-01-01','2027-12-31'),
          ('${agreement2}','${provider}','${client}','Agreement two','2026-01-01','2027-12-31');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id)
        VALUES ('${link}','${agreement}','${site}'),('${link2}','${agreement2}','${site}');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,zone_id)
        VALUES ('${id(30)}','${agreement}','${zone}');
      INSERT INTO public.service_agreement_modules(id,service_agreement_id,module_key)
        VALUES ('${module}','${agreement}','static_guard'),('${module2}','${agreement2}','static_guard');
      INSERT INTO public.crm_commercial_settings(service_agreement_id,base_rate_per_hour,callout_rate_per_hour,travel_rate_per_km)
        VALUES ('${agreement}',39.5,57,1.25),('${agreement2}',65,NULL,NULL);
      INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount) VALUES
        ('${id(25)}','${provider}','billing','Legacy default','hourly',27),
        ('${rate}','${provider}','billing','Location charge','hourly',45.5),
        ('${foreignRate}','${other}','billing','Other provider charge','hourly',99),
        ('${payRate}','${provider}','pay','Employee pay','hourly',24),
        ('${wrongUnit}','${provider}','billing','Visit charge','per_visit',12);
      CREATE TABLE public.reference_codes(id uuid,organization_id uuid,code_type text,code text,is_active boolean);
    `);
    const migration = fs.readFileSync(path.join(root,
      'supabase/migrations/20261115230036_location_client_billing_selection.sql'), 'utf8');
    sql(migration);
    sql(fs.readFileSync(path.join(root,
      'supabase/migrations/20261116043411_patrol_billing_units.sql'), 'utf8'));

    for (const actor of [officer, inactive, id(99), id(51)]) {
      failAs(actor, save({ request: id(100) }), /administrator|access denied|authority/i);
    }
    const request = id(101);
    const inherited = JSON.parse(runAs(admin, save({ request })));
    assert.equal(inherited.selection.source, 'agreement');
    assert.equal(resolve('2026-11-01').amount, 39.5);
    assert.equal(resolve('2026-11-01').rate_rule_id, null, 'Agreement terms do not get a fake rule ID');
    assert.equal(resolve('2026-11-01', agreement, 'hourly', site, null, 'callout').amount, 57);
    assert.equal(resolve('2026-10-31').amount, 27, 'Unconfigured dates retain legacy pricing');
    assert.equal(resolve('2026-11-02', agreement2).amount, 27, 'Another agreement does not inherit this selection');
    const replay = JSON.parse(runAs(admin, save({ request })));
    assert.equal(replay.selection.id, inherited.selection.id);
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE action='location_billing_selection_saved'`), '1');
    failAs(admin, save({ request, source: 'rate_rule', selected: rate }), /request.*different|replay.*conflict/i);
    failAs(admin, save({ request: id(102), source: 'rate_rule', selected: rate }), /changed|reload|stale/i);
    for (const selected of [foreignRate, payRate, wrongUnit]) {
      failAs(admin, save({ request: id(103), source: 'rate_rule', selected, effective: '2026-11-02', expected: inherited.selection }),
        /applicable|billing rate|unit|provider/i);
    }
    failAs(admin, save({ request: id(104), locationLink: link2, agreementModule: module }),
      /module|agreement/i);
    const override = JSON.parse(runAs(admin, save({
      request: id(105), source: 'rate_rule', selected: rate, effective: '2026-11-10', expected: inherited.selection,
    })));
    assert.equal(resolve('2026-11-09').amount, 39.5);
    assert.equal(resolve('2026-11-10').amount, 45.5);
    assert.equal(resolve('2026-11-10').rate_rule_id, rate);
    sql(`UPDATE public.rate_rules SET active=false WHERE id='${rate}'`);
    const unresolved = resolve('2026-11-12');
    assert.equal(unresolved.amount, null, 'An explicit inactive selection never falls back to the provider default');
    assert.match(unresolved.reason, /inactive|applicable|unavailable/i);
    const second = JSON.parse(runAs(admin, save({
      request: id(106), locationLink: link2, agreementModule: module2,
    })));
    assert.equal(second.selection.source, 'agreement');
    assert.equal(resolve('2026-11-12', agreement2).amount, 65);
    for (const unit of ['per_km', 'per_visit']) {
      failAs(admin, save({ request: id(109), locationLink: link2, agreementModule: module2, unit }),
        /agreement rate|charging unit|charge rate/i);
    }
    sql(`UPDATE public.crm_commercial_settings SET base_rate_per_hour=NULL WHERE service_agreement_id='${agreement2}'`);
    assert.equal(resolve('2026-11-12', agreement2).amount, null, 'A removed agreement term is unresolved, not the general provider rate');
    sql(`UPDATE public.crm_commercial_settings SET base_rate_per_hour=65 WHERE service_agreement_id='${agreement2}'`);
    runAs(admin, save({ request: id(110), locationLink: id(30), unit: 'per_km' }));
    assert.equal(resolve('2026-11-12', agreement, 'per_km', null, zone).amount, 1.25);

    const createdRate = JSON.parse(runAs(admin, save({
      request: id(107), source: 'rate_rule', effective: '2026-11-15', expected: override.selection,
      create: { name: 'New agreed hourly charge', amount: 48.75 },
    })));
    assert.ok(createdRate.selection.rate_rule_id);
    assert.equal(resolve('2026-11-15').amount, 48.75);
    const repeatedCreate = JSON.parse(runAs(admin, save({
      request: id(107), source: 'rate_rule', effective: '2026-11-15', expected: override.selection,
      create: { name: 'New agreed hourly charge', amount: 48.75 },
    })));
    assert.equal(repeatedCreate.selection.rate_rule_id, createdRate.selection.rate_rule_id);
    assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE client_request_id='${id(107)}'`), '1');
    sql(`UPDATE public.rate_rules SET effective_to='2026-11-16' WHERE id='${createdRate.selection.rate_rule_id}'`);
    assert.equal(resolve('2026-11-17').amount, null, 'An expired explicit source cannot silently fall back');
    sql(`UPDATE public.rate_rules SET effective_to=NULL WHERE id='${createdRate.selection.rate_rule_id}'`);
    for (const dimension of ["day_category='weekend'", "distance_min_km=5", "job_type='noise_callout'"]) {
      sql(`UPDATE public.rate_rules SET ${dimension} WHERE id='${createdRate.selection.rate_rule_id}'`);
      assert.equal(resolve('2026-11-15').amount, null, `Unrepresented rule dimensions cannot be silently ignored: ${dimension}`);
      sql(`UPDATE public.rate_rules SET day_category=NULL,distance_min_km=NULL,job_type=NULL WHERE id='${createdRate.selection.rate_rule_id}'`);
    }

    const workspace = JSON.parse(runAs(admin, `SELECT public.get_location_billing_workspace(
      '${provider}','${house}','2026-11-15')`));
    assert.equal(workspace.agreements.length, 2);
    assert.ok(!JSON.stringify(workspace).includes('Employee pay'));
    sql(`UPDATE public.locations SET organization_id='${other}' WHERE id='${house}'`);
    failAs(admin, `SELECT public.get_location_billing_workspace('${provider}','${house}','2026-11-15')`,
      /covered location|access denied/i);
    sql(`UPDATE public.locations SET organization_id='${client}' WHERE id='${house}'`);
    const sameDayCorrection = JSON.parse(runAs(admin, save({
      request: id(108), effective: '2026-11-15', expected: createdRate.selection,
    })));
    assert.equal(resolve('2026-11-15').amount, 39.5, 'An administrator can correct a choice on its start date');
    assert.notEqual(sameDayCorrection.selection.id, createdRate.selection.id, 'Correction keeps a separate audited receipt');
    assert.equal(JSON.parse(runAs(admin, save({
      request: id(107), source: 'rate_rule', effective: '2026-11-15', expected: override.selection,
      create: { name: 'New agreed hourly charge', amount: 48.75 },
    }))).selection.id, createdRate.selection.id, 'A prior save can still be reconciled after correction');
    const concurrentSaves = await Promise.allSettled([id(111), id(112)].map(requestId =>
      asyncSql(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${admin}';
        ${save({ request: requestId, effective: '2026-11-16', expected: sameDayCorrection.selection })}; COMMIT;`)));
    assert.equal(concurrentSaves.filter(result => result.status === 'fulfilled').length, 1,
      'Only one concurrent save can consume the same version token');
    const rejectedSave = concurrentSaves.find(result => result.status === 'rejected');
    assert.match(rejectedSave.reason.message, /changed|reload|stale/i);
    assert.equal(sql(`SELECT count(*) FROM public.agreement_place_rate_selections
      WHERE service_agreement_location_id='${link}' AND rate_type='hourly'
        AND effective_from<='2026-11-16' AND (effective_to IS NULL OR effective_to>='2026-11-16')
        AND superseded_at IS NULL`), '1', 'Concurrent saves never leave overlapping effective choices');
    const latest = JSON.parse(concurrentSaves.find(result => result.status === 'fulfilled').value).selection;
    sql(`UPDATE public.rate_rules SET client_request_id='${id(113)}' WHERE id='${id(25)}'`);
    failAs(admin, save({
      request: id(113), source: 'rate_rule', effective: '2026-11-17', expected: latest,
      create: { name: 'New agreed hourly charge', amount: 51 },
    }), /request.*already|replay.*conflict/i);
    for (const actor of [officer, inactive, id(99)]) {
      failAs(actor, `SELECT public.get_location_billing_workspace('${provider}','${house}','2026-11-15')`,
        /administrator|access denied|authority/i);
    }
    failAs(admin, `INSERT INTO public.agreement_place_rate_selections DEFAULT VALUES`, /permission denied/);
    assert.throws(() => sql(`SET ROLE authenticated; SELECT * FROM public.resolve_agreement_place_billing_rate(
      '${agreement}','${site}',NULL,now(),'static_guard','static_guard',NULL,NULL,NULL,'hourly')`),
    error => /permission denied/.test(String(error.stderr ?? error.message)));

    await t.test('patrol rates preserve explicit hourly basis across retries and effective changes', () => {
      const officerHours = {
        patrol: true, request: id(120), billingUnit: 'hourly_officer',
        effective: '2026-11-17', expected: latest,
      };
      failAs(admin, save({ ...officerHours, billingUnit: null }), /charging unit|explicit basis/i);
      failAs(admin, save({ ...officerHours, billingUnit: 'per_visit' }), /charging unit|rate type/i);
      const first = JSON.parse(runAs(admin, save(officerHours)));
      assert.equal(first.selection.billing_unit_code, 'hourly_officer');
      assert.equal(resolve('2026-11-17').amount, 39.5, 'The basis does not duplicate or replace agreement money');
      assert.equal(JSON.parse(runAs(admin, save(officerHours))).selection.id, first.selection.id);
      failAs(admin, save({ ...officerHours, billingUnit: 'hourly_coverage' }), /replay.*conflict|different payload/i);
      failAs(id(52), save(officerHours), /replay.*conflict|different payload/i);
      failAs(officer, save(officerHours), /authority|administrator/i);
      assert.equal(sql(`SELECT count(*) FROM public.audit_log
        WHERE action='location_patrol_billing_selection_saved' AND target_id='${first.selection.id}'`), '1');

      const siteCoverage = {
        patrol: true, request: id(121), billingUnit: 'hourly_coverage',
        effective: '2026-11-18', expected: first.selection,
      };
      const second = JSON.parse(runAs(admin, save(siteCoverage)));
      assert.equal(second.selection.billing_unit_code, 'hourly_coverage');
      const before = JSON.parse(sql(`SELECT row_to_json(s) FROM public.agreement_place_rate_selections s
        WHERE id='${first.selection.id}'`));
      assert.equal(before.billing_unit_code, 'hourly_officer');
      assert.equal(before.effective_to, '2026-11-17');
      assert.notEqual(first.selection.id, second.selection.id);
      sql(`UPDATE public.patrol_billing_units SET active=false WHERE code='hourly_coverage'`);
      assert.equal(JSON.parse(runAs(admin, save(siteCoverage))).selection.id, second.selection.id,
        'Deactivating a unit does not hide an already committed retry receipt');
      failAs(admin, save({ ...siteCoverage, request: id(122), effective: '2026-11-19',
        expected: second.selection }), /inactive|active patrol/i);
      assert.equal(sql(`SELECT count(*) FROM public.agreement_place_rate_selections
        WHERE client_request_id='${id(122)}'`), '0', 'An inactive choice rolls back the underlying rate save');
      assert.equal(resolve('2026-11-19').selection_id, second.selection.id);

      failAs(admin, save({ patrol: true, request: latest.client_request_id,
        billingUnit: 'hourly_officer', effective: '2026-11-16', expected: sameDayCorrection.selection }),
      /replay.*conflict|different payload|new request/i);
      assert.equal(sql(`SELECT billing_unit_code IS NULL FROM public.agreement_place_rate_selections
        WHERE id='${latest.id}'`), 't', 'A generic historical receipt cannot acquire a patrol basis by replay');
      failAs(admin, `UPDATE public.patrol_billing_units SET label='Tampered'`, /permission denied/);
      assert.throws(() => sql(`SET ROLE anon; ${save(officerHours)}`),
        error => /permission denied/.test(String(error.stderr ?? error.message)));
    });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
