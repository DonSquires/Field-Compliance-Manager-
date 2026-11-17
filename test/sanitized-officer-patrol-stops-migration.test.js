'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'supabase/schema.sql'), 'utf8');
const source = fs.readFileSync(path.join(root, 'supabase/migrations/20261117030648_patrol_stop_checks.sql'), 'utf8');
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20261117202006_sanitized_officer_patrol_stops.sql'), 'utf8');
const restriction = fs.readFileSync(path.join(root, 'supabase/migrations/20261117203345_restrict_raw_patrol_stop_reader.sql'), 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const table = name => {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}" (`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('\n);', start) + 3);
};
const definition = name => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('$function$;', start) + '$function$;'.length);
};

test('sanitized patrol stop reader scopes assignments and withholds legacy narrative', {
  skip: process.env.BOB_TEST_POSTGRES !== '1', timeout: 180000,
}, async t => {
  const container = `fcm-sanitized-stops-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const sql = query => docker(['exec', '-i', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'], query).trim();
  const query = shift => `SELECT public.get_officer_patrol_stops_sanitized(${shift === null ? 'NULL' : `'${id(shift)}'`})`;
  const as = (actor, statement) => sql(`BEGIN; SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub='${id(actor)}'; ${statement}; COMMIT;`);
  const read = (actor = 3, shift = 20) => {
    const result = as(actor, query(shift));
    return result ? JSON.parse(result) : null;
  };
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
      ${['user_profiles', 'shifts', 'shift_stops', 'shift_stop_modules', 'shift_stop_actions', 'patrol_routes', 'patrols',
        'client_sites', 'location_zones', 'client_site_patrol_config', 'service_agreement_delivery_schedules',
        'service_agreements', 'patrol_check_types'].map(table).join('\n')}
      ${definition('patrol_stop_check_details_internal')}
      ${definition('get_officer_patrol_stops')}
      ${migration}
      ${restriction}
      INSERT INTO public.user_profiles(id,organization_id,role,display_name) VALUES
        ('${id(3)}','${id(2)}','officer','Officer'), ('${id(4)}','${id(2)}','officer','Other'),
        ('${id(5)}','${id(8)}','officer','Other branch'), ('${id(6)}','${id(2)}','client','Client');
      INSERT INTO public.patrol_routes(id,organization_id,name) VALUES ('${id(10)}','${id(2)}','PRIVATE ROUTE NAME');
      INSERT INTO public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status,patrol_route_id)
        VALUES ('${id(20)}','${id(2)}','${id(3)}','general_patrol',now()-interval '1 hour',now()+interval '1 hour','in_progress','${id(10)}'),
               ('${id(21)}','${id(2)}','${id(4)}','general_patrol',now()-interval '1 hour',now()+interval '1 hour','in_progress','${id(10)}');
      INSERT INTO public.client_sites(id,client_organization_id,location_id,name,address,access_instructions,hs_notes)
        VALUES ('${id(30)}','${id(8)}','${id(80)}','Assigned site','Site address','PRIVATE ACCESS','PRIVATE SAFETY');
      INSERT INTO public.location_zones(id,organization_id,location_id,name,access_instructions,hs_notes)
        VALUES ('${id(31)}','${id(2)}','${id(81)}','Assigned zone','PRIVATE ZONE ACCESS','PRIVATE ZONE SAFETY');
      INSERT INTO public.shift_stops(id,organization_id,shift_id,site_id,zone_id,module_key,stop_order,sla_arrive_by,status,officer_instructions,officer_notes,required_checks)
        VALUES ('${id(40)}','${id(2)}','${id(20)}','${id(30)}',NULL,'general_patrol',1,now(),'on_scene','PRIVATE INSTRUCTIONS','PRIVATE STOP NOTES','{gate_check}'),
               ('${id(41)}','${id(2)}','${id(20)}',NULL,'${id(31)}','general_patrol',2,now(),'pending',NULL,NULL,'{}'),
               ('${id(42)}','${id(2)}','${id(20)}','${id(99)}',NULL,'general_patrol',3,now(),'pending',NULL,NULL,'{}'),
               ('${id(43)}','${id(2)}','${id(20)}','${id(30)}',NULL,'static_guarding',4,now(),'pending','PRIVATE STATIC',NULL,'{}');
      INSERT INTO public.shift_stop_modules(id,organization_id,shift_stop_id,module_key,status,is_required)
        VALUES ('${id(50)}','${id(2)}','${id(40)}','general_patrol','pending',true);
      INSERT INTO public.patrol_check_types(id,organization_id,check_key,label,needs_photo,needs_note)
        VALUES ('${id(51)}',NULL,'gate_check','PRIVATE CHECK LABEL',true,true);
      INSERT INTO public.shift_stop_actions(id,organization_id,shift_stop_id,shift_id,action_type,outcome,notes,evidence_metadata)
        VALUES ('${id(52)}','${id(2)}','${id(40)}','${id(20)}','gate_check','done','PRIVATE CHECK NOTES','{"kind":"patrol_stop_check"}');
    `);

    await t.test('preserves ordered structured action data without raw text', () => {
      const result = read();
      assert.equal(result.shift.id, id(20));
      assert.equal(result.shift.route_name, null);
      assert.deepEqual(result.stops.map(s => s.id), [id(40), id(41), id(42)]);
      const [site, zone, missing] = result.stops;
      assert.equal(site.status, 'on_scene');
      assert.equal(site.stop_order, 1);
      assert.equal(site.place.name, 'Assigned site');
      assert.equal(site.place.address, 'Site address');
      assert.equal(site.place.access_instructions, null);
      assert.equal(site.place.hs_notes, null);
      assert.equal(site.officer_instructions, null);
      assert.equal(site.officer_notes, null);
      assert.deepEqual(site.modules, [{module_key: 'general_patrol', status: 'pending', is_required: true}]);
      assert.equal(site.checks[0].check_key, 'gate_check');
      assert.equal(site.checks[0].label, 'gate_check');
      assert.equal(site.checks[0].notes, null);
      assert.equal(site.checks[0].outcome, 'done');
      assert.equal(site.checks[0].needs_photo, true);
      assert.equal(site.checks[0].needs_note, true);
      assert.ok(site.checks[0].performed_at);
      assert.equal(zone.place.kind, 'zone');
      assert.equal(zone.place.access_instructions, null);
      assert.equal(zone.place.hs_notes, null);
      assert.equal(zone.place.address, null);
      assert.deepEqual(zone.checks, []);
      assert.deepEqual(zone.modules, []);
      assert.equal(missing.place, null);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
      const raw = JSON.parse(sql(`SET request.jwt.claim.sub='${id(3)}'; SELECT public.get_officer_patrol_stops('${id(20)}')`));
      assert.equal(raw.stops[0].officer_instructions, 'PRIVATE INSTRUCTIONS');
      assert.equal(raw.stops[0].checks[0].notes, 'PRIVATE CHECK NOTES');
    });

    await t.test('the raw reader is not directly executable by API roles', () => {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        rejects(() => sql(`SET ROLE ${role}; SET request.jwt.claim.sub='${id(3)}'; SELECT public.get_officer_patrol_stops('${id(20)}')`),
          /permission denied/i);
      }
      assert.equal(read().shift.id, id(20));
    });

    await t.test('requires the exact active non-overdue assignment', () => {
      assert.equal(read(3, null), null);
      assert.equal(read(3, 21), null);
      assert.equal(read(3, 99), null);
      assert.equal(read(4, 20), null);
      assert.equal(read(5, 20), null);
      rejects(() => read(6), /Active Patrol officer required/i);
      rejects(() => sql(`SET ROLE anon; ${query(20)}`), /permission denied/i);
      rejects(() => sql(`SET ROLE service_role; ${query(20)}`), /permission denied/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=now() WHERE id='${id(3)}'`);
      rejects(() => read(), /Active Patrol officer required/i);
      sql(`UPDATE public.user_profiles SET deactivated_at=NULL,organization_id='${id(8)}' WHERE id='${id(3)}'`);
      assert.equal(read().shift.id, id(20));
      sql(`INSERT INTO public.patrols(id,organization_id,shift_id,officer_user_id,status)
        VALUES ('${id(53)}','${id(8)}','${id(20)}','${id(3)}','in_progress')`);
      rejects(() => read(), /session configuration requires operations review/i);
      sql(`DELETE FROM public.patrols WHERE id='${id(53)}'`);
      sql(`UPDATE public.user_profiles SET organization_id='${id(2)}' WHERE id='${id(3)}'`);
      for (const status of ['completed','cancelled','scheduled']) {
        sql(`UPDATE public.shifts SET status='${status}' WHERE id='${id(20)}'`);
        assert.equal(read(), null);
      }
      for (const status of ['published','accepted','in_progress']) {
        sql(`UPDATE public.shifts SET status='${status}' WHERE id='${id(20)}'`);
        assert.equal(read().shift.id, id(20));
      }
      sql(`UPDATE public.shifts SET scheduled_end=now()-interval '1 second' WHERE id='${id(20)}'`);
      assert.equal(read(), null);
      sql(`UPDATE public.shifts SET scheduled_end=now()+interval '1 hour' WHERE id='${id(20)}';
        UPDATE public.shift_stops SET organization_id='${id(8)}' WHERE id='${id(40)}'`);
      rejects(() => read(), /stop configuration requires operations review/i);
      sql(`UPDATE public.shift_stops SET organization_id='${id(2)}' WHERE id='${id(40)}'`);
    });

    await t.test('future legacy fields do not pass through the allowlist and null source stays null', () => {
      sql(`CREATE OR REPLACE FUNCTION public.get_officer_patrol_stops(p_shift_id uuid DEFAULT NULL::uuid)
        RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$
          SELECT jsonb_build_object('shift',jsonb_build_object('id',p_shift_id,'future','SECRET SHIFT'),
            'stops',jsonb_build_array(jsonb_build_object('id','${id(40)}','future','SECRET STOP',
              'place',jsonb_build_object('kind','site','name','Assigned site','future','SECRET PLACE'),
              'checks',jsonb_build_array(jsonb_build_object('check_key','gate_check','label','SECRET LABEL','future','SECRET CHECK')),
              'modules',jsonb_build_array(jsonb_build_object('module_key','general_patrol','future','SECRET MODULE'))))) $$`);
      const result = read();
      assert.doesNotMatch(JSON.stringify(result), /SECRET/);
      assert.equal(result.stops[0].checks[0].label, 'gate_check');
      sql(`CREATE OR REPLACE FUNCTION public.get_officer_patrol_stops(p_shift_id uuid DEFAULT NULL::uuid)
        RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT NULL::jsonb $$`);
      assert.equal(read(), null);
    });
  } finally {
    if (created) docker(['rm', '-f', container]);
  }
});
