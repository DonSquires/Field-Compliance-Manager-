const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('vehicle profile lets any org admin correct audited shared facts, preserves notes and restricts shared private media', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 90000,
}, () => {
  const name = `fcm-vehicle-profile-${process.pid}`;
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
    const schema = fs.readFileSync(path.resolve(__dirname, '../supabase/schema.sql'), 'utf8');
    const definition = start => schema.slice(schema.indexOf(start), schema.indexOf('$function$;', schema.indexOf(start)) + 12);
    const table = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS "public"."canonical_vehicles"'),
      schema.indexOf('COMMENT ON TABLE "public"."canonical_vehicles"'));
    const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261020140000_vehicle_profile_details_and_photos.sql'), 'utf8');
    const anyOrgMigration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261020170000_vehicle_profile_any_org_audited.sql'), 'utf8');
    const sql = `
CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT auth.uid()=md5('admin')::uuid AND $1=md5('org')::uuid
$$;
CREATE FUNCTION is_grand_master() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION org_access_allowed(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT auth.uid()=md5('admin')::uuid AND $1=md5('org')::uuid
$$;
CREATE FUNCTION normalize_plate_number(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper(regexp_replace($1,'[^A-Za-z0-9]','','g')) $$;
CREATE TABLE organizations(id uuid PRIMARY KEY,name text);
CREATE TABLE user_profiles(id uuid PRIMARY KEY);
${table}
ALTER TABLE canonical_vehicles ADD PRIMARY KEY(id);
CREATE TABLE canonical_vehicle_links(canonical_vehicle_id uuid, source_system text,source_table text,source_key text,metadata jsonb,
 UNIQUE(source_system,source_table,source_key));
CREATE TABLE cctv_entity_observations(canonical_vehicle_id uuid,organization_id uuid);
CREATE TABLE observations(canonical_vehicle_id uuid,reader_id uuid,organization_id uuid);
ALTER TABLE observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY observation_read ON observations FOR SELECT TO authenticated USING(reader_id=auth.uid());
CREATE TABLE audit_log(organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
CREATE FUNCTION ensure_canonical_vehicle(text,text,text,text,text,text,timestamptz) RETURNS uuid LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Must edit existing identity'; END $$;
${definition('CREATE OR REPLACE FUNCTION "public"."jsonb_object_length"')}
${definition('CREATE OR REPLACE FUNCTION "public"."manage_identity_vehicle"')}
CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
CREATE TABLE storage.objects(bucket_id text,name text,metadata jsonb,PRIMARY KEY(bucket_id,name));
CREATE FUNCTION storage.foldername(text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT (string_to_array($1,'/'))[1:array_length(string_to_array($1,'/'),1)-1] $$;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA public,auth,storage TO authenticated;
GRANT SELECT ON observations TO authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;
${migration}
${anyOrgMigration}
INSERT INTO organizations VALUES(md5('org')::uuid,'Test Org');
INSERT INTO user_profiles VALUES(md5('admin')::uuid),(md5('reader')::uuid),(md5('outsider')::uuid);
INSERT INTO canonical_vehicles(id,plate_number,make,org_notes) VALUES
 (md5('vehicle')::uuid,'ABC123','Original',jsonb_build_object(md5('org')::uuid::text,jsonb_build_object('text','Keep these notes'))),
 (md5('shared')::uuid,'SHARED','Shared',jsonb_build_object(md5('org')::uuid::text,jsonb_build_object('text','Own'),'other',jsonb_build_object('text','Other'))),
 (md5('unrelated')::uuid,'OTHER','Unrelated','{}'),
 (md5('observed')::uuid,'OBS123','Observed','{}'),
 (md5('observed-shared')::uuid,'OBS456','Observed shared','{}');
INSERT INTO observations VALUES
 (md5('vehicle')::uuid,md5('reader')::uuid,md5('org')::uuid),
 (md5('observed')::uuid,md5('admin')::uuid,md5('org')::uuid),
 (md5('observed-shared')::uuid,md5('admin')::uuid,md5('org')::uuid),
 (md5('observed-shared')::uuid,md5('reader')::uuid,md5('other-org')::uuid);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',md5('admin'),false);
SELECT update_vehicle_profile_details(md5('org')::uuid,md5('vehicle')::uuid,
 '{"make":"Toyota","colour":"Blue","year":"2020","rego_expiry":"2027-01-01"}','Human source review');
SELECT update_vehicle_profile_details(md5('org')::uuid,md5('observed')::uuid,
 '{"colour":"Green","wof_expiry":"2020-01-01"}','Own observation');
SELECT update_vehicle_profile_details(md5('org')::uuid,md5('observed-shared')::uuid,'{"make":"Changed"}','Cross-org observed correction');
SELECT update_vehicle_profile_details(md5('org')::uuid,md5('shared')::uuid,'{"make":"Changed"}','Shared vehicle correction');
SELECT update_vehicle_profile_details(md5('org')::uuid,md5('unrelated')::uuid,'{"make":"Changed"}','Unobserved vehicle correction');
DO $$ BEGIN
 IF (update_vehicle_profile_details(md5('org')::uuid,md5('vehicle')::uuid,'{"make":"Toyota"}','No-op')->>'changed')::boolean THEN
   RAISE EXCEPTION 'Unchanged save reported as a change';
 END IF;
 BEGIN
   PERFORM update_vehicle_profile_details(md5('org')::uuid,md5('vehicle')::uuid,'{"plate_number":"CHANGE"}','Invalid');
   RAISE EXCEPTION 'Unexpected allowed identity field';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Unsupported vehicle profile fields' THEN RAISE; END IF; END;
 BEGIN
   PERFORM update_vehicle_profile_details(md5('org')::uuid,md5('vehicle')::uuid,'{"year":"1800"}','Invalid');
   RAISE EXCEPTION 'Unexpected allowed year';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Enter a valid vehicle year' THEN RAISE; END IF; END;
 BEGIN
   PERFORM update_vehicle_profile_details(md5('org')::uuid,md5('vehicle')::uuid,'{"make":"x"}','  ');
   RAISE EXCEPTION 'Unexpected edit without reason';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'A reason is required for the identity audit trail' THEN RAISE; END IF; END;
END $$;
INSERT INTO storage.objects VALUES('vehicle-profile-photos',
 md5('org')::uuid::text||'/'||md5('admin')::uuid::text||'/'||md5('vehicle')::uuid::text||'/11111111-1111-4111-8111-111111111111.webp',
 '{"mimetype":"image/webp","size":100}');
SELECT set_vehicle_profile_photo(md5('org')::uuid,md5('vehicle')::uuid,
 md5('org')::uuid::text||'/'||md5('admin')::uuid::text||'/'||md5('vehicle')::uuid::text||'/11111111-1111-4111-8111-111111111111.webp',
 repeat('a',64),'Reviewed vehicle photo');
SELECT set_vehicle_profile_photo(md5('org')::uuid,md5('vehicle')::uuid,
 md5('org')::uuid::text||'/'||md5('admin')::uuid::text||'/'||md5('vehicle')::uuid::text||'/11111111-1111-4111-8111-111111111111.webp',
 repeat('a',64),'Retry');
DO $$ BEGIN
 BEGIN
  PERFORM set_vehicle_profile_photo(md5('org')::uuid,md5('vehicle')::uuid,'other/path.webp',repeat('a',64),'Invalid');
  RAISE EXCEPTION 'Unexpected foreign upload reference';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Invalid vehicle photo upload receipt' THEN RAISE; END IF; END;
 BEGIN
  PERFORM set_vehicle_profile_photo(md5('org')::uuid,md5('vehicle')::uuid,
    md5('org')::uuid::text||'/'||md5('admin')::uuid::text||'/'||md5('vehicle')::uuid::text||'/22222222-2222-4222-8222-222222222222.webp',
    repeat('a',64),'Missing upload');
  RAISE EXCEPTION 'Unexpected missing object reference';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM NOT LIKE 'Upload a JPEG%' THEN RAISE; END IF; END;
END $$;
SELECT set_config('request.jwt.claim.sub',md5('reader'),false);
DO $$ BEGIN
 IF (SELECT count(*) FROM vehicle_profile_photos)<>1 OR (SELECT count(*) FROM storage.objects)<>1 THEN RAISE EXCEPTION 'Authorised cross-org photo unavailable'; END IF;
 BEGIN
   PERFORM update_vehicle_profile_details(md5('org')::uuid,md5('vehicle')::uuid,'{}','Reader edit');
   RAISE EXCEPTION 'Unexpected reader edit';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'Identity registry administrator access required' THEN RAISE; END IF; END;
END $$;
SELECT set_config('request.jwt.claim.sub',md5('outsider'),false);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM vehicle_profile_photos) OR EXISTS(SELECT 1 FROM storage.objects) THEN RAISE EXCEPTION 'Private photo leaked to unrelated caller'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT make FROM canonical_vehicles WHERE plate_number='ABC123')<>'Toyota' THEN RAISE EXCEPTION 'Details not persisted'; END IF;
 IF (SELECT org_notes->(md5('org')::uuid::text)->>'text' FROM canonical_vehicles WHERE plate_number='ABC123')<>'Keep these notes' THEN RAISE EXCEPTION 'Org notes erased'; END IF;
 IF (SELECT count(*) FROM audit_log WHERE action='vehicle_profile_photo_set')<>1 THEN RAISE EXCEPTION 'Photo retry not idempotent'; END IF;
 IF (SELECT colour FROM canonical_vehicles WHERE plate_number='OBS123')<>'Green' THEN RAISE EXCEPTION 'Own observed vehicle edit failed'; END IF;
 IF (SELECT wof_status FROM canonical_vehicles WHERE plate_number='OBS123')<>'expired' THEN RAISE EXCEPTION 'Expiry status not persisted'; END IF;
 IF (SELECT count(*) FROM canonical_vehicles WHERE plate_number IN ('SHARED','OTHER','OBS456') AND make='Changed'
     AND details_updated_by_org_id=md5('org')::uuid AND details_updated_by=md5('admin')::uuid AND details_updated_at IS NOT NULL)<>3
   THEN RAISE EXCEPTION 'Any-org audited correction not persisted with provenance'; END IF;
 IF (SELECT count(*) FROM audit_log WHERE action='vehicle_profile_details_updated')<>5 THEN RAISE EXCEPTION 'Every change (and only changes) must be audited'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log WHERE action='vehicle_profile_details_updated' AND target_id=md5('unrelated')::uuid
   AND metadata->'changes'->'make'->>'before'='Unrelated' AND metadata->'changes'->'make'->>'after'='Changed')
   THEN RAISE EXCEPTION 'Before/after audit missing'; END IF;
 IF (SELECT details_updated_by_org_name FROM canonical_vehicle_public WHERE plate_number='OTHER')<>'Test Org' THEN RAISE EXCEPTION 'Public provenance missing'; END IF;
 IF has_table_privilege('authenticated','vehicle_profile_photos','UPDATE') OR has_function_privilege('anon','set_vehicle_profile_photo(uuid,uuid,text,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Direct or anonymous write granted'; END IF;
END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',md5('admin'),false);
INSERT INTO storage.objects VALUES('vehicle-profile-photos',
 md5('org')::uuid::text||'/'||md5('admin')::uuid::text||'/'||md5('vehicle')::uuid::text||'/22222222-2222-4222-8222-222222222222.webp',
 '{"mimetype":"image/webp","size":200}');
SELECT set_vehicle_profile_photo(md5('org')::uuid,md5('vehicle')::uuid,
 md5('org')::uuid::text||'/'||md5('admin')::uuid::text||'/'||md5('vehicle')::uuid::text||'/22222222-2222-4222-8222-222222222222.webp',
 repeat('b',64),'Replacement photo');
DO $$ DECLARE affected integer; BEGIN
 UPDATE storage.objects SET metadata='{}'; GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'Photo object overwrite allowed'; END IF;
 DELETE FROM storage.objects; GET DIAGNOSTICS affected=ROW_COUNT;
 IF affected<>0 THEN RAISE EXCEPTION 'Photo object deletion allowed'; END IF;
 IF (SELECT count(*) FROM storage.objects)<>1 THEN RAISE EXCEPTION 'Superseded photo still disclosed'; END IF;
END $$;
RESET ROLE;
DO $$ BEGIN
 IF (SELECT count(*) FROM storage.objects)<>2 THEN RAISE EXCEPTION 'Original photo lost'; END IF;
 IF NOT EXISTS(SELECT 1 FROM audit_log WHERE action='vehicle_profile_photo_set'
   AND metadata->>'previous_sha256'=repeat('a',64) AND metadata->>'sha256'=repeat('b',64))
   THEN RAISE EXCEPTION 'Replacement audit provenance missing'; END IF;
END $$;
`;
    try {
      execFileSync('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
        input: sql, encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new Error(`Vehicle profile fixture failed:\n${error.stderr?.toString() ?? error.message}`);
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 10000 });
  }
});
