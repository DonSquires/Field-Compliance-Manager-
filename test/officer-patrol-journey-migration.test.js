'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261117195246_officer_patrol_journey_projection.sql'), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('\n);', start) + 3);
};
const definition = name => {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"(`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + '$function$;'.length);
};

test('officer journey projection enforces scope and mirrors actual completion blockers', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const container = `fcm-patrol-journey-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = query => docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  const as = (actor, query) => sql(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub='${id(actor)}'; ${query}; ROLLBACK;`);
  const journey = (actor = 3, shift = 20) => {
    const result = as(actor, `SELECT public.get_officer_patrol_journey('${id(shift)}')`);
    return result ? JSON.parse(result) : null;
  };
  const complete = actor => as(actor, `SELECT (public.complete_patrol_session('${id(21)}')).id`);
  const rejects = (fn, regex) => assert.throws(fn, error => regex.test(String(error.stderr ?? error.message)));
  let created = false;
  try {
    docker(['run', '--detach', '--name', container, '--network', 'none',
      '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { docker(['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    assert.ok(ready);
    sql(`CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
      CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO PUBLIC;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      ${['organizations', 'user_profiles', 'shifts', 'shift_stops', 'shift_stop_modules',
        'client_sites', 'location_zones', 'service_agreement_locations', 'service_agreement_modules',
        'service_agreements', 'patrol_routes', 'patrols', 'patrol_route_checkpoints',
        'patrol_checkpoints', 'patrol_checkpoint_visits', 'audit_log'].map(table).join('\n')}
      ${definition('get_descendant_organizations')}
      ${definition('complete_patrol_session')}
      GRANT EXECUTE ON FUNCTION public.complete_patrol_session(uuid,text) TO authenticated;
      ${migration}
      INSERT INTO public.organizations(id,name,organization_type,parent_organization_id) VALUES
        ('${id(1)}','Provider','service_provider',NULL),
        ('${id(2)}','Branch','branch','${id(1)}'),
        ('${id(7)}','Actual client','client',NULL),
        ('${id(8)}','Place owner','client',NULL),
        ('${id(9)}','Other','client',NULL);
      INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
        ('${id(3)}','${id(2)}','officer','Officer'),
        ('${id(4)}','${id(2)}','officer','Other officer'),
        ('${id(5)}','${id(2)}','admin_officer','Admin officer'),
        ('${id(6)}','${id(9)}','officer','Outsider');
      INSERT INTO public.patrol_routes(id,organization_id,name) VALUES ('${id(11)}','${id(2)}','Run');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,patrol_route_id,zone_id)
        VALUES ('${id(20)}','${id(2)}','${id(3)}','general_patrol',now()-interval '1 hour',now()+interval '1 hour','in_progress','${id(11)}','${id(42)}');
      INSERT INTO public.patrols(id,organization_id,shift_id,officer_user_id,status)
        VALUES ('${id(21)}','${id(2)}','${id(20)}','${id(3)}','in_progress');
      INSERT INTO public.client_sites(id,client_organization_id,name,address,location_id,gps_lat,gps_lng,access_instructions,hs_notes)
        VALUES ('${id(30)}','${id(8)}','Site A','Address A','${id(90)}',-41,174,'PRIVATE ACCESS','PRIVATE SAFETY'),
               ('${id(31)}','${id(8)}','Site B','Address B','${id(91)}',NULL,NULL,'PRIVATE','PRIVATE'),
               ('${id(32)}','${id(8)}','Adhoc','Address C','${id(93)}',NULL,NULL,'PRIVATE','PRIVATE');
      INSERT INTO public.location_zones(id,organization_id,name,location_id,center_point)
        VALUES ('${id(42)}','${id(2)}','Shift zone','${id(92)}',public.st_setsrid(public.st_makepoint(173,-42),4326));
      INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,zone_id,module_key,stop_order,visit_number,is_adhoc,sla_arrive_by,officer_instructions)
        VALUES ('${id(51)}','${id(2)}','${id(20)}','${id(30)}',NULL,'patrol',2,1,false,now(),'PRIVATE STOP'),
               ('${id(52)}','${id(2)}','${id(20)}','${id(31)}',NULL,'patrol',1,1,false,now(),'PRIVATE STOP'),
               ('${id(53)}','${id(2)}','${id(20)}','${id(32)}',NULL,'static_guarding',3,1,true,now(),'PRIVATE STOP');
      INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,agreement_type)
        VALUES ('${id(60)}','${id(1)}','${id(7)}','Agreement','operational'),
               ('${id(61)}','${id(9)}','${id(8)}','Wrong provider','operational');
      INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id)
        VALUES ('${id(62)}','${id(60)}','${id(30)}'), ('${id(63)}','${id(61)}','${id(30)}');
      INSERT INTO public.service_agreement_modules(id,service_agreement_id,module_key)
        VALUES ('${id(64)}','${id(60)}','patrol'), ('${id(65)}','${id(61)}','patrol');
      INSERT INTO public.shift_stop_modules(id,organization_id,shift_stop_id,module_key,service_agreement_location_id,service_agreement_module_id)
        VALUES ('${id(66)}','${id(2)}','${id(51)}','patrol','${id(62)}','${id(64)}'),
               ('${id(67)}','${id(2)}','${id(52)}','patrol',NULL,NULL);
      INSERT INTO public.patrol_route_checkpoints(id,patrol_route_id,name,is_active,is_mandatory,sequence_order,description)
        VALUES ('${id(70)}','${id(11)}','Required route',true,true,2,'PRIVATE ROUTE'),
               ('${id(71)}','${id(11)}','Optional route',true,false,1,'PRIVATE ROUTE'),
               ('${id(72)}','${id(11)}','Inactive route',false,true,0,'PRIVATE ROUTE');
      INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,zone_id,active,description)
        VALUES ('${id(80)}','${id(2)}','Site checkpoint','${id(30)}',NULL,true,'PRIVATE CHECKPOINT'),
               ('${id(81)}','${id(2)}','Zone checkpoint',NULL,'${id(42)}',true,'PRIVATE CHECKPOINT'),
               ('${id(85)}','${id(2)}','Adhoc checkpoint','${id(32)}',NULL,true,'PRIVATE CHECKPOINT'),
               ('${id(82)}','${id(2)}','Unrelated',NULL,'${id(99)}',true,'PRIVATE CHECKPOINT'),
               ('${id(83)}','${id(2)}','Inactive','${id(30)}',NULL,false,'PRIVATE CHECKPOINT');
      UPDATE public.patrol_checkpoints SET gps_lat=-41, gps_lng=174,
        checkpoint_verification='verified',checkpoint_verified_by='${id(3)}',
        checkpoint_verified_at=now()-interval '1 hour' WHERE id='${id(80)}';
      UPDATE public.patrol_checkpoints SET gps_lat=-41,gps_lng=174 WHERE id='${id(81)}';
    `);

    await t.test('assigned access, contextual clients, coordinates and narrative minimization', () => {
      const data = journey();
      assert.equal(data.shift_id, id(20));
      assert.equal(data.patrol_id, id(21));
      assert.equal(data.route_geometry, null);
      assert.equal(data.route_geometry_status, 'unavailable');
      assert.deepEqual(data.stops.map(s => s.id), [id(52), id(51)]);
      assert.deepEqual(data.stops[1].clients, [{ id: id(7), name: 'Actual client' }]);
      assert.equal(data.stops[1].client_attribution_complete, true);
      assert.equal(data.stops[0].client_attribution_complete, false);
      assert.deepEqual(data.stops[0].clients, []);
      assert.deepEqual(data.stops[1].place.coordinates, { lat: -41, lng: 174, source: 'site_center' });
      assert.equal(data.stops[0].place.coordinates, null);
      assert.doesNotMatch(JSON.stringify(data), /PRIVATE|Place owner/);
      sql(`INSERT INTO public.service_agreements(id,provider_organization_id,client_organization_id,name,agreement_type)
        VALUES ('${id(86)}','${id(1)}','${id(9)}','Second','operational');
        INSERT INTO public.service_agreement_locations(id,service_agreement_id,site_id)
        VALUES ('${id(87)}','${id(86)}','${id(30)}');
        INSERT INTO public.service_agreement_modules(id,service_agreement_id,module_key)
        VALUES ('${id(88)}','${id(86)}','patrol');
        INSERT INTO public.shift_stop_modules(id,organization_id,shift_stop_id,module_key,service_agreement_location_id,service_agreement_module_id)
        VALUES ('${id(89)}','${id(2)}','${id(51)}','patrol','${id(87)}','${id(88)}')`);
      assert.deepEqual(journey().stops[1].clients.map(c => c.id).sort(), [id(7), id(9)].sort());
      assert.equal(journey().stops[1].client_attribution_complete, true);
      sql(`UPDATE public.shift_stop_modules SET organization_id='${id(9)}' WHERE id='${id(89)}'`);
      assert.deepEqual(journey().stops[1].clients.map(c => c.id), [id(7)]);
      assert.equal(journey().stops[1].client_attribution_complete, false);
      sql(`DELETE FROM public.shift_stop_modules WHERE id='${id(89)}'`);
      sql(`INSERT INTO public.service_agreement_locations(id,service_agreement_id,zone_id)
        VALUES ('${id(94)}','${id(60)}','${id(42)}');
        UPDATE public.shift_stops SET zone_id='${id(42)}' WHERE id='${id(52)}';
        UPDATE public.shift_stop_modules SET service_agreement_location_id='${id(94)}',
          service_agreement_module_id='${id(64)}' WHERE id='${id(67)}'`);
      const dualPlace = journey().stops[0];
      assert.equal(dualPlace.place.kind, 'site');
      assert.equal(dualPlace.place.coordinates, null);
      assert.deepEqual(dualPlace.clients, []);
      assert.equal(dualPlace.client_attribution_complete, false);
      sql(`UPDATE public.shift_stop_modules SET service_agreement_location_id=NULL,
        service_agreement_module_id=NULL WHERE id='${id(67)}'`);
      sql(`UPDATE public.shift_stops SET site_id=NULL,zone_id='${id(42)}' WHERE id='${id(52)}'`);
      assert.deepEqual(journey().stops[0].place.coordinates, { lat: -42, lng: 173, source: 'zone_center' });
      sql(`UPDATE public.shift_stops SET site_id='${id(31)}',zone_id=NULL WHERE id='${id(52)}'`);
      for (const actor of [4, 5, 6]) assert.equal(journey(actor), null);
      rejects(() => sql(`SET ROLE anon; SELECT public.get_officer_patrol_journey('${id(20)}')`), /permission denied/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${id(3)}'`);
      rejects(() => journey(), /Active Patrol officer required/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=NULL WHERE id='${id(3)}'`);
      sql(`UPDATE public.user_profiles SET organization_id='${id(9)}' WHERE id='${id(3)}'`);
      assert.equal(journey().patrol_id, id(21));
      sql(`UPDATE public.patrols SET organization_id='${id(9)}' WHERE id='${id(21)}'`);
      rejects(() => journey(), /session configuration requires operations review/i);
      sql(`UPDATE public.patrols SET organization_id='${id(2)}' WHERE id='${id(21)}';
        UPDATE public.user_profiles SET organization_id='${id(2)}' WHERE id='${id(3)}'`);
      sql(`UPDATE public.shifts SET scheduled_end=now()-interval '1 second' WHERE id='${id(20)}'`);
      assert.equal(journey(), null);
      sql(`UPDATE public.shifts SET scheduled_end=now()+interval '1 hour' WHERE id='${id(20)}'`);
      for (const status of ['completed', 'cancelled', 'scheduled']) {
        sql(`UPDATE public.shifts SET status='${status}' WHERE id='${id(20)}'`);
        assert.equal(journey(), null);
      }
      for (const status of ['published', 'accepted', 'in_progress']) {
        sql(`UPDATE public.shifts SET status='${status}' WHERE id='${id(20)}'`);
        assert.equal(journey().shift_id, id(20));
      }
      sql(`UPDATE public.user_profiles SET role='client' WHERE id='${id(3)}'`);
      rejects(() => journey(), /Active Patrol officer required/i);
      sql(`UPDATE public.user_profiles SET role='officer' WHERE id='${id(3)}'`);
      sql(`UPDATE public.shift_stop_modules SET service_agreement_location_id='${id(63)}',service_agreement_module_id='${id(65)}' WHERE id='${id(66)}'`);
      assert.deepEqual(journey().stops[1].clients, []);
      assert.equal(journey().stops[1].client_attribution_complete, false);
      sql(`UPDATE public.shift_stop_modules SET service_agreement_location_id='${id(62)}',service_agreement_module_id='${id(64)}' WHERE id='${id(66)}'`);
    });

    await t.test('mandatory route precedence and optional anchored site checkpoints match completion', () => {
      const data = journey();
      assert.equal(data.checkpoint_requirement, 'route');
      assert.deepEqual(data.checkpoints.map(c => [c.id, c.required]), [[id(71), false], [id(70), true], [id(85), false], [id(80), false], [id(81), false]]);
      assert.deepEqual(data.checkpoints.find(c => c.id === id(80)).stop_ids, [id(51)]);
      assert.deepEqual(data.checkpoints.find(c => c.id === id(85)).stop_ids, [id(53)]);
      assert.deepEqual(data.checkpoints.find(c => c.id === id(81)).stop_ids, []);
      assert.equal(data.checkpoints.find(c => c.id === id(70)).site_id, null);
      assert.equal(data.checkpoints.find(c => c.id === id(70)).auto_geofence_status, 'unavailable_route');
      assert.equal(data.checkpoints.find(c => c.id === id(80)).auto_geofence_status, 'verified');
      assert.equal(data.checkpoints.find(c => c.id === id(81)).auto_geofence_status, 'unverified');
      assert.equal(data.checkpoints.find(c => c.id === id(85)).auto_geofence_status, 'missing_or_invalid_geofence');
      assert.ok(data.checkpoints.every(c => !('gps_lat' in c) && !('gps_lng' in c)));
      rejects(() => complete(3), /mandatory checkpoints remain/i);
      sql(`INSERT INTO public.patrol_checkpoint_visits(organization_id,patrol_id,route_checkpoint_id) VALUES ('${id(2)}','${id(21)}','${id(70)}')`);
      assert.equal(journey().checkpoints.find(c => c.id === id(70)).visited, true);
      assert.equal(complete(3), id(21));
    });

    await t.test('site/zone fallback includes every stop and shift zone required by completion', () => {
      sql(`UPDATE public.patrol_route_checkpoints SET is_active=false WHERE id='${id(70)}'`);
      const data = journey();
      assert.equal(data.checkpoint_requirement, 'site_zone');
      assert.deepEqual(data.checkpoints.map(c => [c.id, c.required]), [[id(71), false], [id(85), true], [id(80), true], [id(81), true]]);
      rejects(() => complete(3), /mandatory checkpoints remain/i);
      sql(`INSERT INTO public.patrol_checkpoint_visits(organization_id,patrol_id,checkpoint_id) VALUES ('${id(2)}','${id(21)}','${id(80)}')`);
      rejects(() => complete(3), /mandatory checkpoints remain/i);
      sql(`INSERT INTO public.patrol_checkpoint_visits(organization_id,patrol_id,checkpoint_id) VALUES ('${id(2)}','${id(21)}','${id(81)}')`);
      rejects(() => complete(3), /mandatory checkpoints remain/i);
      sql(`INSERT INTO public.patrol_checkpoint_visits(organization_id,patrol_id,checkpoint_id) VALUES ('${id(2)}','${id(21)}','${id(85)}')`);
      assert.equal(complete(3), id(21));
    });

    await t.test('cross-organisation completion blockers are explicit, not leaked or omitted', () => {
      sql(`INSERT INTO public.patrol_checkpoints(id,organization_id,name,client_site_id,active) VALUES ('${id(84)}','${id(9)}','Private other checkpoint','${id(30)}',true)`);
      rejects(() => journey(), /checkpoint configuration requires operations review/i);
      rejects(() => complete(3), /mandatory checkpoints remain/i);
      sql(`UPDATE public.patrol_route_checkpoints SET is_active=true WHERE id='${id(70)}'`);
      assert.ok(!JSON.stringify(journey()).includes('Private other checkpoint'));
      sql(`UPDATE public.shift_stops SET organization_id='${id(9)}' WHERE id='${id(53)}'`);
      rejects(() => journey(), /stop configuration requires operations review/i);
    });
  } finally {
    if (created) docker(['rm', '-f', container]);
  }
});
