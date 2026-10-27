const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261101140000_officer_person_search_access.sql'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '../supabase/schema.sql'), 'utf8');
const catalogFunction = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
};

test('all new public identity functions revoke default execution and fieldwork remains an invoker view', () => {
  for (const name of ['can_search_people', 'can_access_person_contacts', 'get_person_search_access', 'set_person_search_access', 'read_person_permits_fieldwork']) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^;]*FROM PUBLIC, anon, authenticated, service_role;`));
  }
  assert.match(migration, /WITH \(security_invoker = true\)/);
  assert.doesNotMatch(migration, /firearm_licence_number/);
  assert.match(migration, /ALTER POLICY person_records_select/);
  assert.match(migration, /ALTER POLICY entity_links_select/);
});

test('person authorization, private projections and revocation execute as real database roles', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-person-access-${randomUUID()}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const org = id(1), other = id(2), client = id(3), admin = id(10), officer = id(11), desk = id(12), outsider = id(13);
  const person = id(20), record = id(21), permit = id(22), vehicle = id(23), document = id(24);
  const actor = user => `SELECT set_config('request.jwt.claim.sub','${user}',false); SET ROLE authenticated;`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'Disposable PostgreSQL ready');
    const sql = `
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE SCHEMA extensions; CREATE EXTENSION pg_trgm SCHEMA extensions;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $f$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      CREATE TABLE public.organizations(id uuid PRIMARY KEY,name text,parent_organization_id uuid);
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,role text,organization_id uuid,employer_organization_id uuid,
        authorized_organization_ids uuid[] DEFAULT '{}',deactivated_at timestamptz,display_name text);
      CREATE TABLE public.service_agreements(provider_organization_id uuid,client_organization_id uuid,ends_on date,agreement_type text);
      CREATE TABLE public.provider_client_access_grants(provider_organization_id uuid,client_organization_id uuid,ends_at timestamptz);
      CREATE FUNCTION public.get_descendant_organizations(p uuid) RETURNS uuid[] LANGUAGE sql STABLE AS $f$
        WITH RECURSIVE tree AS (SELECT id FROM public.organizations WHERE id=p UNION ALL
          SELECT o.id FROM public.organizations o JOIN tree t ON o.parent_organization_id=t.id)
        SELECT array_agg(id) FROM tree $f$;
      CREATE FUNCTION public.is_grand_master() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND role='grand_master' AND deactivated_at IS NULL) $f$;
      CREATE TABLE public.staff_area_grants(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,scope_org_id uuid,
        area text,level text,status text,granted_by uuid,updated_at timestamptz DEFAULT now(),UNIQUE(user_id,scope_org_id,area));
      CREATE TABLE public.access_presets(id uuid PRIMARY KEY,grants jsonb);
      CREATE TABLE public.preset_assignments(user_id uuid,scope_org_id uuid,preset_id uuid,status text);
      ${['org_access_allowed', 'is_admin_for_org', 'resolve_access_grants', 'can_access_vehicle_owner_identity',
        'notice_expiry_state', 'person_permit_validity', 'normalize_person_name', 'vehicle_owner_locality'].map(catalogFunction).join('\n')}
      CREATE TABLE public.canonical_people(id uuid PRIMARY KEY,display_name text,normalized_name text,status text,
        review_state text,homeless_status text);
      CREATE TABLE public.canonical_vehicles(id uuid PRIMARY KEY,plate_number text,make text,model text,colour text);
      CREATE TABLE public.person_records(id uuid PRIMARY KEY,organization_id uuid,display_name text,metadata jsonb,review_state text);
      CREATE TABLE public.canonical_person_links(canonical_person_id uuid,organization_id uuid,source_table text,source_id uuid);
      CREATE TABLE public.person_record_aliases(person_record_id uuid,organization_id uuid,alias text,alias_norm text,active boolean,created_at timestamptz);
      CREATE TABLE public.notices(id uuid,organization_id uuid,person_id uuid,notice_type text,notice_number text,
        status text,issued_at timestamptz,expires_at timestamptz,observation_id uuid,location_id uuid);
      CREATE TABLE public.observations(id uuid,location_id uuid,person_record_id uuid);
      CREATE TABLE public.cctv_entity_observations(person_record_id uuid);
      CREATE TABLE public.locations(id uuid,name text);
      CREATE TABLE public.person_identity_documents(id uuid,extracted_fields jsonb);
      CREATE TABLE public.vehicle_identity_checks(canonical_person_id uuid,canonical_vehicle_id uuid,organization_id uuid,
        identity_document_id uuid,checked_at timestamptz);
      CREATE TABLE public.entity_links(id uuid,organization_id uuid,from_type text,from_id uuid,to_type text,to_id uuid,
        relationship text,active boolean,evidence jsonb,starts_at timestamptz,ends_at timestamptz,created_at timestamptz,created_by uuid);
      CREATE TABLE public.audit_log(id uuid DEFAULT gen_random_uuid(),organization_id uuid,actor_user_id uuid,action text,
        target_table text,target_id uuid,metadata jsonb);
      CREATE TABLE public.person_permits(id uuid,organization_id uuid,client_organization_id uuid,canonical_person_id uuid,
        permit_number text,permit_type text,applicant_type text,company_name text,contact_email text,contact_phone text,address_text text,
        forest_areas text[],activities text[],hunting_season text,date_from date,date_to date,firearm_confirm boolean,
        firearm_licence_valid boolean,firearm_licence_number text,chainsaw_safety_equipment boolean,keys_issued boolean,
        conditions text,status text,compliance_checked_at timestamptz,compliance_source text,source_document text,created_at timestamptz);
      CREATE TABLE public.person_permit_vehicles(permit_id uuid,canonical_vehicle_id uuid);
      ALTER TABLE public.person_records ENABLE ROW LEVEL SECURITY;
      CREATE POLICY person_records_select ON public.person_records FOR SELECT USING(public.org_access_allowed(organization_id));
      ALTER TABLE public.entity_links ENABLE ROW LEVEL SECURITY;
      CREATE POLICY entity_links_select ON public.entity_links FOR SELECT USING(public.org_access_allowed(organization_id));
      ALTER TABLE public.person_permits ENABLE ROW LEVEL SECURITY;
      CREATE POLICY person_permits_admin_all ON public.person_permits USING(public.is_admin_for_org(organization_id));
      GRANT SELECT ON public.person_records,public.entity_links,public.person_permits TO authenticated;
      ${migration}
      GRANT SELECT ON public.person_permits_fieldwork TO authenticated;
      CREATE FUNCTION pg_temp.check(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $f$
        BEGIN IF NOT coalesce(ok,false) THEN RAISE EXCEPTION 'FAIL: %',label; END IF; END $f$;
      CREATE FUNCTION pg_temp.refuses(statement text,expected text) RETURNS void LANGUAGE plpgsql AS $f$
      BEGIN
        BEGIN EXECUTE statement;
        EXCEPTION WHEN OTHERS THEN IF position(expected IN SQLERRM)=0 THEN RAISE; END IF; RETURN; END;
        RAISE EXCEPTION 'Unexpected success: %',statement;
      END $f$;
      INSERT INTO public.organizations(id,name) VALUES('${org}','Test provider'),('${other}','Other tenant'),('${client}','Test client');
      INSERT INTO public.user_profiles(id,role,organization_id) VALUES
        ('${admin}','admin','${org}'),('${officer}','officer','${org}'),
        ('${desk}','admin_officer','${org}'),('${outsider}','admin','${other}');
      INSERT INTO public.service_agreements VALUES('${org}','${client}',NULL,'operational');
      INSERT INTO public.canonical_people VALUES('${person}','Synthetic Holder','syntheticholder','active','verified',NULL);
      INSERT INTO public.person_records VALUES('${record}','${org}','Synthetic Holder',
        '{"profile_details":{"phone":"PRIVATE_PHONE","email":"PRIVATE_EMAIL","address":"PRIVATE_ADDRESS","city":"PRIVATE_CITY"}}','verified');
      INSERT INTO public.canonical_person_links VALUES('${person}','${org}','person_records','${record}');
      INSERT INTO public.person_record_aliases VALUES('${record}','${org}','Synthetic Alias','syntheticalias',true,now());
      INSERT INTO public.canonical_vehicles VALUES('${vehicle}','ABC123','Test','Vehicle','Blue');
      INSERT INTO public.person_permits(id,organization_id,canonical_person_id,permit_number,status,date_from,date_to,
        contact_email,contact_phone,address_text,firearm_licence_number,forest_areas,conditions) VALUES
        ('${permit}','${org}','${person}','TEST100','active',current_date-10,current_date+10,
         'PRIVATE_EMAIL','PRIVATE_PHONE','PRIVATE_ADDRESS','PRIVATE_LICENCE',ARRAY['Test Forest'],'Stay on marked roads'),
        ('${id(25)}','${other}','${person}','FOREIGN100','active',current_date-10,current_date+10,
         'FOREIGN_EMAIL','FOREIGN_PHONE','FOREIGN_ADDRESS','FOREIGN_LICENCE',NULL,NULL);
      INSERT INTO public.person_permit_vehicles VALUES('${permit}','${vehicle}');
      INSERT INTO public.notices(id,organization_id,person_id,notice_type,status,issued_at,expires_at) VALUES
        ('${id(26)}','${client}','${person}','trespass','issued',now()-interval '1 day',now()+interval '2 years');
      INSERT INTO public.entity_links VALUES('${id(27)}','${org}','person','${person}','vehicle','${vehicle}','owner',
        true,'{"person_record_id":"${record}","basis":"PRIVATE_BASIS","nzta_restricted":true}',now(),NULL,now(),'${admin}');
      INSERT INTO public.person_identity_documents VALUES('${document}','{"approved":{"address":"PRIVATE_NZTA_ADDRESS"}}');
      INSERT INTO public.vehicle_identity_checks VALUES('${person}','${vehicle}','${org}','${document}',now());

      ${actor(officer)}
      SELECT pg_temp.check(NOT public.can_search_people(),'off by default');
      SELECT pg_temp.refuses($q$SELECT public.search_people('synthetic')$q$,'authorization required');
      SELECT pg_temp.refuses($q$SELECT public.set_person_search_access('${officer}',true,'self grant')$q$,'administrator required');
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.person_records),'raw contacts blocked');
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.person_permits_fieldwork),'unapproved holder view blocked');
      RESET ROLE;
      ${actor(admin)}
      SELECT public.set_person_search_access('${officer}',true,'Approved permit and trespass duties');
      SELECT pg_temp.refuses($q$SELECT public.set_person_search_access('${admin}',true,'self grant')$q$,'own person-search');
      SELECT pg_temp.refuses($q$SELECT public.set_person_search_access('${officer}',true,' ')$q$,'reason is required');
      SELECT pg_temp.refuses($q$SELECT public.set_person_search_access('${officer}',NULL,'invalid')$q$,'choice is required');
      SELECT pg_temp.check(public.search_people('TEST100')->0->'permits'->0->>'contact_phone'='PRIVATE_PHONE','admin receives contacts');
      RESET ROLE;
      SELECT pg_temp.check((SELECT level='view' FROM public.staff_area_grants WHERE user_id='${officer}'),'read-only grant');
      SELECT pg_temp.check((SELECT count(*)=1 FROM public.audit_log WHERE action='person_search_access_granted'),'audit retained');
      ${actor(officer)}
      SELECT pg_temp.check(public.can_search_people('${client}'),'existing agreement scope retained');
      SELECT pg_temp.check(NOT public.can_search_people('${other}'),'no new tenant reach');
      SELECT pg_temp.check(jsonb_array_length(public.search_people('Synthetic Alias'))=1,'alias lookup');
      SELECT pg_temp.check(jsonb_array_length(public.search_people('TEST100'))=1,'exact permit lookup');
      SELECT pg_temp.check(public.search_people('FOREIGN100')='[]'::jsonb,'foreign permit denied');
      SELECT pg_temp.check(public.search_people('TEST100')->0->'notices'->0->>'notice_type'='trespass','client notice available');
      SELECT pg_temp.check(public.search_people('TEST100')->0->'permits'->0->'vehicles'->0->>'plate_number'='ABC123','permit vehicle available');
      SELECT pg_temp.check(public.search_people('TEST100')::text NOT LIKE '%PRIVATE_%','search redacts every private sentinel');
      SELECT pg_temp.check((SELECT count(*)=1 FROM public.person_permits_fieldwork),'officer can actually read permit view');
      SELECT pg_temp.check((SELECT bool_and(contact_email IS NULL AND contact_phone IS NULL AND address_text IS NULL)
        FROM public.person_permits_fieldwork),'view masks contacts');
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.person_permits),'no base-table backdoor');
      SELECT pg_temp.check((SELECT bool_and(locality IS NULL) FROM public.find_person_matches('${org}','Synthetic Holder')),'matcher masks locality');
      SELECT pg_temp.refuses($q$SELECT public.find_person_matches('${org}',p_phone=>'123456789')$q$,'Contact-detail matching');
      RESET ROLE;
      INSERT INTO public.staff_area_grants(user_id,scope_org_id,area,level,status)
        VALUES('${officer}','${org}','vehicle_owner_identity','manage','active');
      ${actor(officer)}
      SELECT pg_temp.check(public.search_people('TEST100')->0->>'nzta_authorised'='true','NZTA stays independently authorized');
      SELECT pg_temp.check(public.search_people('TEST100')::text NOT LIKE '%PRIVATE_%','NZTA cannot bypass contact redaction');
      SELECT pg_temp.check((SELECT display_name='Synthetic Holder' AND phone IS NULL AND email IS NULL
        AND address IS NULL AND locality IS NULL AND basis IS NULL FROM public.get_vehicle_owner_links('${org}','${vehicle}')),'NZTA owner projection');
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.entity_links),'raw evidence backdoor blocked');
      RESET ROLE;
      ${actor(desk)}
      SELECT pg_temp.check(public.search_people('TEST100')->0->'permits'->0->>'address_text'='PRIVATE_ADDRESS','admin officer contacts authorized');
      SELECT pg_temp.check((SELECT count(*)=1 FROM public.person_records),'admin officer profile read');
      SELECT pg_temp.refuses($q$SELECT public.set_person_search_access('${officer}',true,'not an admin')$q$,'administrator required');
      RESET ROLE;
      ${actor(outsider)}
      SELECT pg_temp.refuses($q$SELECT public.set_person_search_access('${officer}',true,'cross tenant')$q$,'administrator required');
      RESET ROLE;
      ${actor(admin)}
      SELECT public.set_person_search_access('${officer}',false,'Duties ended');
      RESET ROLE;
      ${actor(officer)}
      SELECT pg_temp.check(NOT public.can_search_people(),'revocation effective with unchanged JWT');
      SELECT pg_temp.refuses($q$SELECT public.search_people('TEST100')$q$,'authorization required');
      RESET ROLE;
      INSERT INTO public.access_presets VALUES('${id(30)}','{"person_search":"view"}');
      INSERT INTO public.preset_assignments VALUES('${officer}','${org}','${id(30)}','active');
      ${actor(admin)}
      SELECT pg_temp.check(public.get_person_search_access('${officer}')->>'via_preset'='true','inherited authorization disclosed');
      RESET ROLE;
      ${actor(officer)}
      SELECT pg_temp.check(public.can_search_people(),'explicit preset authorizes read');
      RESET ROLE;
      UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${officer}';
      ${actor(officer)}
      SELECT pg_temp.check(NOT public.can_search_people(),'inactive denied despite preset and NZTA');
      SELECT pg_temp.check((SELECT count(*)=0 FROM public.person_permits_fieldwork),'inactive view empty');
      RESET ROLE;
      SET ROLE anon;
      SELECT pg_temp.refuses($q$SELECT public.search_people('TEST100')$q$,'permission denied');
      SELECT pg_temp.refuses($q$SELECT public.read_person_permits_fieldwork()$q$,'permission denied');
      RESET ROLE;
    `;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres'], {
        input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) { throw new Error(`${error.message}\n${error.stderr ?? ''}`); }
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
