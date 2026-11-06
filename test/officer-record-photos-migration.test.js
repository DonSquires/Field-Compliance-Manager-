'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(join(__dirname, '../supabase/migrations/20261106120200_officer_record_photo_attachments.sql'), 'utf8');
const integrity = readFileSync(join(__dirname, '../supabase/migrations/20261010192005_allow_external_record_photos.sql'), 'utf8');
const trigger = integrity.slice(integrity.indexOf('CREATE OR REPLACE FUNCTION'), integrity.indexOf('$function$;') + '$function$;'.length);

test('officer photo migration is private, target-bound and does not publish or rewrite the schema snapshot', () => {
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON public\.officer_record_photos FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /AS RESTRICTIVE/);
  assert.match(migration, /'officer-record-photos','officer-record-photos',false/);
  assert.match(migration, /r\.officer_id = v_user/);
  assert.match(migration, /i\.officer_user_id = v_user/);
  assert.match(migration, /s\.organization_id = v_org AND s\.officer_user_id = v_user/);
  assert.match(migration, /'client_publish_allowed',false/);
  assert.match(migration, /'capture_time_verified',false/);
  assert.doesNotMatch(migration, /UPDATE public\.(officer_field_reports|incidents)|photo_urls|is_court_ready\s*=\s*true/i);
});

