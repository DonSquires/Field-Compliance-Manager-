'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114090000_cron_run_history_retention.sql'), 'utf8');

test('cron run-history purge is owner-only and scheduled daily', () => {
  assert.match(migration, /REVOKE ALL ON FUNCTION private\.purge_cron_run_history\(\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION private\.purge_cron_run_history\(\)\s+TO postgres;/);
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION private\.purge_cron_run_history\(\)\s+TO (?:anon|authenticated|PUBLIC|service_role)/);
  assert.match(migration, /'cron-run-history-retention-daily'/);
});

test('the retention period is data, not code', () => {
  assert.match(migration, /'scheduler_run_history'/);
  assert.match(migration, /FROM private\.platform_tenancy/);
  assert.doesNotMatch(migration, /interval '\d+ days?'/i, 'no hard-coded retention interval');
});

test('cron run history is pruned by the configured retention and never mid-run', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, async () => {
  const name = `fcm-cron-retention-${randomUUID()}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = (query) => execFileSync('docker', ['exec', '-i', name, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
      input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const provider = '00000000-0000-4000-8000-0000000000aa';
    // Live shapes of what the migration touches; pg_cron is stubbed (not in the test image).
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA private;
      CREATE TABLE private.platform_tenancy (singleton boolean PRIMARY KEY DEFAULT true, service_provider_organization_id uuid);
      INSERT INTO private.platform_tenancy VALUES (true, '${provider}');
      CREATE TABLE public.retention_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, module_key text, category text NOT NULL,
        retention_days integer, legal_basis text, is_active boolean NOT NULL DEFAULT true,
        effective_from date NOT NULL DEFAULT CURRENT_DATE, is_permanent boolean NOT NULL DEFAULT false,
        CONSTRAINT retention_policies_category_check CHECK (category IN ('infringement','non_infringement','hold_default','interaction_permanent','observation_30_day','canonical_indefinite','legal_hold','website_analytics')));
      INSERT INTO public.retention_policies (organization_id, module_key, category, retention_days) VALUES ('${provider}', 'website', 'website_analytics', 365);
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text);
      CREATE TABLE cron.job_run_details (runid bigserial PRIMARY KEY, jobid bigint, status text, start_time timestamptz, end_time timestamptz);
      CREATE FUNCTION cron.unschedule(job_id bigint) RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobid = job_id RETURNING true $$;
      CREATE FUNCTION cron.schedule_in_database(job_name text, schedule text, command text, database text, username text, active boolean)
        RETURNS bigint LANGUAGE sql AS $$ INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid $$;
    `);
    sql(migration);
    sql(migration);

    assert.equal(sql(`SELECT count(*) FROM cron.job WHERE jobname = 'cron-run-history-retention-daily'`), '1', 'idempotent schedule');
    assert.equal(sql(`SELECT count(*) || ':' || min(retention_days) FROM public.retention_policies WHERE category = 'scheduler_run_history' AND organization_id = '${provider}'`), '1:14', 'one seeded 14-day policy');

    sql(`INSERT INTO cron.job_run_details (jobid, status, start_time, end_time) VALUES
      (1, 'succeeded', now() - interval '20 days', now() - interval '20 days'),
      (1, 'failed',    now() - interval '15 days', now() - interval '15 days'),
      (1, 'succeeded', now() - interval '2 days',  now() - interval '2 days'),
      (1, 'running',   now() - interval '20 days', NULL);`);
    assert.equal(sql('SELECT private.purge_cron_run_history()'), '2');
    assert.equal(sql(`SELECT string_agg(status, ',' ORDER BY runid) FROM cron.job_run_details`), 'succeeded,running');

    sql(`UPDATE public.retention_policies SET retention_days = 1 WHERE category = 'scheduler_run_history'`);
    assert.equal(sql('SELECT private.purge_cron_run_history()'), '1', 'period follows the policy row');

    sql(`UPDATE public.retention_policies SET is_active = false WHERE category = 'scheduler_run_history'`);
    assert.throws(() => sql('SELECT private.purge_cron_run_history()'), (e) => /retention configuration is unavailable/.test(String(e.stderr)));

    assert.equal(sql(`SELECT has_function_privilege('service_role', 'private.purge_cron_run_history()', 'execute')`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('authenticated', 'private.purge_cron_run_history()', 'execute')`), 'f');
  } finally {
    if (created) { try { docker(['rm', '--force', name]); } catch { /* best effort */ } }
  }
});
