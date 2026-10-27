const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname,
  '../supabase/migrations/20261101110000_permit_holder_person_search.sql'), 'utf8');

function section(start, end) {
  const from = migration.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = end ? migration.indexOf(end, from + start.length) : migration.length;
  return migration.slice(from, to < 0 ? migration.length : to);
}

test('permit read paths never expose the firearm licence number', () => {
  const view = section('CREATE OR REPLACE VIEW public.person_permits_fieldwork', 'COMMENT ON VIEW');
  const search = section('CREATE OR REPLACE FUNCTION public.search_people', 'COMMENT ON FUNCTION public.search_people');
  assert.doesNotMatch(view, /firearm_licence_number/);
  assert.doesNotMatch(search, /firearm_licence_number/);
  assert.match(view, /WITH \(security_invoker = true\)/);
  assert.match(view, /AS validity_state\s+FROM/);
});

test('permit import is a governed, audited, administrator-only write path', () => {
  const importer = section('CREATE OR REPLACE FUNCTION public.import_person_permit', 'COMMENT ON FUNCTION public.import_person_permit');
  assert.match(importer, /SECURITY DEFINER\s+SET search_path = ''/);
  assert.match(importer, /public\.is_admin_for_org\(p_organization_id\)/);
  assert.match(importer, /pg_advisory_xact_lock/);
  assert.match(importer, /INSERT INTO public\.audit_log/);
  assert.doesNotMatch(importer, /DELETE\s+FROM/i);
  assert.doesNotMatch(importer, /UPDATE public\.canonical_vehicles/i);
  assert.doesNotMatch(importer, /canonical_person_id\s*=/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.import_person_permit\([^)]*\) FROM PUBLIC, anon, authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.import_person_permit\([^)]*\) TO authenticated, service_role;/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.search_people\(text, integer\) TO authenticated;/);
});

