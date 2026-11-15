'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const migrationDir = path.resolve(__dirname, '../supabase/migrations');
const original = fs.readFileSync(path.join(migrationDir, '20261109200000_location_house_checkpoints.sql'), 'utf8');
const repair = fs.readFileSync(path.join(migrationDir, '20261115091507_fix_location_checkpoint_output_collisions.sql'), 'utf8');
const tier = fs.readFileSync(path.join(migrationDir, '20260915100000_checkpoint_tier_workbench.sql'), 'utf8');
const definition = (source, name) => {
  const found = source.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
  assert.ok(found, name);
  return found[0];
};

test('location checkpoint reads and edits avoid output-column collisions while preserving authority and receipts', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async () => {
  const name = `fcm-checkpoint-recovery-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sql = input => docker(['exec', '-i', name, 'psql', '-h', '127.0.0.1',
    '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], input).trim();
  const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
  const [provider, otherProvider, admin, officer, inactive, house, otherHouse, site, zone, checkpoint, request]
    = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(id);
  const runAs = (actor, statement) => sql(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub='${actor}'; ${statement}; COMMIT;`);
  const fails = (actor, statement, pattern) => assert.throws(
    () => runAs(actor, statement),
    error => pattern.test(String(error.stderr ?? error.message)),
  );
  const read = `SELECT json_agg(q) FROM public.get_location_patrol_checkpoints('${house}') q`;
  const manage = (action, extra = '') => `SELECT row_to_json(q)
    FROM public.manage_location_patrol_checkpoint(
      p_client_request_id=>'${request}',p_action=>'${action}',p_organization_id=>'${provider}',
      p_location_id=>'${house}',p_checkpoint_id=>'${checkpoint}',p_client_site_id=>'${site}'${extra}) q`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']);
        ready = true;
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    assert.ok(ready, 'Disposable PostgreSQL became ready');
    sql(`
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      CREATE TABLE public.user_profiles(id uuid PRIMARY KEY,organization_id uuid,role text,deactivated_at timestamptz);
      CREATE TABLE public.locations(id uuid PRIMARY KEY,organization_id uuid);
      CREATE TABLE public.client_sites(id uuid PRIMARY KEY,location_id uuid,client_organization_id uuid);
      CREATE TABLE public.location_zones(id uuid PRIMARY KEY,location_id uuid,organization_id uuid);
      CREATE TABLE public.patrol_checkpoints(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid,location_id uuid,client_site_id uuid,
        zone_id uuid,name text,description text,gps_lat double precision,gps_lng double precision,
        radius_meters integer,qr_code text,active boolean DEFAULT true,client_request_id uuid,
        checkpoint_verification text DEFAULT 'unverified',checkpoint_verified_by uuid,checkpoint_verified_at timestamptz,
        UNIQUE(organization_id,client_request_id));
      CREATE TABLE public.org_geofence_config(organization_id uuid,config_value integer,config_key text,zone_type text);
      CREATE TABLE public.geofence_boundary_history(entity_type text,entity_id uuid,boundary geometry,
        boundary_source text,verification_state text,changed_by uuid,changed_via text,change_reason text,version integer);
      CREATE TABLE public.audit_log(organization_id uuid,actor_user_id uuid,action text,target_table text,target_id uuid,metadata jsonb);
      CREATE FUNCTION public.is_admin_for_org(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=auth.uid()
          AND p.organization_id=$1 AND p.role IN('admin','admin_officer') AND p.deactivated_at IS NULL) $$;
      CREATE FUNCTION public.crm_actor_can_manage_location(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1='${house}'::uuid AND public.is_admin_for_org('${provider}') $$;
      CREATE FUNCTION public.crm_actor_can_manage_account(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
        SELECT $1='${provider}'::uuid AND public.is_admin_for_org('${provider}') $$;
      CREATE FUNCTION public._gbh_next_version(text,uuid) RETURNS integer LANGUAGE sql AS $$
        SELECT coalesce(max(h.version),0)+1 FROM public.geofence_boundary_history h
          WHERE h.entity_type=$1 AND h.entity_id=$2 $$;
      ${definition(tier, 'patrol_checkpoints_geometry_guard')}
      CREATE TRIGGER checkpoint_geometry BEFORE INSERT OR UPDATE ON public.patrol_checkpoints
        FOR EACH ROW EXECUTE FUNCTION public.patrol_checkpoints_geometry_guard();
      INSERT INTO public.user_profiles VALUES
        ('${admin}','${provider}','admin',NULL),('${officer}','${provider}','officer',NULL),
        ('${inactive}','${provider}','admin',now());
      INSERT INTO public.locations VALUES ('${house}','${provider}'),('${otherHouse}','${otherProvider}');
      INSERT INTO public.client_sites VALUES ('${site}','${house}','${provider}');
      INSERT INTO public.location_zones VALUES ('${zone}','${house}','${provider}');
      INSERT INTO public.org_geofence_config VALUES ('${provider}',6,'checkpoint_radius_m',NULL);
      INSERT INTO public.patrol_checkpoints(id,organization_id,location_id,client_site_id,name,gps_lat,gps_lng,radius_meters)
        VALUES ('${checkpoint}','${provider}','${house}','${site}','Existing',-40.1234,175.1234,6);
      INSERT INTO public.patrol_checkpoints(organization_id,client_site_id,name,radius_meters)
        VALUES ('${provider}','${site}','Legacy site',6);
      INSERT INTO public.patrol_checkpoints(organization_id,zone_id,name,radius_meters)
        VALUES ('${provider}','${zone}','Legacy zone',6);
      INSERT INTO public.patrol_checkpoints(organization_id,location_id,name,radius_meters)
        VALUES ('${otherProvider}','${house}','Other custodian',6);
      ${definition(original, 'get_location_patrol_checkpoints')}
      ${definition(original, 'manage_location_patrol_checkpoint')}
      REVOKE ALL ON FUNCTION public.get_location_patrol_checkpoints(uuid) FROM PUBLIC,anon;
      GRANT EXECUTE ON FUNCTION public.get_location_patrol_checkpoints(uuid) TO authenticated,service_role;
      REVOKE ALL ON FUNCTION public.manage_location_patrol_checkpoint(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,double precision,double precision,integer,text) FROM PUBLIC,anon;
      GRANT EXECUTE ON FUNCTION public.manage_location_patrol_checkpoint(uuid,text,uuid,uuid,uuid,uuid,uuid,text,text,double precision,double precision,integer,text) TO authenticated,service_role;
    `);
    fails(admin, read, /column reference "id" is ambiguous/);
    fails(admin, manage('deactivate'), /column reference "id" is ambiguous/);
    const acls = () => sql(`SELECT jsonb_object_agg(proname,proacl::text) FROM pg_proc
      WHERE pronamespace='public'::regnamespace
        AND proname IN('get_location_patrol_checkpoints','manage_location_patrol_checkpoint')`);
    const before = acls();
    sql(`BEGIN; ${repair} COMMIT;`);
    assert.equal(acls(), before, 'Existing execute ACLs remain unchanged');
    const rows = JSON.parse(runAs(admin, read));
    assert.deepEqual(rows.map(row => row.name), ['Existing', 'Legacy site', 'Legacy zone']);
    assert.ok(rows.every(row => row.location_id === house));
    fails(officer, read, /Active authorised location administrator required/);
    fails(inactive, read, /Active authorised location administrator required/);
    fails(admin, `SELECT * FROM public.get_location_patrol_checkpoints('${otherHouse}')`,
      /Active authorised location administrator required/);
    assert.equal(JSON.parse(runAs(admin, manage('deactivate'))).active, false);
    assert.equal(JSON.parse(runAs(admin, manage('reactivate'))).active, true);
    assert.equal(JSON.parse(runAs(admin, manage('update', ",p_name=>'Renamed'"))).name, 'Renamed');
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE target_id='${checkpoint}'`), '3');
    fails(officer, manage('deactivate'), /Active authorised location administrator required/);
    fails(inactive, manage('deactivate'), /Active authorised location administrator required/);

    const createSite = manage('create', ",p_name=>'New site checkpoint',p_gps_lat=>-40.1234,p_gps_lng=>175.1234");
    const receipt = JSON.parse(runAs(admin, createSite));
    assert.equal(receipt.created, true);
    assert.equal(receipt.radius_meters, 6);
    assert.equal(receipt.checkpoint_verification, 'unverified');
    assert.equal(receipt.history_version, 1);
    const replay = JSON.parse(runAs(admin, createSite));
    assert.equal(replay.id, receipt.id);
    assert.equal(replay.created, false);
    assert.equal(sql(`SELECT count(*) FROM public.audit_log WHERE target_id='${receipt.id}'`), '1');
    const zoneReceipt = JSON.parse(runAs(admin, `SELECT row_to_json(q) FROM public.manage_location_patrol_checkpoint(
      p_client_request_id=>'${id(12)}',p_action=>'create',p_organization_id=>'${provider}',
      p_location_id=>'${house}',p_zone_id=>'${zone}',p_name=>'Zone checkpoint',
      p_gps_lat=>-40.1234,p_gps_lng=>175.1234) q`));
    assert.equal(zoneReceipt.zone_id, zone);
    assert.equal(zoneReceipt.client_site_id, null);
    sql(`UPDATE public.patrol_checkpoints SET checkpoint_verification='verified',
      checkpoint_verified_by='${admin}',checkpoint_verified_at=now() WHERE id='${checkpoint}'`);
    const moved = JSON.parse(runAs(admin, manage('update', ',p_gps_lat=>-40.1235,p_gps_lng=>175.1234')));
    assert.equal(moved.geometry_changed, true);
    assert.equal(moved.checkpoint_verification, 'unverified');
    assert.equal(moved.history_version, 1);
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
