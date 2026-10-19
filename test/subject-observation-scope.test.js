const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('all-observation summaries and drilldowns preserve subject access boundaries', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
  timeout: 90000,
}, () => {
  const name = `fcm-subject-scope-${process.pid}`;
  const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    docker(['run', '-d', '--rm', '--network', 'none', '--memory', '512m', '--cpus', '1',
      '--name', name, '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { timeout: 2000 }).status === 0) { ready = true; break; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    assert.equal(ready, true);
    const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261020100000_all_authorised_subject_observations.sql'), 'utf8');
    const accessMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261008040000_scope_subjects_and_report_privacy.sql'), 'utf8');
    const accessFunction = accessMigration.slice(accessMigration.indexOf('CREATE OR REPLACE FUNCTION private.rnm_admin_for_organization'),
      accessMigration.indexOf('CREATE OR REPLACE FUNCTION public.can_manage_r_and_m_identity'));
    const sql = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE TABLE user_profiles(id uuid, organization_id uuid, employer_organization_id uuid, role text, deactivated_at timestamptz);
CREATE FUNCTION get_descendant_organizations(uuid) RETURNS uuid[] LANGUAGE sql AS $$
  SELECT CASE WHEN $1='e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid THEN ARRAY[md5('branch')::uuid,md5('other-branch')::uuid] ELSE '{}'::uuid[] END
$$;
CREATE FUNCTION is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM public.user_profiles u WHERE u.id=auth.uid()
    AND (u.role='grand_master' OR u.organization_id='e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid OR u.organization_id=$1))
$$;
${accessFunction}
CREATE TABLE service_agreements(id uuid, provider_organization_id uuid, agreement_type text, invitation_status text);
CREATE TABLE service_agreement_locations(service_agreement_id uuid, zone_id uuid, site_id uuid, status text);
CREATE TABLE observations(id uuid DEFAULT gen_random_uuid(), organization_id uuid, plate_number text, canonical_vehicle_id uuid,
  observed_at timestamptz, zone_id uuid, site_id uuid, officer_id uuid, officer_notes text, is_compliant boolean,
  compliance_reason text, photo_url text, external_refs jsonb DEFAULT '{}', person_record_id uuid, canonical_person_id uuid);
CREATE TABLE cctv_entity_observations(id uuid DEFAULT gen_random_uuid(), organization_id uuid, candidate_plate text,
  canonical_vehicle_id uuid, observed_at timestamptz, zone_id uuid, site_id uuid, entity_kind text, review_state text,
  candidate_label text, attributes jsonb, evidence_item_id uuid, person_record_id uuid, canonical_person_id uuid);
CREATE TABLE canonical_vehicles(id uuid, plate_number text, make text, model text, year integer, colour text, body_type text,
  fuel_type text, registered_owner_name text, last_seen_at timestamptz);
CREATE VIEW canonical_vehicle_public AS SELECT id,plate_number,make,model,year,colour FROM canonical_vehicles;
CREATE TABLE canonical_people(id uuid, display_name text, review_state text, status text);
CREATE VIEW canonical_person_public AS SELECT * FROM canonical_people;
CREATE TABLE person_records(id uuid, organization_id uuid, review_state text);
CREATE TABLE canonical_person_links(source_table text, source_id uuid, organization_id uuid, canonical_person_id uuid);
CREATE TABLE evidence_items(id uuid, organization_id uuid, metadata jsonb, captured_at timestamptz);
CREATE TABLE location_events(id uuid DEFAULT gen_random_uuid(), organization_id uuid, occurred_at timestamptz,
  zone_id uuid, client_site_id uuid, external_ref text, payload jsonb);
CREATE TABLE audit_log(metadata jsonb, created_at timestamptz, target_table text, target_id uuid, action text);
${migration}
INSERT INTO user_profiles VALUES
  (md5('root-admin')::uuid,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13',null,'admin',null),
  (md5('branch-admin')::uuid,md5('branch')::uuid,null,'admin',null),
  (md5('officer')::uuid,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13',null,'officer',null),
  (md5('foreign-admin')::uuid,md5('foreign')::uuid,null,'admin',null),
  (md5('disabled')::uuid,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13',null,'admin',now());
INSERT INTO service_agreements VALUES
  (md5('a')::uuid,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13','operational','accepted'),
  (md5('b')::uuid,md5('branch')::uuid,'operational','accepted'),
  (md5('pending')::uuid,'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13','operational','pending'),
  (md5('foreign')::uuid,md5('foreign')::uuid,'operational','accepted');
INSERT INTO service_agreement_locations VALUES
  (md5('a')::uuid,md5('zone-a')::uuid,null,'active'),
  (md5('a')::uuid,md5('zone-a')::uuid,null,'active'),
  (md5('b')::uuid,md5('zone-b')::uuid,null,'active');
INSERT INTO canonical_vehicles(id,plate_number,make) VALUES(md5('vehicle')::uuid,'RJ198','Fixture');
INSERT INTO canonical_people VALUES(md5('person')::uuid,'Verified fixture','verified','active');
INSERT INTO person_records
  SELECT md5(org::text)::uuid,org,'verified' FROM unnest(ARRAY[
    'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,md5('branch')::uuid,md5('other-branch')::uuid,md5('foreign')::uuid
  ]) org;
INSERT INTO canonical_person_links SELECT 'person_records',id,organization_id,md5('person')::uuid FROM person_records;
INSERT INTO observations(organization_id,plate_number,canonical_vehicle_id,observed_at,zone_id,officer_id,person_record_id,canonical_person_id)
SELECT org,'RJ198',md5('vehicle')::uuid,now()-interval '1 day',zone,md5(org::text)::uuid,md5(org::text)::uuid,md5('person')::uuid
FROM (VALUES
  ('e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'::uuid,md5('zone-a')::uuid),
  (md5('branch')::uuid,md5('zone-b')::uuid),
  (md5('other-branch')::uuid,md5('zone-c')::uuid),
  (md5('foreign')::uuid,md5('zone-x')::uuid),
  (md5('branch')::uuid,null::uuid)
) fixture(org,zone);
INSERT INTO observations(organization_id,plate_number,observed_at) VALUES
  (md5('branch')::uuid,'FUT123',now()+interval '1 day'),
  (md5('branch')::uuid,'SINGLE1',now()-interval '1 day');
INSERT INTO cctv_entity_observations(organization_id,candidate_plate,observed_at,zone_id,entity_kind,review_state)
VALUES (md5('branch')::uuid,'RJ198',now()-interval '1 day',md5('zone-b')::uuid,'vehicle','accepted'),
  (md5('branch')::uuid,'REJECT1',now()-interval '1 day',md5('zone-b')::uuid,'vehicle','rejected');
INSERT INTO cctv_entity_observations(organization_id,observed_at,zone_id,entity_kind,review_state,person_record_id,canonical_person_id)
VALUES(md5('branch')::uuid,now()-interval '1 day',md5('zone-b')::uuid,'person','accepted',md5(md5('branch')::uuid::text)::uuid,md5('person')::uuid);
INSERT INTO location_events(organization_id,occurred_at,payload)
VALUES(md5('branch')::uuid,now()-interval '1 day','{"comments":"ABC456"}'),
  (md5('foreign')::uuid,now()-interval '1 day','{"comments":"XYZ789"}');

SELECT set_config('request.jwt.claim.sub',md5('root-admin'),false);
DO $$
BEGIN
  IF (SELECT count(*) FROM search_vehicle_registrations('RJ%9%8')) <> 1 THEN RAISE EXCEPTION 'Wildcard lookup duplicated registry/observation identity'; END IF;
  IF (SELECT count(*) FROM search_vehicle_registrations('%INGLE%')) <> 1 THEN RAISE EXCEPTION 'Observation-only registration not discoverable'; END IF;
  IF (SELECT count(*) FROM search_vehicle_registrations('%j%%8')) <> 1 THEN RAISE EXCEPTION 'Case-insensitive repeated wildcard failed'; END IF;
  IF (SELECT sightings FROM list_repeat_vehicle_subjects_for_agreement(null,2) WHERE plate='RJ198') IS DISTINCT FROM 5::bigint THEN RAISE EXCEPTION 'All scope did not combine places and unmapped observations exactly once'; END IF;
  IF (SELECT places FROM list_repeat_vehicle_subjects_for_agreement(null,2) WHERE plate='RJ198') IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'Place trend count incorrect'; END IF;
  IF (SELECT sightings FROM list_repeat_vehicle_subjects_for_agreement(md5('a')::uuid,1) WHERE plate='RJ198') IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'Agreement scope changed or duplicate mapping inflated count'; END IF;
  IF (SELECT count(*) FROM list_repeat_vehicle_subjects_for_agreement(null,1)) <> 2 THEN RAISE EXCEPTION 'Singleton, future or rejected handling incorrect'; END IF;
  IF (SELECT count(*) FROM list_vehicle_subject_history_for_agreement('RJ198',null)) <> 5 THEN RAISE EXCEPTION 'Vehicle history scope incorrect'; END IF;
  IF (SELECT count(*) FROM get_vehicle_subject_details_for_agreement('RJ198',null)) <> 1 THEN RAISE EXCEPTION 'Vehicle details missing'; END IF;
  IF (SELECT sightings FROM list_repeat_person_subjects_for_agreement(null,1)) IS DISTINCT FROM 5::bigint THEN RAISE EXCEPTION 'Person all scope incorrect'; END IF;
  IF (SELECT sightings FROM list_repeat_person_subjects_for_agreement(md5('a')::uuid,1)) IS DISTINCT FROM 1::bigint THEN RAISE EXCEPTION 'Person agreement scope changed'; END IF;
  IF (SELECT count(*) FROM list_person_subject_history_for_agreement(md5('person')::uuid,null)) <> 5 THEN RAISE EXCEPTION 'Person history scope incorrect'; END IF;
  IF (SELECT count(*) FROM list_vehicle_subject_identifications('RJ198',null)) <> 1 THEN RAISE EXCEPTION 'Identity projection missing'; END IF;
  IF (SELECT count(*) FROM list_unlinked_plate_mentions_for_agreement(null)) <> 1 THEN RAISE EXCEPTION 'Unmapped or foreign mentions handling incorrect'; END IF;
  IF EXISTS(SELECT 1 FROM list_repeat_vehicle_subjects_for_agreement(null,1,now(),now()+interval '1 day')) THEN RAISE EXCEPTION 'Period filter lost'; END IF;
  IF (SELECT count(*) FROM list_repeat_vehicle_subjects_for_agreement(null,1,null,null,1,1)) <> 1 THEN RAISE EXCEPTION 'Pagination lost'; END IF;
END $$;

SELECT set_config('request.jwt.claim.sub',md5('branch-admin'),false);
DO $$
BEGIN
  IF (SELECT sightings FROM list_repeat_vehicle_subjects_for_agreement(null,1) WHERE plate='RJ198') IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'Branch admin saw sibling/root observations'; END IF;
  IF (SELECT count(*) FROM list_vehicle_subject_history_for_agreement('RJ198',null)) <> 3 THEN RAISE EXCEPTION 'Branch history widened'; END IF;
  IF (SELECT sightings FROM list_repeat_person_subjects_for_agreement(null,1)) IS DISTINCT FROM 3::bigint THEN RAISE EXCEPTION 'Branch person scope widened'; END IF;
END $$;
DO $$
DECLARE actor text; denied boolean; agreement uuid;
BEGIN
  FOREACH actor IN ARRAY ARRAY['officer','foreign-admin','disabled','anonymous'] LOOP
    PERFORM set_config('request.jwt.claim.sub',CASE WHEN actor='anonymous' THEN '' ELSE md5(actor) END,false);
    denied := false;
    BEGIN PERFORM * FROM list_repeat_vehicle_subjects_for_agreement(null);
    EXCEPTION WHEN raise_exception THEN denied := true; END;
    IF NOT denied THEN RAISE EXCEPTION 'Unauthorised fixture could read: %',actor; END IF;
    denied := false;
    BEGIN PERFORM * FROM list_person_subject_history_for_agreement(md5('person')::uuid,null);
    EXCEPTION WHEN raise_exception THEN denied := true; END;
    IF NOT denied THEN RAISE EXCEPTION 'Unauthorised fixture could read person history: %',actor; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub',md5('root-admin'),false);
  FOREACH agreement IN ARRAY ARRAY[md5('foreign')::uuid,md5('pending')::uuid,md5('missing')::uuid] LOOP
    denied := false;
    BEGIN PERFORM * FROM list_repeat_vehicle_subjects_for_agreement(agreement);
    EXCEPTION WHEN raise_exception THEN denied := true; END;
    IF NOT denied THEN RAISE EXCEPTION 'Invalid agreement accepted'; END IF;
  END LOOP;
  IF has_function_privilege('anon','public.list_repeat_vehicle_subjects_for_agreement(uuid,integer,timestamptz,timestamptz,integer,integer)','EXECUTE')
     OR has_function_privilege('authenticated','private.subject_scope_organizations(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Function grants widened';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid='public.search_vehicle_registrations(text,integer)'::regprocedure) THEN
    RAISE EXCEPTION 'Registration discovery must use caller RLS';
  END IF;
END $$;
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT SELECT ON public.observations, public.user_profiles, public.canonical_vehicle_public TO authenticated;
CREATE POLICY fixture_observation_scope ON observations FOR SELECT TO authenticated
  USING(organization_id=(SELECT organization_id FROM public.user_profiles WHERE id=auth.uid()));
INSERT INTO observations(organization_id,plate_number,observed_at)
VALUES(md5('foreign')::uuid,'SECRET1',now());
INSERT INTO observations(organization_id,plate_number,observed_at)
SELECT md5('branch')::uuid,'BND'||n,now() FROM generate_series(1,60) n;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',md5('branch-admin'),false);
DO $$
DECLARE denied boolean;
BEGIN
  IF EXISTS(SELECT 1 FROM public.search_vehicle_registrations('%SECRET%')) THEN RAISE EXCEPTION 'Discovery bypassed observation RLS'; END IF;
  IF (SELECT count(*) FROM public.search_vehicle_registrations('%SINGLE%')) <> 1 THEN RAISE EXCEPTION 'Authorised observation-only discovery failed'; END IF;
  IF (SELECT count(*) FROM public.search_vehicle_registrations('BND%',500)) <> 51 THEN RAISE EXCEPTION 'Discovery cap lost'; END IF;
  IF (SELECT count(*) FROM public.search_vehicle_registrations('BND%',1)) <> 1 THEN RAISE EXCEPTION 'Discovery limit ignored'; END IF;
  denied := false;
  BEGIN PERFORM * FROM public.search_vehicle_registrations('%%');
  EXCEPTION WHEN raise_exception THEN denied := true; END;
  IF NOT denied THEN RAISE EXCEPTION 'Unbounded wildcard accepted'; END IF;
END $$;
RESET ROLE;
`;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
        input: sql, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Subject scope SQL fixture failed:\n${error.stderr?.toString() ?? error.message}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});
