const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationPath = path.join(__dirname, '../supabase/migrations/20261104090100_website_page_view_analytics.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const edgeFunction = fs.readFileSync(
  path.join(__dirname, '../supabase/functions/website-page-view-analytics/index.ts'),
  'utf8',
);

test('website analytics migration stays aggregate-only, private by default and policy-driven', () => {
  assert.match(migration, /CREATE TABLE public\.website_page_views_daily/);
  assert.match(migration, /ALTER TABLE public\.website_page_views_daily ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.website_page_views_daily FROM PUBLIC, anon, authenticated, service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.record_website_page_view\(text, text, text, text\)\s+TO service_role/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.get_website_page_view_summary\(date, date\)\s+TO authenticated/);
  assert.match(migration, /INSERT INTO private\.website_analytics_settings \(singleton, enabled, approved_notice_version\)\s+VALUES \(true, false, NULL\)/);
  assert.match(migration, /FROM public\.retention_policies/);
  assert.match(migration, /'website_analytics'/);
  assert.doesNotMatch(migration, /retention_months|visitor_id|user_agent|ip_address/i);
  assert.match(migration, /HAVING sum\(v\.page_views\) >= 5/);
  assert.match(edgeFunction, /x-website-analytics-secret/);
  assert.match(edgeFunction, /record_website_page_view/);
  assert.doesNotMatch(edgeFunction, /x-forwarded-for|user-agent|visitor_id/i);
});

test('website analytics recording, access control, aggregation and retention work in PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 60000,
}, async () => {
  const container = `fcm-website-analytics-${randomUUID()}`;
  const docker = (args, options = {}) => execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
  const runSql = sql => docker(['exec', '-i', container, 'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], { input: sql });
  let created = false;

  try {
    docker(['run', '--detach', '--name', container, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL ready');

    runSql(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
      $$;
      CREATE TABLE public.organizations (id uuid PRIMARY KEY);
      INSERT INTO public.organizations VALUES ('00000000-0000-4000-8000-000000000001');
      CREATE SCHEMA private;
      CREATE TABLE private.platform_tenancy (
        singleton boolean PRIMARY KEY,
        service_provider_organization_id uuid
      );
      INSERT INTO private.platform_tenancy VALUES (true, '00000000-0000-4000-8000-000000000001');
      CREATE TABLE public.retention_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid,
        module_key text,
        category text NOT NULL,
        retention_days integer,
        legal_basis text,
        is_active boolean NOT NULL DEFAULT true,
        effective_from date NOT NULL DEFAULT CURRENT_DATE,
        created_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        is_permanent boolean NOT NULL DEFAULT false,
        CONSTRAINT retention_policies_category_check CHECK (category IN (
          'infringement', 'non_infringement', 'hold_default', 'interaction_permanent',
          'observation_30_day', 'canonical_indefinite', 'legal_hold'
        )),
        CONSTRAINT retention_policies_retention_days_check CHECK (retention_days IS NULL OR retention_days >= 0)
      );
      CREATE UNIQUE INDEX uniq_retention_policy_full
        ON public.retention_policies (organization_id, module_key, category)
        WHERE organization_id IS NOT NULL AND module_key IS NOT NULL AND is_active;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT current_setting('request.jwt.claim.is_admin', true) = 'true'
      $$;
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobid bigint GENERATED ALWAYS AS IDENTITY, jobname text);
      CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
      CREATE FUNCTION cron.schedule_in_database(text, text, text, text, text, boolean)
        RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
    `);
    runSql(migration);

    const disabled = `SET ROLE service_role;
      SELECT public.record_website_page_view('/', 'NZ', 'NELSON', 'website-analytics-v1');`;
    assert.throws(() => runSql(disabled), /website_analytics_not_enabled/);
    assert.equal(runSql('SELECT count(*) FROM public.website_page_views_daily;').trim(), '0');

    runSql(`
      UPDATE private.website_analytics_settings
         SET enabled = true, approved_notice_version = 'website-analytics-v1'
       WHERE singleton;
      SET ROLE service_role;
      SELECT public.record_website_page_view('/', 'NZ', 'NELSON', 'website-analytics-v1');
      SELECT public.record_website_page_view('/', 'NZ', 'NELSON', 'website-analytics-v1');
      SELECT public.record_website_page_view('/', 'NZ', 'NELSON', 'website-analytics-v1');
      SELECT public.record_website_page_view('/', 'NZ', 'NELSON', 'website-analytics-v1');
      SELECT public.record_website_page_view('/', 'NZ', 'NELSON', 'website-analytics-v1');
      SELECT public.record_website_page_view('/contact', 'US', 'CA', 'website-analytics-v1');
      RESET ROLE;
      INSERT INTO public.website_page_views_daily
        (provider_organization_id, viewed_on, page_path, country_code, region_code, page_views)
      VALUES
        ('00000000-0000-4000-8000-000000000001', CURRENT_DATE - 366, '/', 'ZZ', 'ZZ', 1),
        ('00000000-0000-4000-8000-000000000001', CURRENT_DATE - 365, '/about', 'ZZ', 'ZZ', 1),
        ('00000000-0000-4000-8000-000000000001', CURRENT_DATE - 364, '/contact', 'ZZ', 'ZZ', 1);
    `);

    const summary = JSON.parse(runSql(`
      SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000010';
      SET request.jwt.claim.is_admin = 'true';
      SET ROLE authenticated;
      SELECT public.get_website_page_view_summary(CURRENT_DATE, CURRENT_DATE);
    `).trim().split('\n').pop());
    assert.equal(summary.total_page_views, 6);
    assert.equal(summary.pages.length, 2);
    assert.deepEqual(summary.regions, [{ country_code: 'NZ', region_code: 'NELSON', page_views: 5 }]);

    assert.throws(() => runSql(`
      SET request.jwt.claim.sub = '00000000-0000-4000-8000-000000000010';
      SET request.jwt.claim.is_admin = 'false';
      SET ROLE authenticated;
      SELECT public.get_website_page_view_summary(CURRENT_DATE, CURRENT_DATE);
    `), /website_analytics_access_denied/);

    assert.throws(
      () => runSql('SET ROLE anon; SELECT * FROM public.website_page_views_daily;'),
      /permission denied/,
    );
    assert.throws(
      () => runSql('SET ROLE authenticated; SELECT * FROM public.website_page_views_daily;'),
      /permission denied/,
    );
    assert.throws(
      () => runSql('SET ROLE authenticated; SELECT public.record_website_page_view(\'/\', \'NZ\', \'NELSON\', \'website-analytics-v1\');'),
      /permission denied/,
    );
    assert.throws(
      () => runSql('SET ROLE service_role; SELECT private.purge_website_page_views_daily();'),
      /permission denied/,
    );

    runSql('SELECT private.purge_website_page_views_daily();');
    const retainedDates = runSql(`
      SELECT string_agg(viewed_on::text, ',' ORDER BY viewed_on)
        FROM public.website_page_views_daily
       WHERE viewed_on < CURRENT_DATE;
    `).trim();
    assert.equal(retainedDates, new Date(Date.now() - 364 * 86400000).toISOString().slice(0, 10));
  } finally {
    if (created) {
      try { docker(['rm', '--force', container]); } catch { /* The disposable container may already be stopped. */ }
    }
  }
});
