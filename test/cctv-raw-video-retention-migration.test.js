'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261114100000_cctv_raw_video_retention.sql'), 'utf8');
const SIGNATURES = [
  'custodian_raw_video_purge_candidates(integer)',
  'custodian_record_raw_video_purge(uuid)',
];

test('raw-video retention RPCs are service-only', () => {
  for (const signature of SIGNATURES) {
    const escaped = signature.replace(/[().]/g, '\\$&');
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${escaped} FROM PUBLIC, anon, authenticated;`));
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${escaped} TO service_role;`));
  }
  assert.doesNotMatch(migration, /GRANT EXECUTE ON FUNCTION [^;]+ TO (?:anon|authenticated|PUBLIC)/);
});

test('the retention period is data, not code', () => {
  assert.match(migration, /'cctv_raw_video'/);
  assert.match(migration, /'scheduler_run_history'/, 'keeps the category added by the previous migration');
  assert.doesNotMatch(migration, /interval '\d+ days?'/i);
});

test('raw CCTV video expires by import age, never under hold, seal or court-ready, and is audited before deletion', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, async () => {
  const name = `fcm-raw-video-${randomUUID()}`;
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
    const service = (query) => sql(`SET test.role = 'service_role'; ${query}`).split('\n').at(-1);

    const provider = '00000000-0000-4000-8000-0000000000aa';
    const org = '00000000-0000-4000-8000-000000000001';
    const strictOrg = '00000000-0000-4000-8000-000000000002';
    const ev = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const imp = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT nullif(current_setting('test.role', true), '') $$;
      CREATE SCHEMA private;
      CREATE TABLE private.platform_tenancy (singleton boolean PRIMARY KEY DEFAULT true, service_provider_organization_id uuid);
      INSERT INTO private.platform_tenancy VALUES (true, '${provider}');
      CREATE TABLE public.retention_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, module_key text, category text NOT NULL,
        retention_days integer, legal_basis text, is_active boolean NOT NULL DEFAULT true,
        effective_from date NOT NULL DEFAULT CURRENT_DATE, is_permanent boolean NOT NULL DEFAULT false,
        CONSTRAINT retention_policies_category_check CHECK (category IN ('infringement','non_infringement','hold_default','interaction_permanent','observation_30_day','canonical_indefinite','legal_hold','website_analytics','scheduler_run_history')));
      CREATE TABLE public.cctv_imports (id uuid PRIMARY KEY, organization_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.evidence_items (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, module_key text NOT NULL, evidence_kind text NOT NULL,
        storage_path text, metadata jsonb NOT NULL DEFAULT '{}', locked_at timestamptz, is_court_ready boolean NOT NULL DEFAULT false,
        retention_until timestamptz, retention_hold boolean NOT NULL DEFAULT false, cctv_import_id uuid);
      CREATE TABLE public.custodian_legal_holds (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        hold_key text NOT NULL, scope jsonb NOT NULL DEFAULT '{}', status text NOT NULL DEFAULT 'active');
      CREATE TABLE public.custodian_actions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
        actor_user_id uuid, action text NOT NULL, target_table text NOT NULL, target_id uuid, reason text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now());
      CREATE SCHEMA storage;
      CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    `);
    sql(migration);
    sql(migration);
    assert.equal(sql(`SELECT count(*) || ':' || min(retention_days) FROM public.retention_policies WHERE category = 'cctv_raw_video' AND organization_id IS NULL`), '1:90', 'one seeded 90-day platform default');

    // Org-specific policy overrides the platform default.
    sql(`INSERT INTO public.retention_policies (organization_id, module_key, category, retention_days) VALUES ('${strictOrg}', 'cctv_review', 'cctv_raw_video', 30);`);
    sql(`INSERT INTO public.cctv_imports VALUES
      ('${imp(1)}', '${org}', now() - interval '100 days'),
      ('${imp(2)}', '${org}', now() - interval '10 days'),
      ('${imp(3)}', '${strictOrg}', now() - interval '40 days');`);
    const video = (n, importN, organisation, extra = '') => `('${ev(n)}', '${organisation}', 'cctv_review', 'video', 'org/x/cctv/${n}.dav',
      jsonb_build_object('playback_storage_path', 'org/x/cctv/${n}.playback.mp4', 'camera_key', 'gate')${extra}, '${imp(importN)}')`;
    sql(`INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, metadata, cctv_import_id) VALUES
      ${video(1, 1, org)}, ${video(2, 2, org)}, ${video(3, 3, strictOrg)},
      ${video(4, 1, org)}, ${video(5, 1, org)}, ${video(6, 1, org)}, ${video(7, 1, org)}, ${video(8, 1, org, " || '{\"case\":\"C-9\"}'::jsonb")};
      UPDATE public.evidence_items SET locked_at = now() WHERE id = '${ev(4)}';
      UPDATE public.evidence_items SET is_court_ready = true WHERE id = '${ev(5)}';
      UPDATE public.evidence_items SET retention_hold = true WHERE id = '${ev(6)}';
      UPDATE public.evidence_items SET retention_until = now() + interval '1 day' WHERE id = '${ev(7)}';
      INSERT INTO public.custodian_legal_holds (organization_id, hold_key, scope) VALUES ('${org}', 'case-c9', '{"case":"C-9"}');
      INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id)
        VALUES ('${ev(9)}', '${org}', 'cctv_review', 'photo', 'org/x/cctv/9.png', '${imp(1)}');`);
    sql(`INSERT INTO storage.objects (bucket_id, name)
      SELECT 'bob-uploads', p FROM public.evidence_items e, LATERAL (VALUES (e.storage_path), (e.metadata->>'playback_storage_path')) v(p) WHERE p IS NOT NULL;`);

    assert.throws(() => sql('SELECT count(*) FROM public.custodian_raw_video_purge_candidates(100)'), (e) => /Service identity required/.test(String(e.stderr)));
    const candidates = () => service(`SELECT coalesce(string_agg(evidence_id::text || '=' || array_to_string(storage_paths, '|'), ',' ORDER BY evidence_id), '') FROM public.custodian_raw_video_purge_candidates(100)`);
    assert.equal(candidates(), `${ev(1)}=org/x/cctv/1.dav|org/x/cctv/1.playback.mp4,${ev(3)}=org/x/cctv/3.dav|org/x/cctv/3.playback.mp4`,
      'only expired, unprotected raw video; the org override applies; photos, seals, court-ready, holds and future retention are excluded');

    assert.equal(service(`SELECT (public.custodian_record_raw_video_purge('${ev(1)}'))->>'storage_paths'`), '["org/x/cctv/1.dav", "org/x/cctv/1.playback.mp4"]');
    assert.equal(sql(`SELECT (metadata ? 'raw_video_purged_at')::text || ':' || (metadata->>'camera_key') FROM public.evidence_items WHERE id = '${ev(1)}'`), 'true:gate', 'evidence row is kept and marked');
    assert.equal(sql(`SELECT count(*) || ':' || min(action) || ':' || min(target_table) FROM public.custodian_actions WHERE target_id = '${ev(1)}'`), '1:raw_video_retention_purged:evidence_items');

    // Still a candidate until the storage delete lands; recording again does not duplicate the audit row.
    assert.match(candidates(), new RegExp(ev(1)));
    service(`SELECT public.custodian_record_raw_video_purge('${ev(1)}')`);
    assert.equal(sql(`SELECT count(*) FROM public.custodian_actions WHERE target_id = '${ev(1)}'`), '1');
    sql(`DELETE FROM storage.objects WHERE name LIKE 'org/x/cctv/1.%'`);
    assert.doesNotMatch(candidates(), new RegExp(ev(1)));

    assert.throws(() => service(`SELECT public.custodian_record_raw_video_purge('${ev(8)}')`), (e) => /not eligible/.test(String(e.stderr)), 'legal hold rechecked at record time');
    assert.throws(() => service(`SELECT public.custodian_record_raw_video_purge('${ev(2)}')`), (e) => /not eligible/.test(String(e.stderr)));
  } finally {
    if (created) { try { docker(['rm', '--force', name]); } catch { /* best effort */ } }
  }
});