test('authenticated officer report/incident photos enforce target, shift, storage, integrity and retry receipts', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-officer-photos-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'public.ecr.aws/supabase/postgres:17.11.0.004']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true; break;
      } catch { await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Isolated synthetic PostgreSQL must become ready');
    const org = '10000000-0000-4000-8000-000000000001';
    const otherOrg = '10000000-0000-4000-8000-000000000002';
    const officer = '20000000-0000-4000-8000-000000000001';
    const peer = '20000000-0000-4000-8000-000000000002';
    const outsider = '20000000-0000-4000-8000-000000000003';
    const shift = '30000000-0000-4000-8000-000000000001';
    const badShift = '30000000-0000-4000-8000-000000000002';
    const report = '40000000-0000-4000-8000-000000000001';
    const peerReport = '40000000-0000-4000-8000-000000000002';
    const badReport = '40000000-0000-4000-8000-000000000003';
    const incident = '50000000-0000-4000-8000-000000000001';
    const job = '60000000-0000-4000-8000-000000000001';
    const hash = 'a'.repeat(64);
    const path = `org/${org}/officer-photos/field_report/${report}/${hash}`;
    const incidentPath = `org/${org}/officer-photos/incident/${incident}/${hash}`;
    const register = (kind = 'field_report', id = report, digest = hash) =>
      `select public.attach_officer_record_photo('${kind}','${id}','${digest}','synthetic.png',now())`;
    const sql = `
      DO $roles$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $roles$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS storage;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $f$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,deactivated_at timestamptz);
      CREATE TABLE public.shifts(id uuid PRIMARY KEY,organization_id uuid,officer_user_id uuid);
      CREATE TABLE public.officer_field_reports(id uuid PRIMARY KEY,organization_id uuid,officer_id uuid,shift_id uuid);
      CREATE TABLE public.dispatch_jobs(id uuid PRIMARY KEY,organization_id uuid,shift_id uuid);
      CREATE TABLE public.incidents(id uuid PRIMARY KEY,organization_id uuid,officer_user_id uuid,dispatch_job_id uuid);
      CREATE TABLE public.evidence_items(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,module_key text,evidence_kind text,
        storage_path text,captured_by_user_id uuid,captured_at timestamptz,sha256_hash text,
        is_court_ready boolean,retention_class text,metadata jsonb,locked_at timestamptz
      );
      ALTER TABLE public.evidence_items ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON public.evidence_items FROM authenticated,anon;
      GRANT SELECT ON public.evidence_items TO authenticated;
      CREATE POLICY baseline_evidence_read ON public.evidence_items FOR SELECT TO authenticated USING(true);
      CREATE TABLE public.audit_log(id uuid DEFAULT gen_random_uuid(),organization_id uuid,actor_user_id uuid,
        action text,target_table text,target_id uuid,metadata jsonb);
      CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      CREATE TABLE storage.objects(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner_id text,metadata jsonb,
        UNIQUE(bucket_id,name)
      );
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT USAGE ON SCHEMA public,storage,auth TO authenticated,anon;
      GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
      CREATE POLICY synthetic_legacy_broad_policy ON storage.objects TO authenticated USING(true) WITH CHECK(true);
      CREATE FUNCTION public.org_access_allowed(p_org uuid) RETURNS boolean LANGUAGE sql SECURITY DEFINER AS
        $f$ SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND organization_id=p_org AND deactivated_at IS NULL) $f$;
      CREATE FUNCTION pg_temp.ok(value boolean,label text) RETURNS void LANGUAGE plpgsql AS
        $f$ BEGIN IF value IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $f$;
      CREATE FUNCTION pg_temp.denied(statement text,expected text) RETURNS void LANGUAGE plpgsql AS
        $f$ BEGIN
          BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
            IF position(expected IN SQLERRM)=0 THEN RAISE; END IF; RETURN;
          END;
          RAISE EXCEPTION 'Expected denial: %',statement;
        END $f$;
      ${trigger}
      CREATE TRIGGER source_photo_integrity BEFORE INSERT OR UPDATE ON public.evidence_items
        FOR EACH ROW EXECUTE FUNCTION public.tg_seal_verified_photo_evidence();
      ${migration}
      INSERT INTO public.organizations VALUES('${org}'),('${otherOrg}');
      INSERT INTO public.user_profiles VALUES('${officer}','${org}',null),('${peer}','${org}',null),('${outsider}','${otherOrg}',null);
      INSERT INTO public.shifts VALUES('${shift}','${org}','${officer}'),('${badShift}','${org}','${peer}');
      INSERT INTO public.officer_field_reports VALUES
        ('${report}','${org}','${officer}','${shift}'),('${peerReport}','${org}','${peer}',null),
        ('${badReport}','${org}','${officer}','${badShift}');
      INSERT INTO public.dispatch_jobs VALUES('${job}','${org}','${shift}');
      INSERT INTO public.incidents VALUES('${incident}','${org}','${officer}','${job}');
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub','${officer}',false);
      SELECT pg_temp.ok(public.officer_photo_path_allowed('${path}'),'own report upload path');
      SELECT pg_temp.ok(NOT public.officer_photo_path_allowed(replace('${path}','${org}','${otherOrg}')),'wrong org path denied');
      SELECT pg_temp.ok(NOT public.officer_photo_path_allowed('${path}/../x'),'path traversal denied');
      SELECT pg_temp.ok(NOT public.officer_photo_path_allowed(replace('${path}','${report}','${peerReport}')),'same-org peer denied');
      SELECT pg_temp.denied($s$${register('field_report', badReport)}$s$,'shift context');
      SELECT pg_temp.denied($s$${register('dispatch_job', job)}$s$,'target is unavailable');
      SELECT pg_temp.denied($s$${register()}$s$,'upload was not confirmed');
      INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES(
        'officer-record-photos','${path}','${officer}','{"size":24,"mimetype":"image/png"}');
      SELECT pg_temp.denied($s$INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES(
        'officer-record-photos',replace('${path}','${hash}','${'c'.repeat(64)}'),'${peer}','{}')$s$,'row-level security');
      SELECT pg_temp.denied($s$INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES(
        'officer-record-photos',replace('${path}','${report}','${peerReport}'),'${officer}','{}')$s$,'row-level security');
      SELECT pg_temp.ok((public.attach_officer_record_photo('field_report','${report}','${hash}','synthetic.png',now())->>'shift_id')='${shift}','exact shift receipt');
      SELECT pg_temp.ok((public.attach_officer_record_photo('field_report','${report}','${hash}','synthetic.png',now())->>'storage_path')='${path}','retry returns same path');
      SELECT pg_temp.ok((SELECT count(*)=1 FROM public.officer_record_photos),'one link after retry');
      SELECT pg_temp.ok((SELECT count(*)=1 FROM public.evidence_items),'one original evidence item after retry');
      SELECT pg_temp.ok((SELECT NOT is_court_ready AND locked_at IS NULL AND sha256_hash='${hash}'
        AND metadata->>'raw_sha256'='${hash}' AND metadata->>'provenance'='external'
        AND metadata->>'privacy_review_status'='pending' AND metadata->>'client_publish_allowed'='false'
        AND metadata->>'capture_time_verified'='false' FROM public.evidence_items),'honest source provenance, not sealed/published');
      WITH changed AS(UPDATE storage.objects SET metadata='{}' WHERE name='${path}' RETURNING id)
        SELECT pg_temp.ok((SELECT count(*)=0 FROM changed),'original cannot be overwritten by broad legacy policy');
      WITH removed AS(DELETE FROM storage.objects WHERE name='${path}' RETURNING id)
        SELECT pg_temp.ok((SELECT count(*)=0 FROM removed),'original cannot be deleted by broad legacy policy');
      INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES(
        'officer-record-photos','${incidentPath}','${officer}','{"size":24,"mimetype":"image/png"}');
      SELECT pg_temp.ok((public.attach_officer_record_photo('incident','${incident}','${hash}','synthetic.png',now())->>'record_kind')='incident','incident receipt');
      SELECT pg_temp.ok((SELECT count(*)=2 FROM public.officer_record_photos),'same bytes linked separately to exact incident, not reused globally');
      SELECT pg_temp.denied($s$INSERT INTO public.officer_record_photos(organization_id) VALUES('${org}')$s$,'permission denied');
      SELECT pg_temp.denied($s$INSERT INTO public.evidence_items(organization_id) VALUES('${org}')$s$,'permission denied');
      SELECT pg_temp.denied($s$${register('field_report', report, 'invalid')}$s$,'provenance is invalid');
      SELECT pg_temp.denied($s$select public.attach_officer_record_photo('field_report','${report}','${hash}','synthetic.png',now()+interval '1 day')$s$,'provenance is invalid');
      RESET ROLE;
      INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES
        ('officer-record-photos',replace('${path}','${hash}','${'b'.repeat(64)}'),'${officer}','{"size":0,"mimetype":"image/png"}'),
        ('officer-record-photos',replace('${path}','${hash}','${'c'.repeat(64)}'),'${officer}','{"size":24,"mimetype":"image/svg+xml"}'),
        ('officer-record-photos',replace('${path}','${hash}','${'d'.repeat(64)}'),'${peer}','{"size":24,"mimetype":"image/png"}');
      SET ROLE authenticated;
      SELECT pg_temp.denied($s$${register('field_report', report, 'b'.repeat(64))}$s$,'upload was not confirmed');
      SELECT pg_temp.denied($s$${register('field_report', report, 'c'.repeat(64))}$s$,'upload was not confirmed');
      SELECT pg_temp.denied($s$${register('field_report', report, 'd'.repeat(64))}$s$,'upload was not confirmed');
      SELECT set_config('request.jwt.claim.sub','${peer}',false);
      SELECT pg_temp.denied($s$${register()}$s$,'target is unavailable');
      SELECT pg_temp.ok((SELECT count(*)=0 FROM storage.objects),'same-org peer cannot sign/read source photos despite broad policy');
      SELECT pg_temp.ok((SELECT count(*)=0 FROM public.officer_record_photos),'same-org peer cannot read attachment links');
      SELECT pg_temp.ok((SELECT count(*)=0 FROM public.evidence_items),'same-org peer cannot read raw photo provenance');
      SELECT pg_temp.ok((SELECT shift_id IS NULL FROM public.officer_photo_target_context('field_report','${peerReport}')),'own report can explicitly have no shift');
      SELECT set_config('request.jwt.claim.sub','${outsider}',false);
      SELECT pg_temp.denied($s$${register('incident', incident)}$s$,'target is unavailable');
      SELECT pg_temp.ok((SELECT count(*)=0 FROM storage.objects),'other tenant cannot read source photos');
      RESET ROLE;
      UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${officer}';
      SET ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub','${officer}',false);
      SELECT pg_temp.denied($s$${register()}$s$,'target is unavailable');
      SELECT pg_temp.ok((SELECT count(*)=0 FROM storage.objects),'deactivated officer loses source access');
      SELECT set_config('request.jwt.claim.sub','',false);
      SELECT pg_temp.denied($s$${register()}$s$,'target is unavailable');
      RESET ROLE;
      SET ROLE anon;
      SELECT pg_temp.denied($s$${register()}$s$,'permission denied');
      RESET ROLE;
      SELECT pg_temp.ok((SELECT count(*)=2 FROM public.audit_log),'one audit receipt per distinct target');
      SELECT pg_temp.ok((SELECT NOT public FROM storage.buckets WHERE id='officer-record-photos'),'private bucket');
      SELECT 'officer photo database behavior verified' AS result;
    `;
    let output;
    try { output = docker(['exec', '--interactive', name, 'psql', '-h', '127.0.0.1', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'], sql); }
    catch (error) { throw new Error(`${error.message}\n${error.stderr ?? ''}`); }
    assert.match(output, /officer photo database behavior verified/);
  } finally { if (created) docker(['rm', '--force', name]); }
});
