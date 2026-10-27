const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const read = file => fs.readFileSync(path.join(__dirname, '../supabase/migrations', file), 'utf8');
const permitSearch = read('20261101110000_permit_holder_person_search.sql');
const migration = read('20261101120000_permit_holder_identity_repair.sql');

function section(start, end) {
  const from = migration.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = end ? migration.indexOf(end, from + start.length) : migration.length;
  return migration.slice(from, to < 0 ? migration.length : to);
}

test('holder repair is a governed, audited, administrator-only write path', () => {
  const repair = section('CREATE OR REPLACE FUNCTION public.attribute_permit_holder', 'COMMENT ON FUNCTION public.attribute_permit_holder');
  assert.match(repair, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(repair, /public\.is_admin_for_org\(p_organization_id\)/);
  assert.match(repair, /pg_advisory_xact_lock/);
  assert.match(repair, /INSERT INTO public\.audit_log/);
  assert.match(repair, /public\.person_name_extends\(v_person\.display_name, v_name\)/);
  assert.match(repair, /Permit holder is shared/);
  assert.doesNotMatch(repair, /DELETE\s+FROM/i);
  assert.doesNotMatch(repair, /canonical_key\s*=/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.attribute_permit_holder\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.attribute_permit_holder\([^)]*\) TO authenticated, service_role;/);
});

test('the permit import still never changes a recorded permit holder', () => {
  const importer = section('CREATE OR REPLACE FUNCTION public.import_person_permit', 'COMMENT ON FUNCTION public.import_person_permit');
  assert.match(migration, /DROP FUNCTION IF EXISTS public\.import_person_permit\(uuid, uuid, jsonb, text, text, timestamptz, uuid\);/);
  assert.match(importer, /p_create_holder boolean DEFAULT false/);
  assert.match(importer, /public\.person_name_extends\(p\.display_name, v_holder_name\)/);
  assert.doesNotMatch(importer, /canonical_person_id\s*=/);
  assert.doesNotMatch(importer, /UPDATE public\.canonical_people/i);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.import_person_permit\(uuid, uuid, jsonb, text, text, timestamptz, uuid, boolean\) TO authenticated, service_role;/);
});

