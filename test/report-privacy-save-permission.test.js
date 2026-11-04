const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase', 'migrations', '20261106100000_grant_report_privacy_service_role.sql'), 'utf8');
const catalogFunction = (name) => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, `Missing catalog function ${name}`);
  const end = schema.indexOf('$function$;', start);
  assert.ok(end >= 0, `Missing function body for ${name}`);
  return schema.slice(start, end + '$function$;'.length);
};

test('privacy-save migration grants only the report helper to the service role', () => {
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.is_report_provider_custodian_for_org\(uuid\) TO service_role;/i);
  assert.doesNotMatch(migration, /TO\s+(?:PUBLIC|anon|authenticated)\b/i);
});

test('service-role privacy saves work without weakening report guards', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-report-privacy-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const provider = '10000000-0000-4000-8000-000000000001';
  const other = '10000000-0000-4000-8000-000000000002';
  const admin = '10000000-0000-4000-8000-000000000003';
  const outsider = '10000000-0000-4000-8000-000000000004';
  const draft = '10000000-0000-4000-8000-000000000005';
  const sent = '10000000-0000-4000-8000-000000000006';
  const delivering = '10000000-0000-4000-8000-000000000007';
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');

    const sql = `
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE ROLE service_role NOLOGIN BYPASSRLS;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
        SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
          (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
      $f$;
      CREATE TABLE public.user_profiles (
        id uuid PRIMARY KEY, organization_id uuid, employer_organization_id uuid,
        role text, deactivated_at timestamptz
      );
      CREATE TABLE public.service_agreements (id uuid PRIMARY KEY, client_organization_id uuid);
      CREATE TABLE public.monthly_report_packs (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, service_agreement_id uuid,
        status text NOT NULL, report_kind text NOT NULL DEFAULT 'monthly',
        published_at timestamptz, editorial jsonb NOT NULL DEFAULT '{}', data jsonb,
        report_scope jsonb NOT NULL DEFAULT '{}', activity_lines jsonb NOT NULL DEFAULT '{}',
        pdf_path text, pdf_mime_type text, pdf_sha256 text, pdf_renderer_version text,
        pdf_source_updated_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
        delivery_attempt_id uuid, delivery_started_at timestamptz, delivery_recipient text
      );
      CREATE FUNCTION public.get_descendant_organizations(uuid) RETURNS uuid[]
        LANGUAGE sql STABLE AS $f$ SELECT ARRAY[$1] $f$;
      ${catalogFunction('report_provider_custodian_for_actor')}
      ${catalogFunction('is_report_provider_custodian_for_org')}
      ${catalogFunction('clear_report_pack_delivery_claim')}
      REVOKE ALL ON FUNCTION public.report_provider_custodian_for_actor(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
      REVOKE ALL ON FUNCTION public.is_report_provider_custodian_for_org(uuid) FROM PUBLIC, anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION public.is_report_provider_custodian_for_org(uuid) TO authenticated;
      CREATE TRIGGER clear_report_pack_delivery_claim BEFORE UPDATE ON public.monthly_report_packs
        FOR EACH ROW EXECUTE FUNCTION public.clear_report_pack_delivery_claim();
      ALTER TABLE public.monthly_report_packs ENABLE ROW LEVEL SECURITY;
      CREATE POLICY monthly_report_packs_select ON public.monthly_report_packs FOR SELECT TO authenticated
        USING (public.is_report_provider_custodian_for_org(organization_id));
      GRANT SELECT ON public.monthly_report_packs TO authenticated;
      GRANT SELECT, UPDATE ON public.monthly_report_packs TO service_role;
      CREATE FUNCTION public.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $f$
        BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %', label; END IF; END $f$;
      CREATE FUNCTION public.expect_error(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $f$
        DECLARE failed boolean := false;
        BEGIN
          BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
            IF position(expected IN SQLERRM) = 0 THEN RAISE EXCEPTION 'Unexpected error: %; expected %', SQLERRM, expected; END IF;
            failed := true;
          END;
          IF NOT failed THEN RAISE EXCEPTION 'Expected error: %', expected; END IF;
        END $f$;
      INSERT INTO public.user_profiles VALUES
        ('${admin}', '${provider}', '${provider}', 'admin', NULL),
        ('${outsider}', '${other}', '${other}', 'admin', NULL);
      INSERT INTO public.monthly_report_packs(id, organization_id, status, delivery_attempt_id, delivery_started_at) VALUES
        ('${draft}', '${provider}', 'draft', NULL, NULL),
        ('${sent}', '${provider}', 'sent', NULL, NULL),
        ('${delivering}', '${provider}', 'generated', '${draft}', clock_timestamp());

      SET ROLE service_role;
      SELECT public.expect_error(
        $q$UPDATE public.monthly_report_packs SET activity_lines = '{"checked":true}' WHERE id = '${draft}'$q$,
        'permission denied for function is_report_provider_custodian_for_org');
      RESET ROLE;
      ${migration}
      SELECT public.assert_ok(has_function_privilege('service_role', 'public.is_report_provider_custodian_for_org(uuid)', 'EXECUTE'), 'service role can evaluate the guard');
      SELECT public.assert_ok(has_function_privilege('authenticated', 'public.is_report_provider_custodian_for_org(uuid)', 'EXECUTE'), 'authenticated access is unchanged');
      SELECT public.assert_ok(NOT has_function_privilege('anon', 'public.is_report_provider_custodian_for_org(uuid)', 'EXECUTE'), 'anonymous access stays revoked');
      SELECT public.assert_ok(NOT has_function_privilege('service_role', 'public.report_provider_custodian_for_actor(uuid,uuid)', 'EXECUTE'), 'actor helper stays private');
      SELECT public.assert_ok(NOT has_table_privilege('authenticated', 'public.monthly_report_packs', 'UPDATE'), 'browser writes stay revoked');

      SET ROLE service_role;
      UPDATE public.monthly_report_packs SET activity_lines = '{"checked":true}' WHERE id = '${draft}';
      SELECT public.assert_ok((SELECT activity_lines->>'checked' = 'true' FROM public.monthly_report_packs WHERE id = '${draft}'), 'privacy result is saved');
      SELECT public.expect_error(
        $q$UPDATE public.monthly_report_packs SET activity_lines = '{"checked":true}' WHERE id = '${sent}'$q$,
        'Sent report packs are immutable');
      SELECT public.expect_error(
        $q$UPDATE public.monthly_report_packs SET editorial = '{"title":"changed"}' WHERE id = '${delivering}'$q$,
        'Report email delivery is in progress');
      SELECT set_config('request.jwt.claim.sub', '${admin}', false);
      UPDATE public.monthly_report_packs SET activity_lines = '{"checked":"admin"}' WHERE id = '${draft}';
      SELECT set_config('request.jwt.claim.sub', '${outsider}', false);
      SELECT public.expect_error(
        $q$UPDATE public.monthly_report_packs SET activity_lines = '{"checked":"outsider"}' WHERE id = '${draft}'$q$,
        'Provider custodian access required');
      RESET ROLE;
      SET ROLE authenticated;
      SELECT public.assert_ok((SELECT count(*) = 0 FROM public.monthly_report_packs WHERE id = '${draft}'), 'other organisation cannot read the pack');
      SELECT set_config('request.jwt.claim.sub', '${admin}', false);
      SELECT public.assert_ok((SELECT count(*) = 1 FROM public.monthly_report_packs WHERE id = '${draft}'), 'provider administrator can still read the pack');
    `;
    docker(['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], sql);
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
