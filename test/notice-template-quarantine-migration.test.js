const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20261027032744_quarantine_notice_template_imports.sql'), 'utf8');

test('template quarantine retains source rows and does not grant another write API', () => {
  assert.doesNotMatch(migration, /\bDELETE\s+FROM|\bGRANT\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i);
  assert.match(migration, /source_sha256 IS DISTINCT FROM v_source.source_sha256/);
  assert.match(migration, /'notice_import_quarantined'/);
});

test('template quarantine executes, replays safely, preserves other notices and refuses changed or reused identities', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-notice-quarantine-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = `
      CREATE TABLE public.canonical_people(id uuid PRIMARY KEY,display_name text,status text,review_state text,updated_at timestamptz);
      CREATE TABLE public.person_records(id uuid PRIMARY KEY,organization_id uuid,display_name text,review_state text,metadata jsonb);
      CREATE TABLE public.canonical_person_links(canonical_person_id uuid REFERENCES public.canonical_people(id),
        source_id uuid,source_table text,organization_id uuid);
      CREATE TABLE public.notices(id uuid PRIMARY KEY,organization_id uuid,person_id uuid REFERENCES public.canonical_people(id),
        import_key text,source_sha256 text,status text,notice_type text,metadata jsonb);
      CREATE TABLE public.entity_links(from_type text,from_id uuid,to_type text,to_id uuid);
      CREATE TABLE public.notifications(organization_id uuid,category text,severity text,title text,body text,link_payload jsonb);
      CREATE TABLE public.audit_log(organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
      CREATE TABLE public.other_person_usage(person_record_id uuid REFERENCES public.person_records(id));
      CREATE TABLE public.other_canonical_usage(person_id uuid REFERENCES public.canonical_people(id));
      CREATE FUNCTION pg_temp.apply_correction() RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN EXECUTE $sql$${migration}$sql$; END $fn$;
      CREATE FUNCTION pg_temp.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION pg_temp.refuses(expected text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN PERFORM pg_temp.apply_correction();
        EXCEPTION WHEN OTHERS THEN
          IF position(expected IN SQLERRM)=0 THEN RAISE; END IF;
          RETURN;
        END;
        RAISE EXCEPTION 'Expected refusal: %',expected;
      END $fn$;
      SELECT pg_temp.apply_correction();
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.audit_log),'empty database is a no-op');
      INSERT INTO public.canonical_people VALUES
        ('11111111-1111-4111-8111-111111111111','Name And Address','active','verified',now()),
        ('22222222-2222-4222-8222-222222222222','Tanuname And Address','active','verified',now()),
        ('33333333-3333-4333-8333-333333333333','Sam Example','active','verified',now());
      INSERT INTO public.person_records
      SELECT id,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13',display_name,'verified',
        jsonb_build_object('created_from','person_notice','notice_import_key',CASE WHEN display_name='Name And Address'
          THEN 'rm-notice:9bcc6af59d3d7a57e42986c47d1f61ee' ELSE 'rm-notice:f34fcba400280ac347fd4b2f57c81b26' END,
          'source_sha256',CASE WHEN display_name='Name And Address'
          THEN '0be8293cf1e5df70ece00a8f69ce23f97c1e8fd26f9e0c0685e23b4b74049475'
          ELSE '42debee90dd07c6a17eb3b06b159ac837c656a351035a46a1eaf38f60478186f' END)
      FROM public.canonical_people;
      INSERT INTO public.canonical_person_links SELECT id,id,'person_records',organization_id FROM public.person_records;
      INSERT INTO public.notices SELECT id,'c48c1aaf-236b-417c-bbce-938c151662d6',id,
        CASE WHEN display_name='Sam Example' THEN 'unrelated' ELSE metadata->>'notice_import_key' END,
        metadata->>'source_sha256','issued','warning',
        jsonb_build_object('match_basis','created_from_notice','subject_name_on_notice',display_name,'created_person_record_id',id)
      FROM public.person_records;
      INSERT INTO public.notifications SELECT 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13','notice_expiry','warning',
        'Fixture expiry','Fixture body',jsonb_build_object('notice_id',id) FROM public.notices;
      BEGIN;
      UPDATE public.notices SET source_sha256='changed' WHERE import_key LIKE '%f34fc%';
      SELECT pg_temp.refuses('notice no longer matches approved source');
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.audit_log),'a later refusal rolls back the first correction');
      ROLLBACK;
      BEGIN;
      INSERT INTO public.other_person_usage VALUES ('11111111-1111-4111-8111-111111111111');
      SELECT pg_temp.refuses('identity has dependent records');
      ROLLBACK;
      BEGIN;
      INSERT INTO public.other_canonical_usage VALUES ('11111111-1111-4111-8111-111111111111');
      SELECT pg_temp.refuses('identity has dependent records');
      ROLLBACK;
      BEGIN;
      INSERT INTO public.entity_links VALUES ('person','11111111-1111-4111-8111-111111111111','vehicle',gen_random_uuid());
      SELECT pg_temp.refuses('person has other uses');
      ROLLBACK;
      BEGIN;
      UPDATE public.canonical_people SET display_name='Real Corrected Person' WHERE display_name='Name And Address';
      SELECT pg_temp.refuses('person has other uses');
      ROLLBACK;
      BEGIN;
      UPDATE public.notices SET organization_id=gen_random_uuid() WHERE import_key <> 'unrelated';
      SELECT pg_temp.apply_correction();
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.audit_log),'other tenants are untouched');
      ROLLBACK;
      SELECT pg_temp.apply_correction();
      SELECT pg_temp.apply_correction();
      SELECT pg_temp.check((SELECT count(*)=2 FROM public.notices WHERE status='draft'),'exactly two quarantined notices');
      SELECT pg_temp.check((SELECT count(*)=2 FROM public.person_records WHERE review_state='rejected'),'template records rejected');
      SELECT pg_temp.check((SELECT count(*)=2 FROM public.canonical_people WHERE status='retired'),'template identities retired');
      SELECT pg_temp.check((SELECT count(*)=2 FROM public.audit_log WHERE action='notice_import_quarantined'),'idempotent audit receipts');
      SELECT pg_temp.check((SELECT count(*)=2 FROM public.notifications WHERE title='Notice import correction - no warning issued'),'false alerts corrected');
      SELECT pg_temp.check((SELECT status='issued' FROM public.notices WHERE import_key='unrelated'),'real notice preserved');
      SELECT pg_temp.check((SELECT count(*)=3 FROM public.notices),'no notice deleted');
      SELECT pg_temp.check((SELECT count(*)=3 FROM public.person_records),'no person record deleted');
    `;
    execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