test('permit holder identity repair executes against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-permit-holder-repair-${randomUUID()}`;
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
    const rm = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
    const ofo = 'c48c1aaf-236b-417c-bbce-938c151662d6';
    const other = '0f0f0f0f-0000-4000-8000-000000000003';
    const admin = 'a0000000-0000-4000-8000-000000000001';
    const officer = 'a0000000-0000-4000-8000-000000000002';
    const smith = '11111111-1111-4111-8111-111111111111';
    const ngata = '22222222-2222-4222-8222-222222222222';
    const brown = '33333333-3333-4333-8333-333333333333';
    const lee1 = '44444444-4444-4444-8444-444444444441';
    const lee2 = '44444444-4444-4444-8444-444444444442';
    const hash = 'b'.repeat(64);
    const attribute = (person, fullName, numbers, withSameEmail = false, sha = hash) =>
      `public.attribute_permit_holder('${rm}','${person}','${fullName}',ARRAY[${numbers.map(n => `'${n}'`).join(',')}]::text[],` +
      `'Permit Extract OFO.xlsx','${sha}',${withSameEmail})`;
    const permitImport = (permit, create = false) =>
      `public.import_person_permit('${rm}','${ofo}','${JSON.stringify(permit).replace(/'/g, "''")}'::jsonb,` +
      `'Permit Extract OFO.xlsx','${hash}','2025-11-17T21:32:59Z',NULL,${create})`;
    const sql = `
      DO $$ BEGIN
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      END $$;
      CREATE SCHEMA auth;
      GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $fn$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY,name text);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,role text,deactivated_at timestamptz);
      CREATE TABLE public.test_access(user_id uuid,org_id uuid,is_admin boolean);
      CREATE FUNCTION public.org_access_allowed(p uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $fn$ SELECT EXISTS (SELECT 1 FROM public.test_access a WHERE a.user_id = auth.uid() AND a.org_id = p) $fn$;
      CREATE FUNCTION public.is_admin_for_org(p uuid) RETURNS boolean LANGUAGE sql STABLE AS
        $fn$ SELECT EXISTS (SELECT 1 FROM public.test_access a WHERE a.user_id = auth.uid() AND a.org_id = p AND a.is_admin) $fn$;
      CREATE FUNCTION public.can_access_vehicle_owner_identity(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $fn$ SELECT false $fn$;
      CREATE FUNCTION public.normalize_person_name(p_name text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO '' AS
        $fn$ SELECT nullif(regexp_replace(lower(trim(coalesce(p_name, ''))), '[^a-z0-9]+', '', 'g'), '') $fn$;
      CREATE FUNCTION public.normalize_plate_number(p_plate text) RETURNS text LANGUAGE sql IMMUTABLE AS
        $fn$ SELECT NULLIF(left(upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g')), 10), '') $fn$;
      CREATE FUNCTION public.notice_expiry_state(p_status text, p_expires_at timestamptz, p_window_days integer DEFAULT 30)
        RETURNS text LANGUAGE sql STABLE AS $fn$ SELECT 'no_expiry' $fn$;
      CREATE TABLE public.canonical_people(id uuid PRIMARY KEY,canonical_key text NOT NULL UNIQUE,display_name text,
        normalized_name text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}'::jsonb,review_state text NOT NULL DEFAULT 'draft',
        status text NOT NULL DEFAULT 'active',merged_into_id uuid,homeless_status text DEFAULT 'none',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
      CREATE VIEW public.canonical_person_public AS SELECT id, display_name FROM public.canonical_people;
      CREATE TABLE public.canonical_vehicles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),plate_number text NOT NULL UNIQUE,
        make text,model text,colour text,created_at timestamptz NOT NULL DEFAULT now());
      CREATE VIEW public.canonical_vehicle_public AS SELECT id, plate_number FROM public.canonical_vehicles;
      CREATE TABLE public.person_permits(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,
        client_organization_id uuid,canonical_person_id uuid NOT NULL REFERENCES public.canonical_people(id),permit_number text NOT NULL,
        permit_type text,applicant_type text,company_name text,forest_areas text[],activities text[],hunting_season text,
        date_from date,date_to date,firearm_confirm boolean,firearm_licence_valid boolean,firearm_licence_number text,
        chainsaw_safety_equipment boolean,keys_issued boolean,conditions text,status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','expired','revoked','suspended')),compliance_checked_at timestamptz,compliance_source text,
        source_document text,created_by uuid,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        contact_email text,contact_phone text,address_text text,UNIQUE (organization_id, permit_number));
      CREATE TABLE public.person_permit_vehicles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL,
        permit_id uuid NOT NULL REFERENCES public.person_permits(id) ON DELETE CASCADE,
        canonical_vehicle_id uuid NOT NULL REFERENCES public.canonical_vehicles(id),created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (permit_id, canonical_vehicle_id));
      CREATE TABLE public.canonical_person_links(canonical_person_id uuid,source_table text,source_id uuid,organization_id uuid);
      CREATE TABLE public.person_records(id uuid PRIMARY KEY,organization_id uuid,display_name text);
      CREATE TABLE public.person_record_aliases(person_record_id uuid,active boolean,organization_id uuid,alias text,alias_norm text);
      CREATE TABLE public.notices(id uuid PRIMARY KEY,organization_id uuid,person_id uuid,notice_type text,notice_number text,
        status text,issued_at timestamptz,expires_at timestamptz,observation_id uuid,location_id uuid);
      CREATE TABLE public.observations(id uuid PRIMARY KEY,location_id uuid);
      CREATE TABLE public.locations(id uuid PRIMARY KEY,name text);
      CREATE TABLE public.entity_links(from_type text,from_id uuid,to_type text,to_id uuid,relationship text,starts_at timestamptz,
        evidence jsonb,active boolean,organization_id uuid);
      CREATE TABLE public.person_identity_documents(id uuid PRIMARY KEY,extracted_fields jsonb);
      CREATE TABLE public.vehicle_identity_checks(canonical_person_id uuid,canonical_vehicle_id uuid,organization_id uuid,
        identity_document_id uuid,checked_at timestamptz);
      CREATE TABLE public.audit_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,actor_user_id uuid,action text,
        target_table text,target_id uuid,metadata jsonb,created_at timestamptz NOT NULL DEFAULT now());
      CREATE VIEW public.person_permits_fieldwork WITH (security_invoker = true) AS
        SELECT pp.id, pp.organization_id, pp.client_organization_id, pp.canonical_person_id, cp.display_name AS holder_name,
          pp.permit_number, pp.permit_type, pp.applicant_type, pp.company_name, pp.contact_email, pp.contact_phone, pp.address_text,
          pp.forest_areas, pp.activities, pp.hunting_season, pp.date_from, pp.date_to, pp.firearm_confirm, pp.firearm_licence_valid,
          pp.chainsaw_safety_equipment, pp.keys_issued, pp.conditions, pp.status, pp.compliance_checked_at, pp.compliance_source,
          (SELECT array_agg(cv.plate_number ORDER BY cv.plate_number) FROM public.person_permit_vehicles ppv
            JOIN public.canonical_vehicle_public cv ON cv.id = ppv.canonical_vehicle_id WHERE ppv.permit_id = pp.id) AS vehicle_plates
        FROM public.person_permits pp LEFT JOIN public.canonical_person_public cp ON cp.id = pp.canonical_person_id
        WHERE public.org_access_allowed(pp.organization_id);
      CREATE FUNCTION public.search_people(p_query text, p_limit integer DEFAULT 25) RETURNS jsonb LANGUAGE sql AS $fn$ SELECT '[]'::jsonb $fn$;

      ${permitSearch}

      ${migration}

      CREATE FUNCTION pg_temp.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $fn$;
      CREATE FUNCTION pg_temp.refuses(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $fn$
      BEGIN
        BEGIN EXECUTE statement;
        EXCEPTION WHEN OTHERS THEN
          IF position(expected IN SQLERRM)=0 THEN RAISE; END IF;
          RETURN;
        END;
        RAISE EXCEPTION 'Expected refusal: %',expected;
      END $fn$;
      CREATE FUNCTION pg_temp.act(p uuid) RETURNS void LANGUAGE sql AS
        $fn$ SELECT set_config('request.jwt.claim.sub', coalesce(p::text, ''), false) $fn$;
      CREATE TEMP TABLE result(label text PRIMARY KEY, body jsonb);

      SELECT pg_temp.check(to_regprocedure('public.import_person_permit(uuid,uuid,jsonb,text,text,timestamptz,uuid)') IS NULL,
        'the old import signature is replaced, not overloaded');
      SELECT pg_temp.check(NOT has_function_privilege('anon','public.attribute_permit_holder(uuid,uuid,text,text[],text,text,boolean)','EXECUTE'),'anon cannot repair holders');
      SELECT pg_temp.check(has_function_privilege('authenticated','public.attribute_permit_holder(uuid,uuid,text,text[],text,text,boolean)','EXECUTE'),'authenticated may call the gated repair');
      SELECT pg_temp.check(NOT has_function_privilege('anon','public.import_person_permit(uuid,uuid,jsonb,text,text,timestamptz,uuid,boolean)','EXECUTE'),'anon cannot import');
      SELECT pg_temp.check(public.person_name_extends('Smith','Jane Smith'),'a given name extends a surname');
      SELECT pg_temp.check(public.person_name_extends('smith','  JANE   smith '),'case and spacing are ignored');
      SELECT pg_temp.check(public.person_name_extends('Jane Smith','Mary Jane Smith'),'a further given name extends a full name');
      SELECT pg_temp.check(public.person_name_extends('van der Berg','Piet Van Der Berg'),'a multi-word surname is kept whole');
      SELECT pg_temp.check(NOT public.person_name_extends('Smith','Smith'),'an equal name is not an extension');
      SELECT pg_temp.check(NOT public.person_name_extends('Smith','Jane Smyth'),'a different surname never matches');
      SELECT pg_temp.check(NOT public.person_name_extends('Smith','Smith Jane'),'the recorded name must end the full name');
      SELECT pg_temp.check(NOT public.person_name_extends('Tama Ngata','Hine Ngata'),'a different given name is not an extension');
      SELECT pg_temp.check(NOT coalesce(public.person_name_extends(NULL,'Jane Smith'), true),'no recorded name never matches');

      INSERT INTO public.organizations VALUES ('${rm}','R&M'),('${ofo}','OneFortyOne'),('${other}','Other Org');
      INSERT INTO public.user_profiles VALUES ('${admin}','admin',NULL),('${officer}','admin_officer',NULL);
      INSERT INTO public.test_access VALUES ('${admin}','${rm}',true),('${admin}','${ofo}',false),('${officer}','${rm}',false);
      INSERT INTO public.canonical_people(id,canonical_key,display_name,normalized_name) VALUES
        ('${smith}','person:import:smith','Smith','smith'),('${ngata}','person:import:ngata','Ngata','ngata'),
        ('${brown}','person:import:brown','Brown','brown'),('${lee1}','person:import:lee','Lee','lee'),
        ('${lee2}','person:import:lee-2','Lee','lee');
      INSERT INTO public.person_permits(organization_id,client_organization_id,canonical_person_id,permit_number,contact_email) VALUES
        ('${rm}','${ofo}','${smith}','20001','a@example.test'),('${rm}','${ofo}','${smith}','20002','A@example.test '),
        ('${rm}','${ofo}','${smith}','20003','b@example.test'),
        ('${rm}','${ofo}','${ngata}','40001','n@example.test'),('${rm}','${ofo}','${ngata}','40002','n@example.test'),
        ('${rm}','${ofo}','${brown}','30001','br@example.test'),('${rm}','${ofo}','${brown}','30002','br@example.test'),
        ('${rm}','${ofo}','${lee1}','60001','l@example.test'),('${rm}','${ofo}','${lee2}','60002','l@example.test');
      INSERT INTO public.canonical_person_links VALUES ('${brown}','person_records',gen_random_uuid(),'${other}');

      SELECT pg_temp.act(NULL);
      SELECT pg_temp.refuses($q$SELECT ${attribute(ngata, 'Tama Ngata', ['40001', '40002'])}$q$,'Authentication required');
      SELECT pg_temp.act('${officer}');
      SELECT pg_temp.refuses($q$SELECT ${attribute(ngata, 'Tama Ngata', ['40001', '40002'])}$q$,'Administrator access');
      SELECT pg_temp.act('${admin}');
      SELECT pg_temp.refuses($q$SELECT ${attribute(ngata, 'Ngata', ['40001'])}$q$,'at least two words');
      SELECT pg_temp.refuses($q$SELECT ${attribute(ngata, 'Tama Ngata', [])}$q$,'At least one evidence permit');
      SELECT pg_temp.refuses($q$SELECT ${attribute(ngata, 'Tama Ngata', ['40001'], false, 'nothex')}$q$,'SHA-256');
      SELECT pg_temp.refuses($q$SELECT ${attribute(ngata, 'Tama Ngata', ['20001'])}$q$,'Permit holder conflict');
      SELECT pg_temp.refuses($q$SELECT ${attribute(ngata, 'Tama Ngatai', ['40001', '40002'])}$q$,'must end with the recorded name');

      INSERT INTO result SELECT 'complete', ${attribute(ngata, 'Tama  Ngata', ['40001', ' 40002 '])};
      SELECT pg_temp.check((SELECT body->>'outcome'='name_completed' AND body->>'canonical_person_id'='${ngata}'
        AND (body->>'permits_moved')::int=0 AND (body->>'permits_remaining')::int=2 FROM result WHERE label='complete'),
        'every permit proven: the name is completed in place');
      SELECT pg_temp.check((SELECT display_name='Tama Ngata' AND normalized_name='tamangata' AND canonical_key='person:import:ngata'
        AND metadata->'name_completed'->>'previous_display_name'='Ngata' AND metadata->'name_completed'->'permit_numbers'='["40001","40002"]'::jsonb
        FROM public.canonical_people WHERE id='${ngata}'),'name completed, key kept, previous name recorded');
      INSERT INTO result SELECT 'complete_replay', ${attribute(ngata, 'Tama Ngata', ['40001', '40002'])};
      SELECT pg_temp.check((SELECT body->>'outcome'='unchanged' FROM result WHERE label='complete_replay'),'a replay is unchanged');
      SELECT pg_temp.check((SELECT count(*)=1 FROM public.audit_log WHERE action='permit_holder_name_completed'),'a replay writes no audit');

      INSERT INTO result SELECT 'split', ${attribute(smith, 'Jane Smith', ['20001'], true)};
      SELECT pg_temp.check((SELECT body->>'outcome'='split' AND body->>'canonical_person_id'<>'${smith}'
        AND (body->>'permits_moved')::int=2 AND (body->>'permits_remaining')::int=1 FROM result WHERE label='split'),
        'a named holder and their same-email permits move to their own record');
      SELECT pg_temp.check((SELECT p.display_name='Jane Smith' AND p.canonical_key LIKE 'person:permit-holder:%' AND p.review_state='draft'
        AND p.metadata->>'split_from_canonical_person_id'='${smith}' FROM public.canonical_people p
        JOIN result r ON r.label='split' AND p.id=(r.body->>'canonical_person_id')::uuid),'the new record carries the proven name and its origin');
      SELECT pg_temp.check((SELECT bool_and(canonical_person_id=(SELECT (body->>'canonical_person_id')::uuid FROM result WHERE label='split'))
        FROM public.person_permits WHERE permit_number IN ('20001','20002'))
        AND (SELECT canonical_person_id='${smith}' FROM public.person_permits WHERE permit_number='20003')
        AND (SELECT display_name='Smith' FROM public.canonical_people WHERE id='${smith}'),'the other-email permit stays on the surname record');
      SELECT pg_temp.refuses($q$SELECT public.attribute_permit_holder('${rm}',(SELECT (body->>'canonical_person_id')::uuid FROM result WHERE label='split'),
        'Jane Smith',ARRAY['20001'],'Permit Extract OFO.xlsx','${hash}',false)$q$,'already carries this name');

      INSERT INTO result SELECT 'shared_split', ${attribute(brown, 'Ann Brown', ['30001'])};
      SELECT pg_temp.check((SELECT body->>'outcome'='split' FROM result WHERE label='shared_split'),
        'permits can move off a person another organisation records');
      SELECT pg_temp.refuses($q$SELECT ${attribute(brown, 'Ben Brown', ['30002'])}$q$,'Permit holder is shared');
      SELECT pg_temp.check((SELECT display_name='Brown' FROM public.canonical_people WHERE id='${brown}'),'a shared person is never renamed');

      INSERT INTO result SELECT 'surname', ${permitImport({ permit_number: '20004', holder_name: 'Rua Smith', contact_email: 'B@example.test' })};
      SELECT pg_temp.check((SELECT body->>'outcome'='inserted' AND body->>'match_basis'='permit_email_and_surname'
        AND body->>'canonical_person_id'='${smith}' AND (body->>'holder_name_incomplete')::boolean AND NOT (body->>'holder_created')::boolean
        FROM result WHERE label='surname'),'a new permit joins the single surname holder with the same email');
      INSERT INTO result SELECT 'complete_from_new', ${attribute(smith, 'Rua Smith', ['20004'], true)};
      SELECT pg_temp.check((SELECT body->>'outcome'='name_completed' AND (body->>'permits_attributed')::int=2 FROM result WHERE label='complete_from_new')
        AND (SELECT display_name='Rua Smith' FROM public.canonical_people WHERE id='${smith}'),'the linked holder''s name is completed');

      INSERT INTO result SELECT 'exact', ${permitImport({ permit_number: '40003', holder_name: 'TAMA ngata', contact_email: 'n@example.test' })};
      SELECT pg_temp.check((SELECT body->>'match_basis'='permit_email_and_name' AND body->>'canonical_person_id'='${ngata}'
        FROM result WHERE label='exact'),'a renewal joins the completed holder');
      SELECT pg_temp.refuses($q$SELECT ${permitImport({ permit_number: '40004', holder_name: 'Hine Ngata', contact_email: 'n@example.test' })}$q$,
        'Permit holder not resolved');
      INSERT INTO result SELECT 'created', ${permitImport({ permit_number: '40004', holder_name: 'Hine  Ngata', contact_email: 'n@example.test' }, true)};
      SELECT pg_temp.check((SELECT body->>'outcome'='inserted' AND body->>'match_basis'='created_holder' AND (body->>'holder_created')::boolean
        AND body->>'canonical_person_id' NOT IN ('${ngata}') FROM result WHERE label='created'),'a different family member is a new person');
      SELECT pg_temp.check((SELECT p.display_name='Hine Ngata' AND p.normalized_name='hinengata' AND p.canonical_key LIKE 'person:permit-holder:%'
        AND p.metadata->>'created_from_permit_number'='40004' FROM public.canonical_people p
        JOIN result r ON r.label='created' AND p.id=(r.body->>'canonical_person_id')::uuid),'the new person carries the full name and its source');
      SELECT pg_temp.refuses($q$SELECT ${permitImport({ permit_number: '50001', holder_name: 'Solo', contact_email: 's@example.test' }, true)}$q$,
        'a new holder needs a full name');
      SELECT pg_temp.refuses($q$SELECT ${permitImport({ permit_number: '60003', holder_name: 'Kim Lee', contact_email: 'l@example.test' }, true)}$q$,
        'share this surname');
      SELECT pg_temp.refuses($q$SELECT ${permitImport({ permit_number: '70002', holder_name: 'Pita Walker' })}$q$,'both required');
      INSERT INTO result SELECT 'no_email', ${permitImport({ permit_number: '70001', holder_name: 'Pita Walker' }, true)};
      SELECT pg_temp.check((SELECT body->>'match_basis'='created_holder' FROM result WHERE label='no_email'),'creation does not need an email');
      INSERT INTO result SELECT 'existing', ${permitImport({ permit_number: '40001', holder_name: 'Tama Ngata', contact_email: 'n@example.test' }, true)};
      SELECT pg_temp.check((SELECT body->>'outcome'='enriched' AND body->>'match_basis'='existing_permit'
        AND body->>'canonical_person_id'='${ngata}' AND NOT (body->>'holder_name_differs')::boolean
        AND NOT (body->>'holder_created')::boolean FROM result WHERE label='existing'),
        'a recorded permit keeps its holder and now agrees with the extract');
      INSERT INTO result SELECT 'existing_replay', ${permitImport({ permit_number: '40001', holder_name: 'Tama Ngata', contact_email: 'n@example.test' }, true)};
      SELECT pg_temp.check((SELECT body->>'outcome'='unchanged' FROM result WHERE label='existing_replay'),'an import replay is unchanged');

      SELECT pg_temp.check((SELECT count(*)=2 FROM public.audit_log WHERE action='permit_holder_split'),'each split is audited once');
      SELECT pg_temp.check((SELECT count(*)=2 FROM public.audit_log WHERE action='permit_holder_name_completed'),'each completion is audited once');
      SELECT pg_temp.check((SELECT count(*)=4 FROM public.audit_log WHERE action='person_permit_imported')
        AND (SELECT count(*)=1 FROM public.audit_log WHERE action='person_permit_enriched'),'each import change is audited once');
      SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.audit_log
        WHERE metadata::text ~* 'smith|ngata|brown|jane|tama|hine|rua|walker|example\\.test'),'audit metadata holds no personal values');
      SELECT pg_temp.check((SELECT holder_name='Tama Ngata' FROM public.person_permits_fieldwork WHERE permit_number='40001'),
        'the field view shows the completed name');
      INSERT INTO result SELECT 'search', public.search_people('Hine Ngata');
      SELECT pg_temp.check((SELECT jsonb_array_length(body)=1 AND body->0->>'canonical_person_id'=
        (SELECT body->>'canonical_person_id' FROM result WHERE label='created') FROM result WHERE label='search'),
        'the new holder is found by full name');
    `;
    execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