test('permit holder migration executes against disposable PostgreSQL', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-permit-holder-${randomUUID()}`;
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
    const outsider = 'a0000000-0000-4000-8000-000000000003';
    const alex = '11111111-1111-4111-8111-111111111111';
    const blair = '22222222-2222-4222-8222-222222222222';
    const hash = 'a'.repeat(64);
    const call = (permit, extra = '') =>
      `public.import_person_permit('${rm}','${ofo}','${JSON.stringify(permit).replace(/'/g, "''")}'::jsonb,'Permit Extract OFO.xlsx','${hash}','2025-11-17T21:32:59Z'${extra})`;
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
      CREATE TABLE public.canonical_people(id uuid PRIMARY KEY,canonical_key text,display_name text,normalized_name text,
        review_state text DEFAULT 'draft',status text DEFAULT 'active',merged_into_id uuid,homeless_status text DEFAULT 'none');
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

      SELECT pg_temp.check(public.person_permit_validity('active',NULL,NULL)='dates_not_recorded','no dates recorded');
      SELECT pg_temp.check(public.person_permit_validity('active',current_date-400,current_date+200)='valid','in date');
      SELECT pg_temp.check(public.person_permit_validity('active',NULL,(clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date)='expiring_soon','finishing date is inclusive');
      SELECT pg_temp.check(public.person_permit_validity('active',current_date-400,current_date-2)='expired','past finishing date');
      SELECT pg_temp.check(public.person_permit_validity('active',current_date+5,current_date+200)='not_started','future start');
      SELECT pg_temp.check(public.person_permit_validity('revoked',current_date-5,current_date+200)='revoked','revoked status wins');
      SELECT pg_temp.check(public.person_permit_validity('active',current_date-5,current_date+200,0)='valid','window is configurable');
      SELECT pg_temp.check(NOT has_function_privilege('anon','public.import_person_permit(uuid,uuid,jsonb,text,text,timestamptz,uuid)','EXECUTE'),'anon cannot import');
      SELECT pg_temp.check(has_function_privilege('authenticated','public.import_person_permit(uuid,uuid,jsonb,text,text,timestamptz,uuid)','EXECUTE'),'authenticated may call the gated import');
      SELECT pg_temp.check(NOT has_function_privilege('anon','public.search_people(text,integer)','EXECUTE'),'anon cannot search people');
      SELECT pg_temp.check(has_function_privilege('anon','public.person_permit_validity(text,date,date,integer)','EXECUTE'),'validity is a pure helper');
      SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='person_permits_fieldwork'
        AND column_name='firearm_licence_number'),'fieldwork view keeps the firearm number out');
      SELECT pg_temp.check(EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='person_permits_fieldwork'
        AND column_name='validity_state'),'fieldwork view exposes validity');

      INSERT INTO public.organizations VALUES ('${rm}','R&M'),('${ofo}','OneFortyOne'),('${other}','Other Org');
      INSERT INTO public.user_profiles VALUES ('${admin}','admin',NULL),('${officer}','admin_officer',NULL),('${outsider}','admin',NULL);
      INSERT INTO public.test_access VALUES ('${admin}','${rm}',true),('${admin}','${ofo}',false),('${officer}','${rm}',false),
        ('${outsider}','${other}',true);
      INSERT INTO public.canonical_people(id,canonical_key,display_name,normalized_name) VALUES
        ('${alex}','person:import:alex','Alex Permit','alexpermit'),('${blair}','person:import:blair','Blair Holder','blairholder');
      INSERT INTO public.canonical_vehicles(plate_number,make,model,colour) VALUES ('ABC123','Toyota','Hilux','White'),('XYZ 789','Mazda','Bounty',NULL);
      INSERT INTO public.person_permits(organization_id,client_organization_id,canonical_person_id,permit_number,status,
        compliance_source,source_document,contact_email,contact_phone,address_text) VALUES
        ('${rm}','${ofo}','${alex}','10001','active','import','users.csv','alex@example.test','021 555 0101',NULL),
        ('${rm}','${ofo}','${blair}','10002','active','import','users.csv','blair@example.test','021 555 0202','');

      SELECT pg_temp.act(NULL);
      SELECT pg_temp.refuses($q$SELECT ${call({ permit_number: '10001' })}$q$,'Authentication required');
      SELECT pg_temp.act('${officer}');
      SELECT pg_temp.refuses($q$SELECT ${call({ permit_number: '10001' })}$q$,'Administrator access');
      SELECT pg_temp.act('${admin}');
      SELECT pg_temp.refuses($q$SELECT ${call({ permit_number: '10001', status: 'revoked' })}$q$,'Unsupported permit fields: status');
      SELECT pg_temp.refuses($q$SELECT ${call({ permit_number: '10001', date_from: '2025-12-01', date_to: '2025-11-01' })}$q$,'cannot finish before it starts');
      SELECT pg_temp.refuses($q$SELECT public.import_person_permit('${rm}','${ofo}','{"permit_number":"10001"}'::jsonb,'x.xlsx','nothex',NULL)$q$,'SHA-256');
      SELECT pg_temp.refuses($q$SELECT public.import_person_permit('${rm}','${other}','{"permit_number":"10001"}'::jsonb,'x.xlsx','${hash}',NULL)$q$,'Access to the client organisation');
      SELECT pg_temp.refuses($q$SELECT public.import_person_permit('${rm}','${rm}','{"permit_number":"10001"}'::jsonb,'x.xlsx','${hash}',NULL)$q$,'Permit client conflict');
      SELECT pg_temp.refuses($q$SELECT ${call({ permit_number: '10001' }, `,'${blair}'`)}$q$,'Permit holder conflict');

      INSERT INTO result SELECT 'enrich', ${call({
        permit_number: '10001', holder_name: 'Alex Permit', contact_email: 'ALEX@example.test', date_from: '2025-11-01',
        date_to: '2099-10-31', forest_areas: ['Forest A', ' ', 'Forest B'], activities: ['Hunting'], firearm_licence_valid: true,
        firearm_licence_number: 'FIRE-SECRET-1', keys_issued: true, conditions: 'Gate code from office',
        vehicles: [{ plate: 'abc-123', make: 'Ford', model: 'Ranger' }, { plate: 'NEW1', make: 'Subaru', model: 'Outback', colour: 'Blue' },
          { plate: 'XYZ789' }, { plate: '!' }],
      })};
      SELECT pg_temp.check((SELECT body->>'outcome'='enriched' AND (body->'fields_filled') ? 'date_from'
        AND (body->'fields_filled') ? 'compliance_checked_at' AND NOT (body->'fields_filled') ? 'contact_email'
        AND body->'fields_differing'='[]'::jsonb AND (body->>'vehicles_linked')::int=3 AND (body->>'vehicles_created')::int=1
        AND (body->>'vehicles_invalid')::int=1 AND body->>'match_basis'='existing_permit' AND NOT (body->>'holder_name_differs')::boolean
        FROM result WHERE label='enrich'),'existing permit is enriched and vehicles linked');
      SELECT pg_temp.check((SELECT make='Toyota' AND model='Hilux' FROM public.canonical_vehicles WHERE plate_number='ABC123'),'existing vehicle unchanged');
      SELECT pg_temp.check((SELECT count(*)=3 FROM public.canonical_vehicles),'unnormalised existing plate reused, one created');
      SELECT pg_temp.check((SELECT forest_areas=ARRAY['Forest A','Forest B'] AND contact_email='alex@example.test'
        FROM public.person_permits WHERE permit_number='10001'),'arrays cleaned, recorded email kept');

      INSERT INTO result SELECT 'replay', ${call({
        permit_number: '10001', holder_name: 'Alex Permit', date_from: '2025-11-01', date_to: '2099-10-31',
        vehicles: [{ plate: 'ABC123' }, { plate: 'NEW1' }, { plate: 'XYZ 789' }],
      })};
      SELECT pg_temp.check((SELECT body->>'outcome'='unchanged' AND (body->>'vehicles_already_linked')::int=3
        AND (body->>'vehicles_linked')::int=0 FROM result WHERE label='replay'),'replay is unchanged');
      SELECT pg_temp.check((SELECT count(*)=1 FROM public.audit_log),'replay writes no audit');

      INSERT INTO result SELECT 'differs', ${call({
        permit_number: '10002', holder_name: 'Someone Different', contact_phone: '022 999 0000', address_text: '1  Example Road,  Town',
      })};
      SELECT pg_temp.check((SELECT (body->'fields_filled') ? 'address_text' AND body->'fields_differing'='["contact_phone"]'::jsonb
        AND (body->>'holder_name_differs')::boolean FROM result WHERE label='differs'),'empty text filled, difference reported');
      SELECT pg_temp.check((SELECT contact_phone='021 555 0202' AND address_text='1 Example Road, Town' AND canonical_person_id='${blair}'
        FROM public.person_permits WHERE permit_number='10002'),'recorded phone and holder kept');

      INSERT INTO result SELECT 'new', ${call({
        permit_number: '10003', holder_name: 'ALEX  permit', contact_email: ' alex@example.test ', date_from: '2025-01-01',
        date_to: '2025-02-01', vehicles: [{ plate: 'ABC123' }],
      })};
      SELECT pg_temp.check((SELECT body->>'outcome'='inserted' AND body->>'match_basis'='permit_email_and_name'
        AND body->>'canonical_person_id'='${alex}' FROM result WHERE label='new'),'new permit joins the agreeing holder');
      SELECT pg_temp.refuses($q$SELECT ${call({ permit_number: '10004', holder_name: 'Other Name', contact_email: 'alex@example.test' })}$q$,
        'Permit holder not resolved');
      SELECT pg_temp.refuses($q$SELECT ${call({ permit_number: '10004', contact_email: 'alex@example.test' })}$q$,'Permit holder not resolved');
      INSERT INTO result SELECT 'explicit', ${call({ permit_number: '10005' }, `,'${blair}'`)};
      SELECT pg_temp.check((SELECT body->>'outcome'='inserted' AND body->>'match_basis'='explicit' FROM result WHERE label='explicit'),
        'explicit holder accepted');
      SELECT pg_temp.check((SELECT count(*)=2 FROM public.audit_log WHERE action='person_permit_imported')
        AND (SELECT count(*)=2 FROM public.audit_log WHERE action='person_permit_enriched'),'audited once per change');
      SELECT pg_temp.check(NOT EXISTS (SELECT 1 FROM public.audit_log WHERE metadata::text ~* 'example\\.test|FIRE-SECRET|0101|Example Road'),
        'audit metadata holds no personal values');

      SELECT pg_temp.check((SELECT validity_state='valid' AND vehicle_plates=ARRAY['ABC123','NEW1','XYZ 789']
        FROM public.person_permits_fieldwork WHERE permit_number='10001'),'fieldwork view shows validity and plates');

      INSERT INTO result SELECT 'search_name', public.search_people('alex permit');
      SELECT pg_temp.check((SELECT jsonb_array_length(body)=1 AND jsonb_array_length(body->0->'permits')=2
        AND body->0->'permits'->0->>'permit_number'='10001' AND body->0->'permits'->0->>'validity_state'='valid'
        AND body->0->'permits'->0->>'client_organization_name'='OneFortyOne'
        AND jsonb_array_length(body->0->'permits'->0->'vehicles')=3
        AND body->0->'permits'->1->>'validity_state'='expired'
        AND body->0->'organizations'='["R&M"]'::jsonb
        AND body::text NOT LIKE '%FIRE-SECRET%' FROM result WHERE label='search_name'),'permit-only holder is visible with permits');
      INSERT INTO result SELECT 'search_number', public.search_people(' 10002 ');
      SELECT pg_temp.check((SELECT jsonb_array_length(body)=1 AND body->0->>'canonical_person_id'='${blair}'
        FROM result WHERE label='search_number'),'exact permit number finds the holder');
      INSERT INTO result SELECT 'search_partial', public.search_people('1000');
      SELECT pg_temp.check((SELECT body='[]'::jsonb FROM result WHERE label='search_partial'),'partial permit numbers do not match');
      SELECT pg_temp.act('${officer}');
      INSERT INTO result SELECT 'officer', public.search_people('Blair');
      SELECT pg_temp.check((SELECT jsonb_array_length(body)=1 FROM result WHERE label='officer'),'operations officer sees the holder');
      SELECT pg_temp.act('${outsider}');
      INSERT INTO result SELECT 'outsider', public.search_people('alex permit');
      SELECT pg_temp.check((SELECT body='[]'::jsonb FROM result WHERE label='outsider'),'other tenants cannot see the holder');
    `;
    execFileSync('docker', ['exec', '-i', name, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-q'], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } finally {
    if (created) docker(['rm', '-f', name]);
  }
});
