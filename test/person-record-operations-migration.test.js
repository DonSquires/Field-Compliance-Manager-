'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');

const migration = readFileSync(join(__dirname, '../supabase/migrations/20261107200000_person_record_operations.sql'), 'utf8');
const schema = readFileSync(join(__dirname, '../supabase/schema.sql'), 'utf8');
const original = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  const end = schema.indexOf('$function$;', start) + '$function$;'.length;
  assert.ok(start >= 0 && end > start, `Snapshot contains ${name}`);
  return schema.slice(start, end);
};

test('person operations preserve the canonical spine and private original sources', () => {
  assert.match(migration, /UPDATE public\.canonical_people SET homeless_status/);
  assert.match(migration, /public\.import_person_notice\(/);
  assert.match(migration, /p_canonical_person_id => p_person_id/);
  assert.match(migration, /AS RESTRICTIVE FOR SELECT/);
  assert.match(migration, /AS RESTRICTIVE FOR UPDATE/);
  assert.doesNotMatch(migration, /UPDATE public\.(persons|canonical_vehicles)|bob-perceive|person_face_templates/);
});

test('person profile operations enforce authorization, storage, replay, source notice and welfare boundaries', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-person-operations-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000,
  });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL must become ready');
    const sql = query => docker(['exec', '-i', name, 'psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], query).trim();
    const quote = value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
    const org = '10000000-0000-4000-8000-000000000001';
    const client = '10000000-0000-4000-8000-000000000002';
    const otherOrg = '10000000-0000-4000-8000-000000000003';
    const admin = '20000000-0000-4000-8000-000000000001';
    const officer = '20000000-0000-4000-8000-000000000002';
    const adminOfficer = '20000000-0000-4000-8000-000000000003';
    const outsider = '20000000-0000-4000-8000-000000000004';
    const person = '30000000-0000-4000-8000-000000000001';
    const record = '40000000-0000-4000-8000-000000000001';
    const actorSql = (query, actor = admin, role = 'authenticated') =>
      `SET ROLE ${role}; SET request.jwt.claim.sub=${quote(actor ?? '')}; ${query}`;
    sql(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE SCHEMA private; CREATE SCHEMA storage;
      GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT auth.uid() IN ('${admin}'::uuid,'${adminOfficer}'::uuid) AND $1='${org}'::uuid $$;
      CREATE FUNCTION private.rnm_admin_for_organization(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT public.is_admin_for_org($1) $$;
      CREATE FUNCTION public.org_access_allowed(uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT auth.uid() IN ('${admin}'::uuid,'${adminOfficer}'::uuid,'${officer}'::uuid) AND $1 IN ('${org}'::uuid,'${client}'::uuid) $$;
      CREATE FUNCTION public.can_search_people(uuid DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS
        $$ SELECT auth.uid() IN ('${admin}'::uuid,'${adminOfficer}'::uuid,'${officer}'::uuid) AND ($1 IS NULL OR $1='${org}'::uuid) $$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text, parent_organization_id uuid);
      CREATE TABLE public.canonical_people (
        id uuid PRIMARY KEY, status text DEFAULT 'active', review_state text DEFAULT 'verified',
        display_name text, normalized_name text, metadata jsonb DEFAULT '{}', date_of_birth date,
        homeless_status text DEFAULT 'none', homeless_notes text, homeless_verified_at timestamptz,
        updated_at timestamptz DEFAULT clock_timestamp()
      );
      CREATE TABLE public.person_records(id uuid PRIMARY KEY, organization_id uuid, display_name text, review_state text, metadata jsonb DEFAULT '{}');
      CREATE TABLE public.canonical_person_links(canonical_person_id uuid, source_id uuid, organization_id uuid, source_table text);
      CREATE TABLE public.service_agreements(provider_organization_id uuid, client_organization_id uuid,
        agreement_type text, starts_on date, ends_on date);
      CREATE TABLE public.entity_flags(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, entity_type text, entity_id uuid,
        flag_type text, alert_level text, reason text, hazard_class text, active boolean DEFAULT true,
        raised_by uuid, raised_at timestamptz DEFAULT now(), resolved_at timestamptz, resolved_by uuid, client_request_id uuid
      );
      CREATE TABLE public.notices(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid, person_id uuid,
        notice_type text, notice_number text, legal_basis text, status text, authorized_by text,
        authorized_at timestamptz, issued_at timestamptz, expires_at timestamptz, source_author text,
        source_document_name text, source_reference text, source_sha256 text, import_key text, metadata jsonb
      );
      CREATE TABLE public.audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,
        actor_user_id uuid, action text, target_table text, target_id uuid, metadata jsonb, created_at timestamptz DEFAULT now());
      CREATE TABLE storage.buckets(id text PRIMARY KEY, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(), bucket_id text, name text,
        owner_id text, metadata jsonb, user_metadata jsonb, UNIQUE(bucket_id,name));
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      GRANT ALL ON storage.objects TO anon, authenticated;
      CREATE POLICY deliberately_broad_fixture ON storage.objects FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
      INSERT INTO public.organizations VALUES ('${org}','Synthetic provider',NULL),('${client}','Synthetic client',NULL),('${otherOrg}','Other tenant',NULL);
      INSERT INTO public.canonical_people(id,display_name,normalized_name) VALUES('${person}','Synthetic Person','syntheticperson');
      INSERT INTO public.person_records(id,organization_id,display_name,review_state) VALUES('${record}','${org}','Synthetic Person','verified');
      INSERT INTO public.canonical_person_links VALUES('${person}','${record}','${org}','person_records');
      INSERT INTO public.service_agreements VALUES('${org}','${client}','operational',NULL,NULL);
      ${original('import_person_notice')}
      ${original('notices_set_expiry')}
      ${original('raise_scoped_person_interest_flag')}
      ${original('resolve_entity_flag')}
      CREATE TRIGGER notice_expiry BEFORE INSERT OR UPDATE ON public.notices FOR EACH ROW EXECUTE FUNCTION public.notices_set_expiry();
      ${migration}
    `);
    const contextCall = `SELECT public.get_person_record_operations('${org}','${person}')`;
    const context = actor => JSON.parse(sql(actorSql(contextCall, actor)));
    assert.equal(context(admin).verified, true);
    assert.equal(context(adminOfficer).housing.status, 'none');
    for (const actor of [officer, outsider, null]) assert.throws(() => context(actor), /access denied/);
    assert.throws(() => sql(actorSql(`SELECT public.get_person_record_operations('${otherOrg}','${person}')`)), /access denied/);
    assert.equal(sql(`SELECT has_table_privilege('authenticated','public.person_housing_status_definitions','update')`), 'f');
    assert.equal(sql(`SELECT has_table_privilege('authenticated','public.person_record_document_types','insert')`), 'f');
    assert.equal(sql(`SELECT has_function_privilege('anon','public.get_person_record_operations(uuid,uuid)','execute')`), 'f');
    assert.equal(sql(actorSql(`SELECT public.person_document_upload_allowed('malformed/path')`)), 'f');
    const initial = context(admin).housing.version;
    const housingCall = (request, status, version = initial, notes = 'Self-reported; source reviewed.') =>
      `SELECT public.update_person_housing_status('${org}','${person}','${request}',${quote(version)},${quote(status)},${quote(notes)},'Reviewed synthetic welfare source')`;
    const housingRequest = randomUUID();
    const saved = JSON.parse(sql(actorSql(housingCall(housingRequest, 'claiming'))));
    assert.equal(saved.status, 'claiming');
    assert.equal(saved.verified_at, null);
    assert.deepEqual(JSON.parse(sql(actorSql(housingCall(housingRequest, 'claiming')))), saved);
    assert.throws(() => sql(actorSql(housingCall(housingRequest, 'none'))), /different housing update/);
    assert.throws(() => sql(actorSql(housingCall(randomUUID(), 'confirmed'))), /changed; reload/);
    assert.throws(() => sql(actorSql(housingCall(randomUUID(), 'unknown', saved.version))), /configured housing status/);
    sql(`UPDATE public.person_records SET review_state='draft' WHERE id='${record}'`);
    assert.equal(context(admin).verified, false);
    assert.throws(() => sql(actorSql(housingCall(randomUUID(), 'confirmed', saved.version))), /Verify the person identity/);
    assert.throws(() => sql(actorSql(`SELECT public.raise_scoped_person_interest_flag('${org}','${randomUUID()}','${person}','high','Synthetic supporting basis')`)), /verified person record/);
    sql(`UPDATE public.person_records SET review_state='verified' WHERE id='${record}'`);
    const confirmedHousing = JSON.parse(sql(actorSql(housingCall(randomUUID(), 'confirmed', saved.version))));
    assert.ok(confirmedHousing.verified_at);
    const flag = JSON.parse(sql(actorSql(`SELECT to_jsonb(public.raise_scoped_person_interest_flag('${org}','${randomUUID()}','${person}','high','PRIVATE_FLAG_BASIS'))`)));
    const summary = JSON.parse(sql(actorSql(`SELECT public.get_person_interest_summary('${person}')`, officer)));
    assert.equal(summary[0].alert_level, 'high');
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_FLAG_BASIS/);
    assert.throws(() => sql(actorSql(`SELECT public.get_person_interest_summary('${person}')`, outsider)), /authorization required/);
    sql(actorSql(`SELECT public.resolve_entity_flag('${flag.id}','Reviewed and resolved synthetic concern')`));
    assert.equal(context(admin).flags.length, 0);

    const upload = (request, overrides = {}) => {
      const path = `${org}/person/${person}/${request}/source`;
      const values = { owner: admin, hash: 'a'.repeat(64), size: 20, mime: 'application/pdf', ...overrides };
      sql(`INSERT INTO storage.objects(bucket_id,name,owner_id,metadata,user_metadata) VALUES
        ('person-documents',${quote(path)},${quote(values.owner)},${quote(JSON.stringify({size:values.size,mimetype:values.mime}))}::jsonb,
        ${quote(JSON.stringify({sha256:values.hash}))}::jsonb)`);
      return path;
    };
    const documentCall = (request, type = 'other', notice = null, reason = 'Reviewed synthetic source document') =>
      `SELECT public.record_person_document('${org}','${person}','${request}',${quote(type)},'synthetic-source.pdf',
        '${org}/person/${person}/${request}/source','${'a'.repeat(64)}',${quote(reason)},${quote(notice === null ? null : JSON.stringify(notice))}::jsonb)`;
    const request = randomUUID();
    const path = upload(request);
    assert.equal(sql(actorSql(`SELECT count(*) FROM storage.objects WHERE name=${quote(path)}`)), '0', 'Unregistered files cannot be read');
    const document = JSON.parse(sql(actorSql(documentCall(request))));
    assert.equal(document.notice_id, null);
    assert.equal(document.id, JSON.parse(sql(actorSql(documentCall(request)))).id);
    assert.throws(() => sql(actorSql(documentCall(request, 'warning'))), /different document/);
    assert.equal(sql(actorSql(`SELECT count(*) FROM storage.objects WHERE name=${quote(path)}`)), '1');
    assert.equal(sql(actorSql(`SELECT count(*) FROM storage.objects WHERE name=${quote(path)}`, officer)), '0');
    assert.equal(sql(actorSql(`SELECT count(*) FROM storage.objects WHERE name=${quote(path)}`, null, 'anon')), '0');
    assert.equal(sql(actorSql(`DELETE FROM storage.objects WHERE name=${quote(path)} RETURNING name`)), '');
    assert.equal(sql(actorSql(`UPDATE storage.objects SET user_metadata='{}' WHERE name=${quote(path)} RETURNING name`)), '');
    sql(`INSERT INTO storage.objects(bucket_id,name) VALUES('unrelated-bucket','public-file')`);
    assert.equal(sql(actorSql(`SELECT count(*) FROM storage.objects WHERE bucket_id='unrelated-bucket'`, null, 'anon')), '1', 'Unrelated storage policies retain their behavior');
    for (const overrides of [{owner:officer},{hash:'b'.repeat(64)},{size:0},{size:10485761},{mime:'text/html'}]) {
      const invalid = randomUUID(); upload(invalid, overrides);
      assert.throws(() => sql(actorSql(documentCall(invalid))), /upload is missing, invalid/);
    }
    const noticeRequest = randomUUID();
    upload(noticeRequest);
    const notice = { client_organization_id:client, issued_date:'2026-01-15', expires_date:null,
      area:'Synthetic block', source_author:'Synthetic issuer', notice_number:'TEST-ONLY-1', confirmed:true };
    assert.throws(() => sql(actorSql(documentCall(noticeRequest,'trespass',{...notice,confirmed:false}))), /Review the existing issued notice/);
    assert.throws(() => sql(actorSql(documentCall(noticeRequest,'trespass',{...notice,client_organization_id:otherOrg}))), /current operational agreement/);
    assert.throws(() => sql(actorSql(documentCall(noticeRequest,'trespass',{...notice,expires_date:'2025-01-01'}))), /expire before it is issued/);
    const noticeDocument = JSON.parse(sql(actorSql(documentCall(noticeRequest,'trespass',notice))));
    assert.ok(noticeDocument.notice_id);
    const persistedNotice = JSON.parse(sql(`SELECT to_jsonb(n) FROM public.notices n WHERE id='${noticeDocument.notice_id}'`));
    assert.equal(persistedNotice.person_id, person);
    assert.equal(persistedNotice.organization_id, client);
    assert.equal(persistedNotice.status, 'issued');
    assert.equal(persistedNotice.source_sha256, 'a'.repeat(64));
    assert.equal(persistedNotice.expires_at, '2028-01-14T11:00:00+00:00');
    assert.equal(JSON.parse(sql(actorSql(documentCall(noticeRequest,'trespass',notice)))).id, noticeDocument.id);
    assert.equal(sql('SELECT count(*) FROM public.notices'), '1');
    assert.equal(context(admin).document_total, 2);

    const concurrentSql = query => new Promise(resolve => {
      const child = spawn('docker', ['exec','-i',name,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','postgres'], {stdio:['pipe','pipe','pipe']});
      let output = ''; let error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      child.on('close', code => resolve({code,output,error}));
      child.stdin.end(query);
    });
    const beforeRace = context(admin).housing.version;
    const race = await Promise.all(['none','investigating'].map(status => concurrentSql(actorSql(housingCall(randomUUID(),status,beforeRace)))));
    assert.equal(race.filter(result => result.code === 0).length, 1);
    assert.match(race.find(result => result.code !== 0).error, /changed; reload/);
    const beforeRollback = context(admin).housing;
    sql(`CREATE FUNCTION public.reject_person_audit() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN IF NEW.action IN ('person_document_recorded','person_housing_status_updated') THEN
        RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_person_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_person_audit()`);
    assert.throws(() => sql(actorSql(housingCall(randomUUID(),'claiming',beforeRollback.version))), /synthetic audit failure/);
    assert.deepEqual(context(admin).housing, beforeRollback);
    const rollbackRequest = randomUUID(); upload(rollbackRequest);
    assert.throws(() => sql(actorSql(documentCall(rollbackRequest,'warning',notice))), /synthetic audit failure/);
    assert.equal(sql('SELECT count(*) FROM public.notices'), '1', 'The source notice and attachment commit atomically');
    assert.equal(context(admin).document_total, 2);
    assert.equal(sql(actorSql(`SELECT count(*) FROM storage.objects WHERE name='${org}/person/${person}/${rollbackRequest}/source'`)), '0');
  } finally {
    if (created) docker(['rm','--force',name]);
  }
});
