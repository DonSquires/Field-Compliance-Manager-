'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
const id = number => `61000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

function table(name) {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, `Live snapshot contains ${name}`);
  return `${schema.slice(start, schema.indexOf('\n);', start) + 3)}
    ALTER TABLE public.${name} ADD PRIMARY KEY (id);`;
}

function definition(name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `Live snapshot contains ${name}`);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
}

test('real PostgreSQL preserves historical pricing, reports conflicts, and isolates the foundation', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 180000,
}, async t => {
  const migrationNames = fs.readdirSync(path.join(root, 'supabase', 'migrations'))
    .filter(file => /^\d{14}_rate_card_foundation\.sql$/.test(file));
  assert.equal(migrationNames.length, 1, 'Foundation migration is required before PostgreSQL validation');
  const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', migrationNames[0]), 'utf8');
  const reportSql = fs.readFileSync(path.join(root, 'scripts', 'rate-card-discrepancy-report.sql'), 'utf8');
  const name = `fcm-rate-cards-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
  const sql = input => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input).trim();
  const json = input => JSON.parse(sql(input));
  const fails = (input, message) => assert.throws(() => sql(input), error =>
    message.test(String(error.stderr ?? error.message)));
  const provider = id(1), otherProvider = id(2), emptyBranch = id(3);
  const health = id(10), otherClient = id(11), archivedClient = id(12);
  const temporalClient = id(13), scopedClient = id(14), overtimeClient = id(15), competitionClient = id(16);
  const agreement = id(20), agreementTwo = id(21), foreignAgreement = id(22), zeroAgreement = id(23);
  const temporalAgreement = id(24), scopedAgreement = id(25), overtimeAgreement = id(26), futureAgreement = id(27);
  const coveredOne = id(40), coveredTwo = id(41), sharedSite = id(42);
  const [standingHourly, standingTravel, staffPay, healthStaticOld, healthStaticNew,
    healthTravelOld, healthTravelNew, archivedRate, otherRate, response, excavator,
    inactiveOnly, zeroRule, healthTravelOtherScope] = Array.from({ length: 14 }, (_, index) => id(100 + index));
  const [scopeBase, regionScope, jobScope, vehicleScope, outsideScope, minScope, maxScope] =
    Array.from({ length: 7 }, (_, index) => id(120 + index));
  const highMinScope = id(127);
  const [pastCandidate, futureCandidate, scopedCandidate, overtimeCandidate, competitionFirst,
    competitionSecond, competitionOtherType] = Array.from({ length: 7 }, (_, index) => id(130 + index));
  const scopeVariants = [
    { id: regionScope, field: 'region_code', value: 'NZ-TAS' },
    { id: jobScope, field: 'job_code', value: 'job-a' },
    { id: vehicleScope, field: 'vehicle_type', value: 'truck' },
    { id: outsideScope, field: 'outside_area', value: true },
    { id: minScope, field: 'distance_min_km', value: 5 },
    { id: maxScope, field: 'distance_max_km', value: 10 },
  ];
  let created = false;

  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
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
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY);
      ${['organizations', 'service_agreements', 'service_agreement_locations', 'service_agreement_modules',
        'agreement_place_rate_selections', 'crm_commercial_settings', 'rate_rules'].map(table).join('\n')}
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT coalesce(current_setting('test.is_grand_master', true), '') = 'yes' $$;
      CREATE FUNCTION public.user_can_operate_organization(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1::text = coalesce(current_setting('test.operating_organization', true), '') $$;
      ${definition('tg_touch_updated_at')}
      ${definition('resolve_rate_rule')}
      ${definition('location_billing_rule_applicable')}
      ${definition('resolve_agreement_place_billing_rate')}
      CREATE TRIGGER trg_rate_rules_touch BEFORE UPDATE ON public.rate_rules
        FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

      INSERT INTO public.organizations(id,name,organization_type,active) VALUES
        ('${provider}','Synthetic provider','service_provider',true),
        ('${otherProvider}','Other provider','service_provider',true),
        ('${emptyBranch}','Empty branch','branch',true),
        ('${health}','Synthetic NZ Health','client',true),
        ('${otherClient}','Other client','client',true),
        ('${archivedClient}','Former client','client',false),
        ('${temporalClient}','Temporal comparison client','client',true),
        ('${scopedClient}','Scoped comparison client','client',true),
        ('${overtimeClient}','Overtime comparison client','client',true),
        ('${competitionClient}','Resolver competition client','client',true);
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,starts_on)
        VALUES ('${agreement}','${provider}','${health}','Health agreement one','2024-01-01'),
          ('${agreementTwo}','${provider}','${health}','Health agreement two','2024-01-01'),
          ('${foreignAgreement}','${otherProvider}','${otherClient}','Other agreement','2024-01-01'),
          ('${zeroAgreement}','${provider}','${otherClient}','Zero price needs review','2024-01-01'),
          ('${temporalAgreement}','${provider}','${temporalClient}','Temporal review','2024-01-01'),
          ('${scopedAgreement}','${provider}','${scopedClient}','Scoped review','2024-01-01'),
          ('${overtimeAgreement}','${provider}','${overtimeClient}','Overtime review','2024-01-01'),
          ('${futureAgreement}','${provider}','${overtimeClient}','Future agreement review','2999-01-01');
      INSERT INTO public.crm_commercial_settings(id,service_agreement_id,currency,
        commercial_model,billing_cycle,base_rate_per_hour,overtime_rate_per_hour,callout_rate_per_hour,travel_rate_per_km) VALUES
        ('${id(30)}','${agreement}','NZD','fixed_price_with_extras','monthly',95,NULL,65,1.40),
        ('${id(31)}','${agreementTwo}','NZD','pay_as_you_go','weekly',70,NULL,NULL,NULL),
        ('${id(32)}','${zeroAgreement}','NZD',NULL,'monthly',0,NULL,NULL,NULL),
        ('${id(33)}','${temporalAgreement}','NZD','pay_as_you_go','monthly',88,NULL,NULL,NULL),
        ('${id(34)}','${scopedAgreement}','NZD','pay_as_you_go','weekly',77,NULL,NULL,NULL),
        ('${id(35)}','${overtimeAgreement}','NZD','pay_as_you_go','weekly',NULL,130,NULL,NULL),
        ('${id(36)}','${futureAgreement}','NZD','pay_as_you_go','monthly',100,NULL,NULL,NULL);
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id) VALUES
        ('${coveredOne}','${agreement}','${sharedSite}'),
        ('${coveredTwo}','${agreementTwo}','${sharedSite}');
      INSERT INTO public.agreement_place_rate_selections(id,organization_id,
        service_agreement_location_id,rate_type,source,effective_from,client_request_id,request_fingerprint,created_by)
      VALUES
        ('${id(50)}','${provider}','${coveredOne}','hourly','agreement','2024-01-01','${id(60)}','{}','${id(98)}'),
        ('${id(51)}','${provider}','${coveredOne}','per_km','agreement','2024-01-01','${id(61)}','{}','${id(98)}'),
        ('${id(52)}','${provider}','${coveredTwo}','hourly','agreement','2024-01-01','${id(62)}','{}','${id(98)}');
      INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,
        client_org_id,service_type,job_type,staff_id,effective_from,effective_to,active,updated_at)
      VALUES
        ('${standingHourly}','${provider}','billing','Standing patrol','hourly',54.10,
          NULL,'patrol',NULL,NULL,NULL,NULL,true,'2024-01-01T00:00:00Z'),
        ('${standingTravel}','${provider}','billing','Standing travel','per_km',1.04,
          NULL,NULL,NULL,NULL,'2025-04-01',NULL,true,'2024-01-02T00:00:00Z'),
        ('${staffPay}','${provider}','pay','Staff pay','hourly',25,
          '${health}','patrol',NULL,'${id(99)}','2023-01-01',NULL,true,'2024-01-03T00:00:00Z'),
        ('${healthStaticOld}','${provider}','billing','Health NZ Mental Health Static Site Rate','hourly',70,
          '${health}','static_guard',NULL,NULL,NULL,NULL,true,'2024-01-04T00:00:00Z'),
        ('${healthStaticNew}','${provider}','billing','Health NZ Mental Health Static Site Rate','hourly',72,
          '${health}','static_guard',NULL,NULL,NULL,NULL,true,'2024-01-05T00:00:00Z'),
        ('${healthTravelOld}','${provider}','billing','NZ Health','per_km',1.20,
          '${health}',NULL,NULL,NULL,'2025-01-01',NULL,true,'2024-01-06T00:00:00Z'),
        ('${healthTravelNew}','${provider}','billing','NZ Health','per_km',1.30,
          '${health}',NULL,NULL,NULL,'2025-01-01',NULL,true,'2024-01-07T00:00:00Z'),
        ('${archivedRate}','${provider}','billing','Old Health rate','hourly',60,
          '${health}','static_guard',NULL,NULL,'2022-01-01','2023-12-31',false,'2024-01-08T00:00:00Z'),
        ('${otherRate}','${provider}','billing','Other client rate','hourly',80,
          '${otherClient}','patrol',NULL,NULL,'2024-06-01',NULL,true,'2024-01-09T00:00:00Z'),
        ('${response}','${provider}','billing','Response','hourly',110,
          NULL,NULL,'callout',NULL,'2023-01-01',NULL,true,'2024-01-10T00:00:00Z'),
        ('${excavator}','${provider}','billing','Excavator','hourly',130,
          NULL,'excavator',NULL,NULL,'2024-01-01',NULL,true,'2024-01-11T00:00:00Z'),
        ('${inactiveOnly}','${provider}','billing','Former client rate','hourly',99,
          '${archivedClient}','patrol',NULL,NULL,'2021-01-01','2022-01-01',false,'2024-01-12T00:00:00Z'),
        ('${zeroRule}','${provider}','billing','Zero is not a resolved price','hourly',0,
          '${otherClient}','zero_fixture',NULL,NULL,'2025-01-01',NULL,true,'2024-01-13T00:00:00Z'),
        ('${healthTravelOtherScope}','${provider}','billing','NZ Health','per_km',1.50,
          '${health}','patrol',NULL,NULL,'2025-01-01',NULL,true,'2024-01-14T00:00:00Z');
      INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,
        client_org_id,service_type,region_code,job_code,vehicle_type,outside_area,
        distance_min_km,distance_max_km,effective_from)
      VALUES
        ('${scopeBase}','${provider}','billing','Scope review fixture','hourly',31.25,
          '${health}','scope_probe',NULL,NULL,NULL,NULL,NULL,NULL,'2025-01-01'),
        ('${regionScope}','${provider}','billing','Scope review fixture','hourly',31.25,
          '${health}','scope_probe','NZ-TAS',NULL,NULL,NULL,NULL,NULL,'2025-01-01'),
        ('${jobScope}','${provider}','billing','Scope review fixture','hourly',31.25,
          '${health}','scope_probe',NULL,'job-a',NULL,NULL,NULL,NULL,'2025-01-01'),
        ('${vehicleScope}','${provider}','billing','Scope review fixture','hourly',31.25,
          '${health}','scope_probe',NULL,NULL,'truck',NULL,NULL,NULL,'2025-01-01'),
        ('${outsideScope}','${provider}','billing','Scope review fixture','hourly',31.25,
          '${health}','scope_probe',NULL,NULL,NULL,true,NULL,NULL,'2025-01-01'),
        ('${minScope}','${provider}','billing','Scope review fixture','hourly',31.25,
          '${health}','scope_probe',NULL,NULL,NULL,NULL,5,NULL,'2025-01-01'),
        ('${maxScope}','${provider}','billing','Scope review fixture','hourly',31.25,
          '${health}','scope_probe',NULL,NULL,NULL,NULL,NULL,10,'2025-01-01'),
        ('${highMinScope}','${provider}','billing','Farther only','hourly',32,
          '${health}','scope_probe',NULL,NULL,NULL,NULL,15,NULL,'2025-01-01');
      INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,
        client_org_id,service_type,region_code,job_code,vehicle_type,outside_area,
        effective_from,effective_to,active,updated_at)
      VALUES
        ('${pastCandidate}','${provider}','billing','Expired equal rate','hourly',88,
          '${temporalClient}',NULL,NULL,NULL,NULL,NULL,'2000-01-01','2001-01-01',true,'2024-01-01T00:00:00Z'),
        ('${futureCandidate}','${provider}','billing','Future equal rate','hourly',88,
          '${temporalClient}',NULL,NULL,NULL,NULL,NULL,'2999-01-01',NULL,true,'2024-01-02T00:00:00Z'),
        ('${scopedCandidate}','${provider}','billing','Unrelated service rate','hourly',77,
          '${scopedClient}','patrol',NULL,NULL,NULL,NULL,'2024-01-01',NULL,true,'2024-01-03T00:00:00Z'),
        ('${overtimeCandidate}','${provider}','billing','Generic hourly rate','hourly',100,
          '${overtimeClient}',NULL,NULL,NULL,NULL,NULL,'2024-01-01',NULL,true,'2024-01-04T00:00:00Z'),
        ('${competitionFirst}','${provider}','billing','First resolver candidate','hourly',40,
          '${competitionClient}','scope_probe','NZ-A','job-a','car',false,'2024-01-01',NULL,true,'2024-01-05T00:00:00Z'),
        ('${competitionSecond}','${provider}','billing','Differently named candidate','hourly',75,
          '${competitionClient}','scope_probe','NZ-B','job-b','van',true,'2024-01-01',NULL,true,'2024-01-06T00:00:00Z'),
        ('${competitionOtherType}','${provider}','billing','Another unit candidate','daily',250,
          '${competitionClient}','scope_probe','NZ-A','job-a','car',false,'2024-01-01',NULL,true,'2024-01-07T00:00:00Z');
      CREATE TABLE public.test_original_rules AS SELECT id,to_jsonb(r) AS original FROM public.rate_rules r;
      CREATE TABLE public.test_original_terms AS SELECT id,to_jsonb(c) AS original FROM public.crm_commercial_settings c;
    `);

    const resolveStatic = () => json(`SELECT row_to_json(r) FROM public.resolve_rate_rule(
      '${provider}','billing','2026-11-18T12:00:00+13:00','static_guard',NULL,NULL,
      '${health}',NULL,NULL,NULL,NULL,'weekday','hourly') r`);
    const resolveTravel = () => json(`SELECT row_to_json(r) FROM public.resolve_rate_rule(
      '${provider}','billing','2026-11-18T12:00:00+13:00',NULL,NULL,NULL,
      '${health}',NULL,NULL,NULL,NULL,'weekday','per_km') r`);
    const resolveResponse = () => json(`SELECT row_to_json(r) FROM public.resolve_rate_rule(
      '${provider}','billing','2026-11-18T12:00:00+13:00',NULL,'callout',NULL,
      '${health}',NULL,NULL,NULL,NULL,'weekday','hourly') r`);
    const resolveAgreement = (agreementId, jobType, rateType) => json(`SELECT row_to_json(r)
      FROM public.resolve_agreement_place_billing_rate(
        '${agreementId}','${sharedSite}',NULL,'2026-11-18T12:00:00+13:00','static_guard',NULL,
        ${jobType === null ? 'NULL' : `'${jobType}'`},NULL,'weekday','${rateType}') r`);
    const snapshotResolutions = () => ({
      static: resolveStatic(), travel: resolveTravel(), response: resolveResponse(),
      firstAgreement: resolveAgreement(agreement, null, 'hourly'),
      secondAgreement: resolveAgreement(agreementTwo, null, 'hourly'),
      callout: resolveAgreement(agreement, 'callout', 'hourly'),
      otherJob: resolveAgreement(agreement, 'other_job', 'hourly'),
      agreementTravel: resolveAgreement(agreement, null, 'per_km'),
      missingCallout: resolveAgreement(agreementTwo, 'callout', 'hourly'),
    });
    const before = snapshotResolutions();
    assert.equal(before.static.rate_rule_id, healthStaticNew);
    assert.equal(Number(before.static.amount), 72);
    assert.equal(before.travel.rate_rule_id, healthTravelNew);
    assert.equal(before.response.rate_rule_id, response);
    assert.equal(Number(before.firstAgreement.amount), 95);
    assert.equal(Number(before.secondAgreement.amount), 70);
    assert.equal(Number(before.callout.amount), 65);
    assert.equal(Number(before.otherJob.amount), 65);
    assert.equal(Number(before.agreementTravel.amount), 1.4);
    assert.equal(before.missingCallout.amount, null);

    await t.test('the read-only preview identifies overlapping live duplicates and distinct agreement prices', () => {
      const report = json(reportSql);
      assert.equal(report.read_only, true, 'The preview runs inside a read-only transaction');
      const pairs = report.duplicate_live_rules.map(row => [row.first_rule_id, row.second_rule_id].sort().join(':'));
      assert.ok(pairs.includes([healthStaticOld, healthStaticNew].sort().join(':')),
        'The two synthetic Health NZ static rules are reported');
      assert.ok(pairs.includes([healthTravelOld, healthTravelNew].sort().join(':')),
        'The two synthetic NZ Health travel rules are reported');
      assert.ok(!pairs.includes([healthTravelOld, healthTravelOtherScope].sort().join(':')),
        'Different scopes are not labelled as exact duplicate rules');
      assert.ok(Array.isArray(report.active_name_collisions) && report.active_name_collisions.some(row =>
        [row.first_rule_id, row.second_rule_id].sort().join(':')
          === [healthTravelOld, healthTravelOtherScope].sort().join(':')),
      'Same-name rules in different scopes are still visible for review');
      assert.ok(report.agreement_price_conflicts.some(row =>
        row.agreement_id === agreement && row.commercial_field === 'travel_rate_per_km'
        && Number(row.setting_amount) === 1.4));
      assert.ok(Array.isArray(report.agreement_rule_exclusions));
      for (const agreementId of [agreement, agreementTwo]) {
        assert.ok(report.agreement_rule_exclusions.some(row =>
          row.agreement_id === agreementId && row.commercial_field === 'base_rate_per_hour'
          && row.candidate_rule.id === healthStaticNew
          && row.exclusion_reasons.includes('scope_context_required')),
        'Each agreement independently exposes the service-scoped rate for review');
      }
      assert.ok(Array.isArray(report.invalid_live_rule_prices)
        && report.invalid_live_rule_prices.some(row => row.id === zeroRule),
        'An existing zero rule is preserved and explicitly flagged, not treated as a valid price');
      assert.ok(Array.isArray(report.invalid_agreement_prices)
        && report.invalid_agreement_prices.some(row =>
          row.agreement_id === zeroAgreement && row.commercial_field === 'base_rate_per_hour'),
      'A zero agreement setting is explicitly flagged for review');
      assert.ok(report.planned_cards.some(card =>
        card.organization_id === provider && card.client_organization_id === health
        && card.card_name === 'Synthetic NZ Health'
        && card.versions.some(version => version.rules.some(rule => rule.id === healthStaticOld))));
      assert.deepEqual(report.unplaced_rules, []);
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules r
        JOIN public.test_original_rules original USING(id) WHERE to_jsonb(r) IS DISTINCT FROM original.original`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.crm_commercial_settings c
        JOIN public.test_original_terms original USING(id) WHERE to_jsonb(c) IS DISTINCT FROM original.original`), '0');
    });

    await t.test('scoped hourly rules remain callout review candidates, not general price matches', () => {
      const report = json(reportSql);
      assert.ok(Array.isArray(report.agreement_rule_exclusions));
      const callout = report.agreement_rule_exclusions.find(row =>
        row.agreement_id === agreement && row.commercial_field === 'callout_rate_per_hour');
      assert.ok(callout, 'Scoped hourly rules are exposed for non-null-job callout review');
      assert.ok(report.agreement_rule_exclusions.some(row =>
        row.agreement_id === agreement && row.commercial_field === 'callout_rate_per_hour'
        && row.candidate_rule.id === healthStaticNew && row.exclusion_reasons.includes('scope_context_required')));
      const comparison = report.agreement_price_comparisons.find(row =>
        row.agreement_id === agreement && row.commercial_field === 'callout_rate_per_hour');
      assert.ok(!comparison.candidate_rules.some(rule => rule.id === healthStaticNew),
        'A service-specific rule is not claimed to be generally applicable');
    });

    await t.test('same-name rules differing in legacy scopes remain review candidates, not exact duplicates', () => {
      const report = json(reportSql);
      const pairKey = (first, second) => [first, second].sort().join(':');
      const duplicates = new Set(report.duplicate_live_rules.map(row => pairKey(row.first_rule_id, row.second_rule_id)));
      for (const variant of scopeVariants) {
        const key = pairKey(scopeBase, variant.id);
        assert.ok(!duplicates.has(key), `${variant.field} distinguishes the two rule scopes`);
        const collision = report.active_name_collisions.find(row => pairKey(row.first_rule_id, row.second_rule_id) === key);
        assert.ok(collision, `${variant.field} remains visible as a same-name review candidate`);
        const baseScope = collision.first_rule_id === scopeBase ? collision.first_scope : collision.second_scope;
        const changedScope = collision.first_rule_id === variant.id ? collision.first_scope : collision.second_scope;
        assert.equal(baseScope[variant.field], null, `The unset ${variant.field} is visible`);
        assert.equal(changedScope[variant.field], variant.value, `The changed ${variant.field} is visible`);
      }
    });

    await t.test('card, duplicate, commercial and invalid-price details retain legacy scope dimensions', () => {
      const report = json(reportSql);
      const rules = report.planned_cards.flatMap(card => card.versions.flatMap(version => version.rules));
      const base = rules.find(rule => rule.id === scopeBase);
      const exactDuplicate = report.duplicate_live_rules.find(row =>
        [row.first_rule_id, row.second_rule_id].includes(healthTravelOld)
        && [row.first_rule_id, row.second_rule_id].includes(healthTravelNew));
      assert.ok(Array.isArray(report.agreement_rule_exclusions));
      const invalid = report.invalid_live_rule_prices.find(row => row.id === zeroRule);
      for (const variant of scopeVariants) {
        assert.equal(base[variant.field], null, `Planned base rule exposes ${variant.field}`);
        const plannedRule = rules.find(rule => rule.id === variant.id);
        assert.equal(plannedRule[variant.field], variant.value, `Planned rule exposes ${variant.field}`);
        assert.equal(exactDuplicate[variant.field], null, `Duplicate review exposes ${variant.field}`);
        const candidate = report.agreement_rule_exclusions.find(row =>
          row.agreement_id === agreement && row.commercial_field === 'base_rate_per_hour'
          && row.candidate_rule.id === variant.id).candidate_rule;
        assert.equal(candidate[variant.field], variant.value, `Commercial candidate exposes ${variant.field}`);
        assert.equal(invalid[variant.field], null, `Invalid-price review exposes ${variant.field}`);
      }
    });

    await t.test('ambiguous agreement mappings carry commercial context for owner review', () => {
      const report = json(reportSql);
      assert.ok(Array.isArray(report.agreement_price_comparisons));
      const baseConflict = report.agreement_price_comparisons.find(row =>
        row.agreement_id === agreement && row.commercial_field === 'base_rate_per_hour');
      assert.equal(baseConflict.commercial_model, 'fixed_price_with_extras');
      assert.equal(baseConflict.billing_cycle, 'monthly');
      const secondConflict = report.agreement_price_comparisons.find(row =>
        row.agreement_id === agreementTwo && row.commercial_field === 'base_rate_per_hour');
      assert.equal(secondConflict.commercial_model, 'pay_as_you_go');
      assert.equal(secondConflict.billing_cycle, 'weekly');
      const issues = report.agreement_mapping_review;
      assert.ok(Array.isArray(issues), 'Owner-review mapping issues are explicit');
      const base = issues.find(row => row.agreement_id === agreement
        && row.issue_code === 'base_rate_hourly_or_retainer');
      const callout = issues.find(row => row.agreement_id === agreement
        && row.issue_code === 'callout_non_null_job_type');
      assert.equal(base.commercial_field, 'base_rate_per_hour');
      assert.equal(Number(base.setting_amount), 95);
      assert.equal(base.commercial_model, 'fixed_price_with_extras');
      assert.equal(base.billing_cycle, 'monthly');
      assert.equal(base.owner_review_required, true);
      assert.equal(callout.commercial_field, 'callout_rate_per_hour');
      assert.equal(Number(callout.setting_amount), 65);
      assert.equal(callout.owner_review_required, true);
      assert.ok(issues.some(row => row.agreement_id === agreementTwo
        && row.issue_code === 'base_rate_hourly_or_retainer' && row.billing_cycle === 'weekly'));
      const invalid = report.invalid_agreement_prices.find(row => row.agreement_id === zeroAgreement);
      assert.equal(invalid.commercial_model, null);
      assert.equal(invalid.billing_cycle, 'monthly');
    });

    await t.test('overtime amounts are reported as unresolved hourly comparisons', () => {
      const report = json(reportSql);
      const comparison = report.agreement_price_conflicts.find(row =>
        row.agreement_id === overtimeAgreement && row.commercial_field === 'overtime_rate_per_hour');
      assert.ok(comparison, 'A different overtime amount remains visible for owner review');
      assert.equal(Number(comparison.setting_amount), 130);
      assert.equal(comparison.candidate_count, 1);
      assert.equal(comparison.candidate_rules[0].id, overtimeCandidate);
      assert.ok(report.agreement_mapping_review.some(row =>
        row.agreement_id === overtimeAgreement && row.issue_code === 'overtime_scope_unmapped'
        && row.owner_review_required), 'An hourly comparison does not invent an overtime mapping');
    });

    await t.test('expired, future and scoped equal rates do not suppress missing general-rate review', () => {
      const report = json(reportSql);
      assert.ok(Array.isArray(report.agreement_price_comparisons));
      assert.ok(Array.isArray(report.agreement_rule_exclusions));
      for (const agreementId of [temporalAgreement, scopedAgreement]) {
        const comparison = report.agreement_price_comparisons.find(row =>
          row.agreement_id === agreementId && row.commercial_field === 'base_rate_per_hour');
        assert.equal(comparison.candidate_count, 0);
        assert.deepEqual(comparison.candidate_rules, []);
        assert.ok(report.agreement_prices_without_client_rule.some(row =>
          row.agreement_id === agreementId && row.commercial_field === 'base_rate_per_hour'));
      }
      for (const [agreementId, ruleId, reason] of [
        [temporalAgreement, pastCandidate, 'expired'],
        [temporalAgreement, futureCandidate, 'future'],
        [scopedAgreement, scopedCandidate, 'scope_context_required'],
        [futureAgreement, overtimeCandidate, 'agreement_not_current'],
      ]) {
        assert.ok(report.agreement_rule_exclusions.some(row =>
          row.agreement_id === agreementId && row.candidate_rule.id === ruleId
          && row.exclusion_reasons.includes(reason)), `${reason} is explicit`);
      }
      const future = report.agreement_price_comparisons.find(row =>
        row.agreement_id === futureAgreement && row.commercial_field === 'base_rate_per_hour');
      assert.equal(future.agreement_current_on_reference_date, false);
      assert.equal(future.candidate_count, 0);
      assert.ok(!report.agreement_prices_without_client_rule.some(row => row.agreement_id === futureAgreement),
        'An agreement outside the reference date is not claimed to lack a current general rate');
    });

    await t.test('legacy-resolver overlap does not depend on names or ignored stored dimensions', () => {
      const report = json(reportSql);
      assert.ok(Array.isArray(report.legacy_resolver_competition));
      const pair = (row, first, second) =>
        [row.first_rule_id, row.second_rule_id].sort().join(':') === [first, second].sort().join(':');
      assert.ok(!report.duplicate_live_rules.some(row => pair(row, competitionFirst, competitionSecond)),
        'Different stored scopes are not exact duplicates');
      assert.ok(!report.active_name_collisions.some(row => pair(row, competitionFirst, competitionSecond)),
        'Differently named rules are not name collisions');
      const overlap = report.legacy_resolver_competition.find(row => pair(row, competitionFirst, competitionSecond));
      assert.ok(overlap, 'Ignored stored differences and names cannot hide possible resolver competition');
      assert.equal(overlap.requires_unspecified_rate_type, false);
      for (const dimension of ['region_code', 'job_code', 'vehicle_type', 'outside_area']) {
        assert.notEqual(overlap.first_scope[dimension], overlap.second_scope[dimension]);
      }
      const otherUnit = report.legacy_resolver_competition.find(row => pair(row, competitionFirst, competitionOtherType));
      assert.ok(otherUnit && otherUnit.requires_unspecified_rate_type,
        'Different rate types can compete only when the optional type is omitted');
      for (const variant of [regionScope, jobScope, vehicleScope, outsideScope]) {
        assert.ok(report.legacy_resolver_competition.some(row => pair(row, scopeBase, variant)),
          'Ignored dimensions are not treated as resolver filters');
      }
      assert.ok(report.legacy_resolver_competition.some(row => pair(row, minScope, maxScope)),
        'Overlapping distance intervals can compete');
      assert.ok(!report.legacy_resolver_competition.some(row => pair(row, highMinScope, maxScope)),
        'Disjoint distance intervals cannot compete');
      assert.ok(!report.legacy_resolver_competition.some(row => pair(row, healthStaticNew, scopeBase)),
        'Different concrete service scopes cannot compete');
      assert.ok(!report.legacy_resolver_competition.some(row => pair(row, pastCandidate, futureCandidate)),
        'Non-overlapping dates cannot compete');
      assert.ok(!report.legacy_resolver_competition.some(row => pair(row, archivedRate, healthStaticNew)),
        'Inactive rules do not compete');
      const resolver = `SELECT row_to_json(r) FROM public.resolve_rate_rule(
        '${provider}','billing','2026-11-18T12:00:00+13:00','scope_probe',NULL,NULL,
        '${competitionClient}',NULL,NULL,NULL,NULL,'weekday','hourly') r`;
      assert.equal(json(resolver).rate_rule_id, competitionSecond);
      assert.equal(json(`BEGIN; UPDATE public.rate_rules SET active=false WHERE id='${competitionSecond}';
        ${resolver}; ROLLBACK;`).rate_rule_id, competitionFirst,
      'Both rules can actually be selected by the unchanged legacy resolver');
    });

    sql(migration);

    await t.test('agreement terms and legacy resolution stay unchanged until the card-aware cut-over', () => {
      assert.equal(sql(`SELECT count(*) FROM public.service_agreements
        WHERE id IN ('${agreement}', '${agreementTwo}') AND rate_card_id IS NULL`), '2',
      'Neither agreement is prematurely assigned a card');
      assert.equal(sql(`SELECT count(*) FROM public.test_original_terms original
        FULL JOIN public.crm_commercial_settings c USING(id)
        WHERE original.id IS NULL OR c.id IS NULL OR to_jsonb(c) IS DISTINCT FROM original.original`), '0',
      'All original commercial fields and rows are unchanged');
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules r
        LEFT JOIN public.test_original_rules original USING(id) WHERE original.id IS NULL`), '0',
      'No extra legacy-visible price rule is created');
      assert.deepEqual(snapshotResolutions(), before,
        'Legacy rule IDs, agreement amounts and other resolution outputs remain unchanged');
    });

    await t.test('every original ID, scope, timestamp, price, effective date, and inactive flag survives', () => {
      assert.equal(sql(`SELECT count(*) FROM public.test_original_rules original
        LEFT JOIN public.rate_rules r USING(id)
        WHERE r.id IS NULL
          OR (to_jsonb(r)-ARRAY['rate_card_version_id','rate_line_key','rate_group'])
            IS DISTINCT FROM original.original`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.crm_commercial_settings c
        JOIN public.test_original_terms original USING(id) WHERE to_jsonb(c) IS DISTINCT FROM original.original`), '0');
      assert.deepEqual(resolveStatic(), before.static, 'The legacy resolver selects the same original rule and amount');
      assert.equal(sql(`SELECT count(DISTINCT r.rate_line_key) = count(original.id)
        FROM public.rate_rules r JOIN public.test_original_rules original USING(id)`), 't');
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules WHERE rate_line_key IS NULL OR rate_card_version_id IS NULL`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules r JOIN public.rate_card_versions v
        ON v.id=r.rate_card_version_id WHERE r.active AND (v.version_number<>1 OR v.status<>'approved')`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules r JOIN public.rate_card_versions v
        ON v.id=r.rate_card_version_id WHERE NOT r.active AND v.status<>'retired'`), '0');
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules r JOIN public.rate_card_versions v
        ON v.id=r.rate_card_version_id WHERE
        (v.effective_from IS NOT NULL AND (r.effective_from IS NULL OR v.effective_from>r.effective_from))
        OR (v.effective_to IS NOT NULL AND (r.effective_to IS NULL OR v.effective_to<r.effective_to))`), '0',
      'A card version covers every date its legacy rule could cover');
      assert.equal(sql(`SELECT count(*) FROM pg_trigger WHERE tgrelid='public.rate_rules'::regclass
        AND tgname='trg_rate_rules_touch' AND tgenabled='O'`), '1',
      'The original update trigger is restored after backfill');
    });

    await t.test('standard cards and editable groups reflect the existing branch and client scopes', () => {
      assert.equal(sql(`SELECT count(*) FROM public.rate_cards
        WHERE organization_id='${provider}' AND is_standard AND active AND kind IN ('charge','pay')`), '2');
      assert.equal(sql(`SELECT count(*) FROM public.rate_cards
        WHERE organization_id='${emptyBranch}' AND is_standard AND active AND kind IN ('charge','pay')`), '2');
      assert.equal(sql(`SELECT count(*) FROM public.rate_cards
        WHERE organization_id='${provider}' AND client_organization_id='${health}' AND is_client_default AND active`), '1');
      assert.equal(sql(`SELECT count(*) FROM public.rate_rules r JOIN public.rate_card_versions v ON v.id=r.rate_card_version_id
        JOIN public.rate_cards c ON c.id=v.rate_card_id WHERE r.id='${staffPay}' AND r.client_org_id='${health}'
          AND c.kind='pay' AND c.is_standard`), '1');
      assert.equal(sql(`SELECT rate_group FROM public.rate_rules WHERE id='${standingHourly}'`), 'Labour');
      assert.equal(sql(`SELECT rate_group FROM public.rate_rules WHERE id='${standingTravel}'`), 'Travel');
      assert.equal(sql(`SELECT rate_group FROM public.rate_rules WHERE id='${response}'`), 'Response');
      assert.equal(sql(`SELECT rate_group FROM public.rate_rules WHERE id='${excavator}'`), 'Equipment & hire');
      sql(`UPDATE public.rate_rules SET rate_group='Other' WHERE id='${excavator}'`);
      assert.equal(sql(`SELECT rate_group FROM public.rate_rules WHERE id='${excavator}'`), 'Other');
    });

    await t.test('versioned rule inserts and updates reject organization, client and kind mismatches', () => {
      const healthVersion = `(SELECT v.id FROM public.rate_card_versions v JOIN public.rate_cards c ON c.id=v.rate_card_id
        WHERE c.organization_id='${provider}' AND c.client_organization_id='${health}' AND v.version_number=1)`;
      const foreignVersion = `(SELECT v.id FROM public.rate_card_versions v JOIN public.rate_cards c ON c.id=v.rate_card_id
        WHERE c.organization_id='${otherProvider}' AND c.is_standard AND c.kind='charge' AND v.version_number=1)`;
      const otherClientVersion = `(SELECT v.id FROM public.rate_card_versions v JOIN public.rate_cards c ON c.id=v.rate_card_id
        WHERE c.organization_id='${provider}' AND c.client_organization_id='${otherClient}' AND v.version_number=1)`;
      const standardChargeVersion = `(SELECT v.id FROM public.rate_card_versions v JOIN public.rate_cards c ON c.id=v.rate_card_id
        WHERE c.organization_id='${provider}' AND c.is_standard AND c.kind='charge' AND v.version_number=1)`;
      const payVersion = `(SELECT v.id FROM public.rate_card_versions v JOIN public.rate_cards c ON c.id=v.rate_card_id
        WHERE c.organization_id='${provider}' AND c.is_standard AND c.kind='pay' AND v.version_number=1)`;
      for (const statement of [
        `UPDATE public.rate_rules SET rate_card_version_id=${foreignVersion} WHERE id='${healthStaticNew}'`,
        `UPDATE public.rate_rules SET rate_card_version_id=${otherClientVersion} WHERE id='${healthStaticNew}'`,
        `UPDATE public.rate_rules SET rate_card_version_id=${standardChargeVersion} WHERE id='${healthStaticNew}'`,
        `UPDATE public.rate_rules SET rate_card_version_id=${payVersion} WHERE id='${healthStaticNew}'`,
        `UPDATE public.rate_rules SET organization_id='${otherProvider}' WHERE id='${healthStaticNew}'`,
        `UPDATE public.rate_rules SET client_org_id='${otherClient}' WHERE id='${healthStaticNew}'`,
        `UPDATE public.rate_rules SET rule_kind='pay' WHERE id='${healthStaticNew}'`,
        `INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,client_org_id,rate_card_version_id)
          VALUES ('${id(210)}','${otherProvider}','billing','Bad insert','hourly',1,'${health}',${healthVersion})`,
      ]) {
        fails(`BEGIN; ${statement}; ROLLBACK;`, /rate.card.*scope/i);
      }
      fails(`BEGIN; GRANT SELECT, INSERT, UPDATE ON public.rate_rules TO authenticated;
        SET LOCAL ROLE authenticated; SET LOCAL test.is_grand_master='yes';
        UPDATE public.rate_rules SET rate_card_version_id=${payVersion} WHERE id='${healthStaticNew}';
        ROLLBACK;`, /rate.card.*scope/i);
    });

    await t.test('reparenting a populated card or version cannot invalidate its rule scopes', () => {
      const healthCard = `(SELECT id FROM public.rate_cards WHERE organization_id='${provider}'
        AND client_organization_id='${health}' AND is_client_default)`;
      const standardCharge = `(SELECT id FROM public.rate_cards WHERE organization_id='${provider}'
        AND kind='charge' AND is_standard)`;
      for (const statement of [
        `UPDATE public.rate_cards SET organization_id='${otherProvider}' WHERE id=${healthCard}`,
        `UPDATE public.rate_cards SET client_organization_id='${otherClient}',is_client_default=false WHERE id=${healthCard}`,
        `UPDATE public.rate_cards SET kind='pay',is_standard=false WHERE id=${standardCharge}`,
        `INSERT INTO public.rate_cards(id,organization_id,kind,name,client_organization_id)
          VALUES ('${id(220)}','${otherProvider}','charge','Different scope','${otherClient}');
          UPDATE public.rate_card_versions SET rate_card_id='${id(220)}'
          WHERE rate_card_id=${healthCard} AND version_number=1`,
        `INSERT INTO public.rate_cards(id,organization_id,kind,name,client_organization_id)
          VALUES ('${id(221)}','${provider}','charge','Different client','${otherClient}');
          UPDATE public.rate_card_versions SET rate_card_id='${id(221)}'
          WHERE rate_card_id=${healthCard} AND version_number=1`,
        `INSERT INTO public.rate_cards(id,organization_id,kind,name,payroll_role_code)
          VALUES ('${id(222)}','${provider}','pay','Different kind','Nurse');
          UPDATE public.rate_card_versions SET rate_card_id='${id(222)}'
          WHERE rate_card_id=${healthCard} AND version_number=1`,
        `INSERT INTO public.rate_cards(id,organization_id,kind,name,client_organization_id)
          VALUES ('${id(223)}','${provider}','charge','Empty card','${health}');
          UPDATE public.rate_cards SET client_organization_id='${otherClient}' WHERE id='${id(223)}'`,
        `INSERT INTO public.rate_cards(id,organization_id,kind,name,client_organization_id)
          VALUES ('${id(224)}','${provider}','charge','Empty source','${health}'),
            ('${id(225)}','${provider}','charge','Empty target','${otherClient}');
          INSERT INTO public.rate_card_versions(id,rate_card_id,version_number,status)
            VALUES ('${id(226)}','${id(224)}',1,'draft');
          UPDATE public.rate_card_versions SET rate_card_id='${id(225)}' WHERE id='${id(226)}'`,
        `INSERT INTO public.rate_cards(id,organization_id,kind,name,payroll_role_code)
          VALUES ('${id(227)}','${provider}','pay','Role card','Nurse');
          INSERT INTO public.rate_card_versions(id,rate_card_id,version_number,status)
            VALUES ('${id(228)}','${id(227)}',1,'draft');
          INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,client_org_id,role_code,rate_card_version_id)
            VALUES ('${id(229)}','${provider}','pay','Role pay','hourly',30,'${health}','Nurse','${id(228)}');
          UPDATE public.rate_cards SET payroll_role_code='Guard' WHERE id='${id(227)}'`,
      ]) {
        fails(`BEGIN; ${statement}; ROLLBACK;`, /rate.card.*scope/i);
      }
    });

    await t.test('scope guards validate final rows changed by other before-update triggers', () => {
      const healthCard = `(SELECT id FROM public.rate_cards WHERE organization_id='${provider}'
        AND client_organization_id='${health}' AND is_client_default)`;
      fails(`BEGIN;
        CREATE FUNCTION public.test_rewrite_rule_scope() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.client_org_id := '${otherClient}'; RETURN NEW; END $$;
        CREATE TRIGGER zz_test_rewrite_rule_scope BEFORE UPDATE OF name ON public.rate_rules
          FOR EACH ROW EXECUTE FUNCTION public.test_rewrite_rule_scope();
        UPDATE public.rate_rules SET name='A new name' WHERE id='${healthStaticNew}';
        ROLLBACK;`, /rate.card.*scope/i);
      fails(`BEGIN;
        CREATE FUNCTION public.test_rewrite_card_scope() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.client_organization_id := '${otherClient}'; NEW.is_client_default := false; RETURN NEW; END $$;
        CREATE TRIGGER zz_test_rewrite_card_scope BEFORE UPDATE OF name ON public.rate_cards
          FOR EACH ROW EXECUTE FUNCTION public.test_rewrite_card_scope();
        UPDATE public.rate_cards SET name='A new name' WHERE id=${healthCard};
        ROLLBACK;`, /rate.card.*scope/i);
      fails(`BEGIN;
        INSERT INTO public.rate_cards(id,organization_id,kind,name,client_organization_id)
          VALUES ('${id(230)}','${provider}','charge','Another client','${otherClient}');
        CREATE FUNCTION public.test_rewrite_version_scope() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN NEW.rate_card_id := '${id(230)}'; RETURN NEW; END $$;
        CREATE TRIGGER zz_test_rewrite_version_scope BEFORE UPDATE OF change_note ON public.rate_card_versions
          FOR EACH ROW EXECUTE FUNCTION public.test_rewrite_version_scope();
        UPDATE public.rate_card_versions SET change_note='A new note'
          WHERE rate_card_id=${healthCard} AND version_number=1;
        ROLLBACK;`, /rate.card.*scope/i);
    });

    await t.test('legacy unversioned writes and client-scoped pay rules remain valid', () => {
      const result = json(`BEGIN;
        GRANT SELECT, INSERT, UPDATE ON public.rate_rules TO authenticated;
        SET LOCAL ROLE authenticated; SET LOCAL test.is_grand_master='yes';
        INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,client_org_id)
          VALUES ('${id(211)}','${provider}','billing','Legacy billing','hourly',20,'${health}'),
            ('${id(212)}','${provider}','pay','Legacy pay','hourly',20,'${health}');
        INSERT INTO public.rate_rules(id,organization_id,rule_kind,name,rate_type,amount,client_org_id,rate_card_version_id)
          SELECT '${id(213)}','${provider}','pay','Client-scoped pay','hourly',20,'${health}',v.id
          FROM public.rate_card_versions v JOIN public.rate_cards c ON c.id=v.rate_card_id
          WHERE c.organization_id='${provider}' AND c.kind='pay' AND c.is_standard AND v.version_number=1;
        SELECT jsonb_build_object(
          'legacy',(SELECT count(*) FROM public.rate_rules WHERE id IN ('${id(211)}','${id(212)}')
            AND rate_card_version_id IS NULL),
          'client_pay',(SELECT count(*) FROM public.rate_rules WHERE id='${id(213)}'
            AND client_org_id='${health}' AND rate_card_version_id IS NOT NULL));
        ROLLBACK;`);
      assert.equal(result.legacy, 2);
      assert.equal(result.client_pay, 1);
    });

    await t.test('foundation scope guards leave metadata-only edits intact', () => {
      const result = json(`BEGIN;
        UPDATE public.rate_cards SET name='Renamed card'
          WHERE organization_id='${provider}' AND client_organization_id='${health}' AND is_client_default;
        UPDATE public.rate_card_versions SET change_note='Metadata edit'
          WHERE rate_card_id=(SELECT id FROM public.rate_cards
            WHERE organization_id='${provider}' AND client_organization_id='${health}' AND is_client_default)
            AND version_number=1;
        SELECT jsonb_build_object('name',c.name,'change_note',v.change_note)
          FROM public.rate_cards c JOIN public.rate_card_versions v ON v.rate_card_id=c.id
          WHERE c.organization_id='${provider}' AND c.client_organization_id='${health}'
            AND c.is_client_default AND v.version_number=1;
        ROLLBACK;`);
      assert.equal(result.name, 'Renamed card');
      assert.equal(result.change_note, 'Metadata edit');
    });

    await t.test('rerunning the backfill neither creates extra cards nor changes line identity or user edits', () => {
      const beforeReplay = json(`SELECT jsonb_build_object(
        'cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.rate_cards c),
        'versions',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.rate_card_versions v),
        'rules',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'version',r.rate_card_version_id,
          'line',r.rate_line_key,'group',r.rate_group) ORDER BY r.id) FROM public.rate_rules r))`);
      sql(migration);
      const afterReplay = json(`SELECT jsonb_build_object(
        'cards',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM public.rate_cards c),
        'versions',(SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM public.rate_card_versions v),
        'rules',(SELECT jsonb_agg(jsonb_build_object('id',r.id,'version',r.rate_card_version_id,
          'line',r.rate_line_key,'group',r.rate_group) ORDER BY r.id) FROM public.rate_rules r))`);
      assert.deepEqual(afterReplay, beforeReplay);
    });

    await t.test('one client can have multiple cards but only one active default and a scoped agreement choice', () => {
      sql(`INSERT INTO public.rate_cards(id,organization_id,kind,name,client_organization_id,is_client_default)
        VALUES ('${id(200)}','${provider}','charge','Second Health card','${health}',false)`);
      sql(`UPDATE public.service_agreements SET rate_card_id='${id(200)}' WHERE id='${agreement}'`);
      assert.equal(sql(`SELECT rate_card_id FROM public.service_agreements WHERE id='${agreement}'`), id(200));
      fails(`INSERT INTO public.rate_cards(organization_id,kind,name,client_organization_id,is_client_default)
        VALUES ('${provider}','charge','Duplicate default','${health}',true)`, /unique|duplicate/i);
      fails(`INSERT INTO public.rate_cards(organization_id,kind,name,is_standard)
        VALUES ('${provider}','charge','Duplicate Standard',true)`, /unique|duplicate/i);
      fails(`UPDATE public.service_agreements SET rate_card_id='${id(200)}' WHERE id='${foreignAgreement}'`,
        /foreign key|scope|agreement/i);
      fails(`UPDATE public.service_agreements SET rate_card_id=(SELECT id FROM public.rate_cards
        WHERE organization_id='${provider}' AND kind='pay' AND is_standard)
        WHERE id='${agreement}'`, /foreign key|scope|agreement/i);
    });

    await t.test('ordinary agreement updates cannot bypass governance by changing the selected card', () => {
      sql(`ALTER TABLE public.service_agreements ENABLE ROW LEVEL SECURITY;
        GRANT SELECT, INSERT, UPDATE ON public.service_agreements TO authenticated;
        CREATE POLICY test_existing_agreement_access ON public.service_agreements
          TO authenticated USING (true) WITH CHECK (true)`);
      fails(`SET ROLE authenticated; UPDATE public.service_agreements SET rate_card_id='${id(200)}'
        WHERE id='${agreementTwo}'`, /govern|permission|authoriz/i);
      fails(`SET ROLE authenticated; INSERT INTO public.service_agreements
        (id,provider_organization_id,client_organization_id,name,rate_card_id)
        VALUES ('${id(201)}','${provider}','${health}','Unapproved choice','${id(200)}')`,
      /govern|permission|authoriz/i);
      sql(`SET ROLE authenticated; UPDATE public.service_agreements SET name='Still editable'
        WHERE id='${agreementTwo}'`);
      assert.equal(sql(`SELECT name FROM public.service_agreements WHERE id='${agreementTwo}'`), 'Still editable',
        'The new guard leaves unrelated agreement editing intact');
    });

    await t.test('the new tables are private, branch-scoped, and not directly writable by clients', () => {
      assert.equal(sql(`SELECT has_table_privilege('anon','public.rate_cards','SELECT')`), 'f');
      assert.equal(sql(`SELECT has_table_privilege('anon','public.rate_card_versions','SELECT')`), 'f');
      assert.equal(sql(`SELECT has_table_privilege('authenticated','public.rate_cards','SELECT')`), 't');
      assert.equal(sql(`SELECT has_table_privilege('authenticated','public.rate_cards','INSERT')`), 'f');
      assert.equal(sql(`SELECT has_table_privilege('authenticated','public.rate_card_versions','UPDATE')`), 'f');
      assert.equal(sql(`SELECT has_table_privilege('authenticated','public.rate_cards','TRUNCATE')`), 'f');
      assert.equal(sql(`SELECT has_table_privilege('service_role','public.rate_cards','INSERT')`), 't');
      const visible = json(`BEGIN; SET LOCAL ROLE authenticated;
        SET LOCAL test.operating_organization='${provider}';
        SELECT jsonb_build_object(
          'own_cards',(SELECT count(*) FROM public.rate_cards WHERE organization_id='${provider}'),
          'other_cards',(SELECT count(*) FROM public.rate_cards WHERE organization_id='${otherProvider}'),
          'other_versions',(SELECT count(*) FROM public.rate_card_versions v JOIN public.rate_cards c
            ON c.id=v.rate_card_id WHERE c.organization_id='${otherProvider}')); ROLLBACK;`);
      assert.ok(visible.own_cards > 0);
      assert.equal(visible.other_cards, 0);
      assert.equal(visible.other_versions, 0);
      fails(`SET ROLE authenticated; INSERT INTO public.rate_cards(organization_id,kind,name,is_standard)
        VALUES ('${provider}','charge','Unauthorized',true)`, /permission denied/i);
    });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
