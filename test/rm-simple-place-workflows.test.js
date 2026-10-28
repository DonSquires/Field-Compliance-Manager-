const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20261101170000_rm_simple_place_workflows.sql'), 'utf8');
const catalogFunction = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
};
const tables = ['organizations', 'user_profiles', 'service_agreements', 'service_agreement_locations',
  'service_agreement_modules', 'staff_branch_authorisations', 'canonical_places', 'canonical_place_links',
  'locations', 'client_sites', 'location_zones', 'audit_log', 'geofence_boundary_history',
  'org_engagements', 'jurisdiction_rule_sets', 'site_financial_config'];
const tableDDL = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('\n);', start) + 3)
    .replace(/,\n    "is_verification_point" boolean[^\n]*/, '');
};
const constraints = [...schema.matchAll(/ALTER TABLE ONLY "public"\."([^"]+)"\s+ADD CONSTRAINT[\s\S]*?;/g)]
  .filter(([sql, name]) => tables.includes(name) && !sql.includes('"verification_point_has_geometry"')
    && (!sql.includes('FOREIGN KEY') || tables.includes(sql.match(/REFERENCES "public"\."([^"]+)"/)?.[1])))
  .map(([sql]) => sql).join('\n');

test('reference points are excluded from rules and canonical perimeter promotion', () => {
  assert.equal((migration.match(/WHERE z.organization_id = p_org_id AND NOT z.is_verification_point/g) ?? []).length, 4);
  assert.equal((migration.match(/z.is_active AND NOT z.is_verification_point/g) ?? []).length, 2);
  assert.match(migration, /cp.id = l.canonical_place_id AND NOT NEW.is_verification_point/);
  assert.match(migration, /gps_with_manual_map_correction/);
  assert.match(migration, /'not_invited', 'transparency_only'/);
});

test('real PostGIS verifies client setup, field capture, isolation, retries and perimeter preservation', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-place-workflows-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
  const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const provider = id(1), other = id(2), officer = id(10), admin = id(11), adminOfficer = id(12), outsider = id(13), inactive = id(14);
  const actor = who => `RESET ROLE; SELECT set_config('request.jwt.claim.sub','${who}',false); SET ROLE authenticated;`;
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready, 'PostGIS test database ready');
    const setup = `
      CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $f$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      ${tables.map(tableDDL).join('\n')}
      ${constraints}
      ${['get_descendant_organizations', 'is_admin_for_org', 'crm_actor_can_manage_account', 'ensure_canonical_place',
        'canonical_place_for_house', 'address_match_key', 'tg_locations_place_identity', 'tg_client_sites_place_house',
        'tg_location_zones_place_house', 'manage_crm_site_profile', '_gbh_next_version', '_geofence_active_at',
        'autolink_client_site_service_agreement', 'sync_service_agreement_location_from_site', 'ensure_site_financial_config_from_site',
        'sync_client_sites_org_ids', 'tg_client_sites_inherit_canonical_boundary', 'tg_location_zones_inherit_canonical_boundary',
        'trg_location_zones_parent_same_org'].map(catalogFunction).join('\n')}
      CREATE TRIGGER place_identity BEFORE INSERT OR UPDATE ON public.locations FOR EACH ROW EXECUTE FUNCTION public.tg_locations_place_identity();
      CREATE TRIGGER site_house BEFORE INSERT OR UPDATE ON public.client_sites FOR EACH ROW EXECUTE FUNCTION public.tg_client_sites_place_house();
      CREATE TRIGGER zone_house BEFORE INSERT OR UPDATE ON public.location_zones FOR EACH ROW EXECUTE FUNCTION public.tg_location_zones_place_house();
      CREATE TRIGGER autolink BEFORE INSERT OR UPDATE ON public.client_sites FOR EACH ROW EXECUTE FUNCTION public.autolink_client_site_service_agreement();
      CREATE TRIGGER sync_org BEFORE INSERT OR UPDATE ON public.client_sites FOR EACH ROW EXECUTE FUNCTION public.sync_client_sites_org_ids();
      CREATE TRIGGER sync_agreement AFTER INSERT OR UPDATE OF service_agreement_id ON public.client_sites FOR EACH ROW EXECUTE FUNCTION public.sync_service_agreement_location_from_site();
      CREATE TRIGGER financial_config AFTER INSERT OR UPDATE OF service_agreement_id ON public.client_sites FOR EACH ROW EXECUTE FUNCTION public.ensure_site_financial_config_from_site();
      CREATE TRIGGER site_inherit AFTER INSERT ON public.client_sites FOR EACH ROW EXECUTE FUNCTION public.tg_client_sites_inherit_canonical_boundary();
      CREATE TRIGGER zone_inherit AFTER INSERT ON public.location_zones FOR EACH ROW EXECUTE FUNCTION public.tg_location_zones_inherit_canonical_boundary();
      CREATE TRIGGER zone_parent BEFORE INSERT OR UPDATE ON public.location_zones FOR EACH ROW EXECUTE FUNCTION public.trg_location_zones_parent_same_org();
      ${migration}
      CREATE FUNCTION public.assert_ok(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $f$
        BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %', label; END IF; END $f$;
      CREATE FUNCTION public.expect_error(statement text, expected text) RETURNS void LANGUAGE plpgsql AS $f$
        DECLARE failed boolean := false;
        BEGIN
          BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
            IF position(expected IN SQLERRM)=0 THEN RAISE EXCEPTION 'Unexpected error: %; expected %', SQLERRM, expected; END IF;
            failed := true;
          END;
          IF NOT failed THEN RAISE EXCEPTION 'Expected error: %', expected; END IF;
        END $f$;
      INSERT INTO public.organizations(id,name,organization_type) VALUES ('${provider}','Fixture provider','service_provider'),('${other}','Other provider','service_provider');
      INSERT INTO public.user_profiles(id,organization_id,employer_organization_id,role,display_name,deactivated_at)
        VALUES ('${officer}','${provider}','${provider}','officer','Test field officer',null),
        ('${admin}','${provider}','${provider}','admin','Test administrator',null),
        ('${adminOfficer}','${provider}','${provider}','admin_officer','Test admin officer',null),
        ('${outsider}','${other}','${other}','officer','Other officer',null),
        ('${inactive}','${provider}','${provider}','officer','Inactive officer',now());
      CREATE TABLE public.test_receipts(key text PRIMARY KEY, data jsonb);
      GRANT ALL ON public.test_receipts TO authenticated;
      ${actor(admin)}
      INSERT INTO public.test_receipts VALUES ('client', public.save_service_client('${id(20)}','${provider}',null,null,'Fixture client','','','',true));
      SELECT public.assert_ok(public.save_service_client('${id(20)}','${provider}',null,null,'Fixture client','','','',true)=(SELECT data FROM public.test_receipts WHERE key='client'),'exact retry receipt');
      SELECT public.expect_error($q$SELECT public.save_service_client('${id(20)}','${provider}',null,null,'Changed client','','','',true)$q$,'Retry contains changed');
      INSERT INTO public.test_receipts VALUES ('site',public.create_service_location('${id(21)}','${provider}',(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),'Fixture site','site'));
      INSERT INTO public.test_receipts VALUES ('zone',public.create_service_location('${id(22)}','${provider}',(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),'Fixture area','zone'));
      RESET ROLE;
      SELECT public.assert_ok((SELECT parent_organization_id IS NULL AND active FROM public.organizations WHERE id=(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client')),'own-rooted active client');
      SELECT public.assert_ok((SELECT data->'engagement_confirmed'='true'::jsonb FROM public.test_receipts WHERE key='client'),'receipt reflects the persisted engagement');
      SELECT public.assert_ok((SELECT count(*)=0 FROM public.site_financial_config),'no inferred hourly rates or minimum hours');
      SELECT public.assert_ok((SELECT s.service_agreement_id=(SELECT (data->>'agreement_id')::uuid FROM public.test_receipts WHERE key='client') FROM public.client_sites s WHERE s.id=(SELECT (data->>'facet_id')::uuid FROM public.test_receipts WHERE key='site')),'site uses the confirmed provider agreement');
      SELECT public.assert_ok((SELECT invitation_status='not_invited' AND external_refs->'engagement_confirmation'->>'confirmed_by'='${admin}' FROM public.service_agreements WHERE id=(SELECT (data->>'agreement_id')::uuid FROM public.test_receipts WHERE key='client')),'engagement without forged invitation');
      SELECT public.assert_ok((SELECT cp.place_kind='site' FROM public.locations l JOIN public.canonical_places cp ON cp.id=l.canonical_place_id WHERE l.id=(SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site')),'site registry identity');
      UPDATE public.client_sites SET boundary=ST_Buffer(ST_SetSRID(ST_Point(173.28,-41.27),4326)::geography,100)::geometry,boundary_verification='verified'
        WHERE id=(SELECT (data->>'facet_id')::uuid FROM public.test_receipts WHERE key='site');
      INSERT INTO public.test_receipts SELECT 'perimeter',jsonb_build_object('site',ST_AsEWKT(s.boundary),'registry',ST_AsEWKT(cp.boundary),'version',l.updated_at,'client',l.organization_id)
        FROM public.locations l JOIN public.client_sites s ON s.location_id=l.id JOIN public.canonical_places cp ON cp.id=l.canonical_place_id
        WHERE l.id=(SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site');
      INSERT INTO public.test_receipts VALUES ('capture',jsonb_build_object('lat',-41.2701,'lng',173.2801,'accuracy',35,'confirmed_lat',-41.27,'confirmed_lng',173.28,'captured_at',clock_timestamp()));
      ${actor(officer)}
      INSERT INTO public.test_receipts VALUES ('verified',public.capture_field_place('${id(23)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),
        (SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site'),
        (SELECT (data->>'version')::timestamptz FROM public.test_receipts WHERE key='perimeter'),
        'site','Fixture site',(SELECT data FROM public.test_receipts WHERE key='capture'),true));
      SELECT public.assert_ok(public.capture_field_place('${id(23)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),
        (SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site'),
        (SELECT (data->>'version')::timestamptz FROM public.test_receipts WHERE key='perimeter'),
        'site','Fixture site',(SELECT data FROM public.test_receipts WHERE key='capture'),true)=(SELECT data FROM public.test_receipts WHERE key='verified'),'field retry receipt');
      SELECT public.assert_ok((public.get_field_place_workspace('${provider}',(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'))->>'total')::int=2,'officer can browse client places');
      SELECT public.expect_error($q$SELECT public.capture_field_place('${id(25)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),
        (SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site'),
        (SELECT (data->>'version')::timestamptz FROM public.test_receipts WHERE key='perimeter'),
        'site','Fixture site',(SELECT data FROM public.test_receipts WHERE key='capture'),true)$q$,'Location changed');
      SELECT public.expect_error($q$SELECT public.capture_field_place('${id(26)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),null,null,
        'site','Stale capture',(SELECT data || jsonb_build_object('captured_at',now()-interval '11 minutes') FROM public.test_receipts WHERE key='capture'),true)$q$,'GPS capture is stale');
      SELECT public.expect_error($q$SELECT public.capture_field_place('${id(27)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),
        (SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site'),
        (SELECT (data->>'updated_at')::timestamptz FROM public.test_receipts WHERE key='verified'),
        'site','Fixture site',(SELECT data || jsonb_build_object('confirmed_lat',-42) FROM public.test_receipts WHERE key='capture'),true)$q$,'inside the selected boundary');
      SELECT public.expect_error($q$SELECT public.capture_field_place('${id(28)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),null,null,
        'site','Unconfirmed capture',(SELECT data FROM public.test_receipts WHERE key='capture'),false)$q$,'confirm the point');
      INSERT INTO public.test_receipts VALUES ('field-new',public.capture_field_place('${id(29)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),null,null,
        'zone','New field area',(SELECT data FROM public.test_receipts WHERE key='capture'),true));
      SELECT public.expect_error($q$SELECT public.create_service_location('${id(24)}','${provider}',(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),'Forbidden','site')$q$,'administrator');
      ${actor(outsider)}
      SELECT public.expect_error($q$SELECT public.get_field_place_workspace('${provider}')$q$,'active field');
      ${actor(inactive)}
      SELECT public.expect_error($q$SELECT public.get_field_place_workspace('${provider}')$q$,'active field');
      ${actor(adminOfficer)}
      SELECT public.assert_ok((public.get_field_place_workspace('${provider}',(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'))->>'total')::int=3,'admin officer parity');
      SELECT public.save_service_location_profile('${provider}',
        (SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site'),
        (SELECT (data->>'updated_at')::timestamptz FROM public.test_receipts WHERE key='verified'),
        'Renamed by admin','Briefing note',
        (SELECT (data->>'facet_id')::uuid FROM public.test_receipts WHERE key='site'),2,
        '{"risk_level":"low","site_brief":"Use public gate","access_instructions":"","hs_notes":"","active":true}',null);
      RESET ROLE;
      SELECT public.assert_ok((SELECT count(*)=1 FROM public.geofence_boundary_history WHERE entity_id=(SELECT (data->>'zone_id')::uuid FROM public.test_receipts WHERE key='verified')),'admin profile retains officer history');
      SELECT public.expect_error($q$UPDATE public.location_zones SET boundary_verified_at=clock_timestamp()
        WHERE id=(SELECT (data->>'zone_id')::uuid FROM public.test_receipts WHERE key='verified')$q$,'Use Places to capture');
      SELECT public.assert_ok((SELECT cp.boundary IS NULL FROM public.locations l JOIN public.canonical_places cp ON cp.id=l.canonical_place_id WHERE l.id=(SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='field-new')),'new marker is not a property boundary');
      SELECT public.assert_ok((SELECT count(*)=1 FROM public.location_zones WHERE location_id=(SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='field-new') AND NOT is_verification_point),'field area has a separately editable parent zone');
      SELECT public.expect_error($q$INSERT INTO public.client_sites(client_organization_id,location_id,name,site_type,boundary_status,boundary_verification)
        SELECT (data->>'client')::uuid,(SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site'),'Not a governed draft','other','provisional','unverified' FROM public.test_receipts WHERE key='perimeter'$q$,'client_sites_geo_required_chk');
      SELECT public.assert_ok((SELECT ST_AsEWKT(s.boundary)=r.data->>'site' AND ST_AsEWKT(cp.boundary)=r.data->>'registry'
        FROM public.test_receipts r, public.locations l JOIN public.client_sites s ON s.location_id=l.id JOIN public.canonical_places cp ON cp.id=l.canonical_place_id
        WHERE r.key='perimeter' AND l.id=(SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site')),'both perimeters unchanged');
      SELECT public.assert_ok((SELECT radius_meters=10 AND is_verification_point AND metadata->'field_capture'->>'accuracy'='35'
        AND metadata->'field_capture'->>'method'='gps_with_manual_map_correction' FROM public.location_zones WHERE id=(SELECT (data->>'zone_id')::uuid FROM public.test_receipts WHERE key='verified')),'10m and raw/corrected provenance');
      SELECT public.assert_ok((SELECT max(abs(ST_Distance((vertex).geom::geography,z.center_point::geography)-10))<0.02
        FROM public.location_zones z CROSS JOIN LATERAL ST_DumpPoints(z.boundary) vertex
        WHERE z.id=(SELECT (data->>'zone_id')::uuid FROM public.test_receipts WHERE key='verified')),'actual geodesic 10m radius');
      SELECT public.assert_ok((SELECT matched_zone_id IS NULL FROM public.resolve_context(-41.27,173.28,(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'))),'marker cannot supply rules');
      SELECT public.assert_ok(NOT has_function_privilege('anon','public.capture_field_place(uuid,uuid,uuid,uuid,timestamptz,text,text,jsonb,boolean,uuid,uuid)','EXECUTE'),'anonymous capture denied');
      SELECT public.assert_ok(NOT has_function_privilege('authenticated','public.field_place_client_allowed(uuid,uuid)','EXECUTE'),'internal helper private');
      INSERT INTO public.test_receipts SELECT 'client-edit-before',jsonb_build_object('version',o.updated_at,'confirmation',a.external_refs->'engagement_confirmation')
        FROM public.organizations o JOIN public.service_agreements a ON a.client_organization_id=o.id
        WHERE o.id=(SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client');
      INSERT INTO public.test_receipts SELECT 'recapture-version',to_jsonb(l.updated_at)
        FROM public.locations l WHERE l.id=(SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site');
      ${actor(adminOfficer)}
      SELECT public.save_service_client('${id(40)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),
        (SELECT (data->>'version')::timestamptz FROM public.test_receipts WHERE key='client-edit-before'),
        'Fixture client','','','Reviewed by admin officer',false);
      ${actor(officer)}
      INSERT INTO public.test_receipts VALUES ('recaptured',public.capture_field_place('${id(41)}','${provider}',
        (SELECT (data->>'id')::uuid FROM public.test_receipts WHERE key='client'),
        (SELECT (data->>'location_id')::uuid FROM public.test_receipts WHERE key='site'),
        (SELECT (data#>>'{}')::timestamptz FROM public.test_receipts WHERE key='recapture-version'),
        'site','Renamed by admin',(SELECT data || jsonb_build_object('confirmed_lat',-41.27002,'confirmed_lng',173.28002,'captured_at',clock_timestamp()) FROM public.test_receipts WHERE key='capture'),true));
      RESET ROLE;
      SELECT public.assert_ok((SELECT external_refs->'engagement_confirmation'=(SELECT data->'confirmation' FROM public.test_receipts WHERE key='client-edit-before')
        FROM public.service_agreements WHERE id=(SELECT (data->>'agreement_id')::uuid FROM public.test_receipts WHERE key='client')),'ordinary client edit preserves the original attester and timestamp');
      SELECT public.assert_ok((SELECT data->>'zone_id'=(SELECT data->>'zone_id' FROM public.test_receipts WHERE key='verified')
        FROM public.test_receipts WHERE key='recaptured'),'recapture reuses the marker');
      SELECT public.assert_ok((SELECT count(*)=2 FROM public.geofence_boundary_history
        WHERE entity_id=(SELECT (data->>'zone_id')::uuid FROM public.test_receipts WHERE key='verified')),'recapture appends rather than replacing the original evidence');
    `;
    try { docker(['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1'], setup); }
    catch (failure) { throw new Error(`${failure.stdout?.slice(-3000) ?? ''}\n${failure.stderr ?? failure.message}`); }
  } finally {
    if (created) docker(['rm', '--force', name]);
  }
});
