'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const schema = readFileSync(join(__dirname, '../supabase/schema.sql'), 'utf8');
const migration = readFileSync(join(__dirname, '../supabase/migrations/20261106120000_officer_static_attendance_and_rostered_breaks.sql'), 'utf8');
function fn(name) {
  const start = schema.indexOf(`CREATE OR REPLACE FUNCTION "public"."${name}"`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('$function$;', start) + 11);
}
function table(name) {
  const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS "public"."${name}"`);
  assert.ok(start >= 0, name);
  return schema.slice(start, schema.indexOf('\n);', start) + 3);
}
test('single-site attendance keeps evidence and break duration separate from the roster allowance', () => {
  assert.match(migration, /exception_reason/);
  assert.match(migration, /review_required/);
  assert.match(migration, /Finish the open break before completing/);
  assert.match(migration, /v_source\.planned_break_minutes,v_source\.break_unpaid/);
  assert.doesNotMatch(migration, /update public\.shift_breaks.*planned_break_minutes/i);
  assert.match(migration, /revoke all on function public\.record_static_shift_presence.*from public,anon,authenticated,service_role/i);
});
test('static attendance, break plan, authorization, retries and completion are transactional', {
  skip: process.env.BOB_TEST_POSTGRES !== '1',
}, async () => {
  const name = `fcm-static-breaks-${randomUUID()}`;
  const docker = (args, input) => execFileSync('docker', args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  let created = false;
  try {
    docker(['run', '--detach', '--name', name, '--network', 'none', '--mount', 'type=tmpfs,destination=/var/lib/postgresql/data',
      '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgis/postgis:17-3.5']);
    created = true;
    for (let attempt = 0; ; attempt++) {
      try { docker(['exec', name, 'pg_isready', '-U', 'postgres']); break; }
      catch (error) { if (attempt === 119) throw error; await new Promise((resolve) => setTimeout(resolve, 250)); }
    }
    const org = '10000000-0000-4000-8000-000000000001';
    const officer = '20000000-0000-4000-8000-000000000001';
    const admin = '20000000-0000-4000-8000-000000000002';
    const shift = '30000000-0000-4000-8000-000000000001';
    const stop = '40000000-0000-4000-8000-000000000001';
    const site = '50000000-0000-4000-8000-000000000001';
    const sal = '60000000-0000-4000-8000-000000000001';
    const sam = '60000000-0000-4000-8000-000000000002';
    const agreement = '60000000-0000-4000-8000-000000000003';
    const unit = '70000000-0000-4000-8000-000000000001';
    const slot = '80000000-0000-4000-8000-000000000001';
    const sql = `
      create extension postgis;
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema extensions;
      create function auth.uid() returns uuid language sql stable as $f$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $f$;
      create function public.is_admin_for_org(uuid) returns boolean language sql stable as $f$
        select auth.uid()='${admin}'::uuid and $1='${org}'::uuid $f$;
      create table public.user_profiles(id uuid primary key,deactivated_at timestamptz);
      create table public.client_sites(id uuid primary key,name text,active boolean,boundary geometry,
        boundary_verification text,center_point geometry,onsite_radius_meters integer);
      create table public.location_zones(id uuid,name text);
      create table public.service_agreement_modules(id uuid,service_agreement_id uuid,module_key text,enabled boolean);
      create table public.service_agreement_locations(id uuid,service_agreement_id uuid,status text);
      create table public.audit_log(id uuid default gen_random_uuid(),organization_id uuid,actor_user_id uuid,
        action text,target_table text,target_id uuid,metadata jsonb);
      create table public.dispatch_jobs(shift_id uuid,status text);
      create table public.welfare_alerts(shift_id uuid,status text);
      create table public.staff_profiles(id uuid,user_id uuid,organization_id uuid,work_ready boolean);
      create table public.staff_branch_authorisations(user_id uuid,branch_org_id uuid,status text);
      create table public.leave_requests(staff_id uuid,status text,starts_on date,ends_on date);
      ${['shifts', 'shift_stops', 'shift_stop_modules', 'shift_stop_actions', 'shift_breaks', 'shift_debriefs', 'roster_slots', 'roster_work_units'].map(table).join('\n')}
      alter table public.roster_slots add primary key(id);
      alter table public.shift_breaks add unique(organization_id,client_request_id);
      alter table public.shift_stops add check(arrival_verification is null or arrival_verification in
        ('verified_on_site','near_site','off_site','unverified_boundary','no_geofence','no_gps'));
      create function public.evaluate_shift_start_position(uuid,double precision,double precision) returns jsonb
        language sql as $f$ select '{"status":"no_gps"}'::jsonb $f$;
      create function public.staff_has_roster_availability_conflict(uuid,timestamptz,timestamptz) returns boolean
        language sql as $f$ select false $f$;
      create function public.staff_fatigue_conflict(uuid,timestamptz,timestamptz,uuid) returns text
        language sql as $f$ select null::text $f$;
      create function public.materialize_roster_slot(uuid,text) returns table(shift_id uuid)
        language plpgsql as $f$ begin
          update public.roster_slots set linked_shift_id='30000000-0000-4000-8000-000000000002' where id=$1;
          return query select '30000000-0000-4000-8000-000000000002'::uuid;
        end $f$;
      ${['start_officer_shift','complete_officer_shift','get_shift_end_readiness','create_roster_slot','update_roster_slot','manage_roster_slot','start_shift_break','end_shift_break'].map(fn).join('\n')}
      ${readFileSync(join(__dirname, '../supabase/migrations/20261105165648_officer_recovery_readiness.sql'), 'utf8')}
      ${migration}
      begin;
      create function pg_temp.ok(value boolean,message text) returns void language plpgsql as $f$
        begin if value is distinct from true then raise exception '%',message; end if; end $f$;
      create function pg_temp.fails(statement text,expected text) returns void language plpgsql as $f$
        begin begin execute statement; exception when others then
          if position(expected in sqlerrm)=0 then raise; end if; return;
        end; raise exception 'Expected failure: %',expected; end $f$;
      insert into public.user_profiles values('${officer}',null),('${admin}',null);
      insert into public.client_sites values('${site}','PRIVATE_SYNTHETIC_SITE',true,null,'unverified',null,10);
      insert into public.service_agreement_modules values('${sam}','${agreement}','static_guarding',true);
      insert into public.service_agreement_locations values('${sal}','${agreement}','active');
      insert into public.shifts(id,organization_id,officer_user_id,service_type,scheduled_start,scheduled_end,status)
        values('${shift}','${org}','${officer}','static_guarding',now()-interval '1 minute',now()+interval '8 hours','accepted');
      insert into public.shift_stops(id,organization_id,shift_id,site_id,module_key,sla_arrive_by)
        values('${stop}','${org}','${shift}','${site}','static_guarding',now());
      insert into public.shift_stop_modules(organization_id,shift_stop_id,module_key,service_agreement_module_id,service_agreement_location_id)
        values('${org}','${stop}','static_guarding','${sam}','${sal}');
      insert into public.roster_work_units(id,organization_id,name,work_unit_type,service_type,active,created_by)
        values('${unit}','${org}','Synthetic post','static','static_guarding',true,'${admin}');
      insert into public.roster_slots(id,organization_id,work_unit_id,scheduled_start,scheduled_end,linked_shift_id,client_request_id)
        values('${slot}','${org}','${unit}',now(),now()+interval '8 hours','${shift}',gen_random_uuid());
      select set_config('request.jwt.claim.sub','${officer}',false);
      set role authenticated;
      select pg_temp.ok(public.evaluate_static_shift_position('${shift}',null,null)->>'verified_attendance'='false','missing GPS never verifies attendance');
      select pg_temp.fails($q$select public.evaluate_static_shift_position('${shift}',1000,173)$q$,'Invalid GPS');
      select pg_temp.fails($q$select public.record_static_shift_presence('${shift}','arrive',gen_random_uuid(),null,null,'Synthetic')$q$,'permission denied');
      reset role;
      update public.client_sites set boundary_verification='verified',
        boundary=st_geomfromtext('POLYGON((173 -42,174 -42,174 -41,173 -41,173 -42))',4326) where id='${site}';
      set role authenticated;
      select pg_temp.ok(public.evaluate_static_shift_position('${shift}',-41.5,173.5)->>'verified_attendance'='true','verified polygon contains position');
      select pg_temp.ok(public.evaluate_static_shift_position('${shift}',-40,175)->>'status'='off_site','outside polygon stays unverified');
      reset role;
      update public.client_sites set boundary_verification='unverified',boundary=null where id='${site}';
      set role authenticated;
      select pg_temp.ok(not has_function_privilege('authenticated','public.record_static_shift_presence(uuid,text,uuid,double precision,double precision,text)','execute'),'internal helper stays private');
      select pg_temp.ok(not has_function_privilege('anon','public.start_officer_static_shift(uuid,uuid,text,double precision,double precision,text)','execute'),'anonymous denied');
      select pg_temp.fails($q$select public.start_officer_static_shift(gen_random_uuid(),'${shift}','accepted',null,null,null)$q$,'Explain');
      reset role;
      select pg_temp.ok((select status='accepted' from public.shifts where id='${shift}'),'failed exception rolls back shift start');
      set role authenticated;
      select public.start_officer_static_shift('90000000-0000-4000-8000-000000000001','${shift}','accepted',null,null,'Synthetic location unavailable');
      select public.start_officer_static_shift('90000000-0000-4000-8000-000000000001','${shift}','accepted',null,null,'Synthetic location unavailable');
      select pg_temp.ok(public.get_officer_attendance_readiness('${shift}')->>'open_stop_count'='0','single post closes with shift end');
      select pg_temp.ok(public.get_officer_attendance_readiness('${shift}')::text not like '%PRIVATE_%','readiness has no private site text');
      select pg_temp.fails($q$select public.complete_officer_static_shift('${shift}','in_progress',null,null,'Synthetic exception')$q$,'Finish required');
      reset role;
      select pg_temp.ok((select count(*)=1 from public.shift_stop_actions where shift_id='${shift}'),'start retry cannot duplicate attendance');
      select pg_temp.ok((select status='on_scene' and arrival_verification='no_gps' from public.shift_stops where id='${stop}'),'exception is never verified');
      insert into public.shift_debriefs(organization_id,shift_id,officer_user_id,client_event_id,summary)
        values('${org}','${shift}','${officer}',gen_random_uuid(),'PRIVATE_SYNTHETIC_DEBRIEF');
      set role authenticated;
      select public.start_shift_break('90000000-0000-4000-8000-000000000002','${shift}','meal');
      select pg_temp.ok(public.get_officer_attendance_readiness('${shift}')->>'open_break_count'='1','open break blocks completion');
      select pg_temp.fails($q$select public.complete_officer_static_shift('${shift}','in_progress',null,null,'Synthetic exception')$q$,'Finish required');
      reset role;
      select public.end_shift_break((select id from public.shift_breaks where shift_id='${shift}'),null);
      set role authenticated;
      select public.complete_officer_static_shift('${shift}','in_progress',null,null,'Synthetic exception');
      select public.complete_officer_static_shift('${shift}','in_progress',null,null,'Synthetic exception');
      reset role;
      select pg_temp.ok((select status='completed' and actual_end is not null from public.shifts where id='${shift}'),'shift completed');
      select pg_temp.ok((select status='completed' from public.shift_stops where id='${stop}'),'departure atomic');
      select pg_temp.ok((select count(*)=2 from public.shift_stop_actions where shift_id='${shift}'),'one arrival and one departure');
      select set_config('request.jwt.claim.sub','${admin}',false);
      set role authenticated;
      select pg_temp.fails($q$select public.get_officer_break_plan('${shift}')$q$,'Active assigned officer');
      reset role;
      insert into public.staff_profiles values('${officer}','${officer}','${org}',true);
      set role authenticated;
      select public.create_roster_slot_with_break('90000000-0000-4000-8000-000000000003','${unit}',null,now()+interval '1 day',now()+interval '1 day 8 hours',true,null,30,true);
      select public.create_roster_slot_with_break('90000000-0000-4000-8000-000000000004','${unit}','${officer}',now()+interval '2 days',now()+interval '2 days 8 hours',true,null,30,true);
      select public.create_roster_slot_with_break('90000000-0000-4000-8000-000000000004','${unit}','${officer}',now()+interval '2 days',now()+interval '2 days 8 hours',true,null,30,true);
      select pg_temp.fails($q$select public.create_roster_slot_with_break('90000000-0000-4000-8000-000000000004','${unit}','${officer}',now()+interval '2 days',now()+interval '2 days 8 hours',true,null,20,true)$q$,'different break plan');
      reset role;
      select pg_temp.ok((select status='published' and linked_shift_id is null and planned_break_minutes=30 from public.roster_slots where client_request_id='90000000-0000-4000-8000-000000000003'),'open slot does not materialize field shift');
      select pg_temp.ok((select status='published' and linked_shift_id='30000000-0000-4000-8000-000000000002' and planned_break_minutes=30 from public.roster_slots where client_request_id='90000000-0000-4000-8000-000000000004'),'assigned publication preserves break and linked shift');
      update public.roster_slots set status='draft' where id='${slot}';
      update public.roster_slots set staff_id='${officer}' where id='${slot}';
      set role authenticated;
      select public.set_roster_slot_break('${slot}','draft',30,true);
      select pg_temp.fails($q$select public.set_roster_slot_break('${slot}','draft',999,true)$q$,'check constraint');
      reset role;
      select pg_temp.ok((select planned_break_minutes=30 and break_unpaid from public.roster_slots where id='${slot}'),'break persisted after invalid retry');
      set role authenticated;
      select public.update_roster_slot_with_break('${slot}','draft','${officer}',now(),now()+interval '25 minutes',null,10,true);
      select pg_temp.fails($q$select public.update_roster_slot_with_break('${slot}','draft','${officer}',now(),now()+interval '25 minutes',null,30,true)$q$,'check constraint');
      select public.repeat_roster_slot_range('${slot}',current_date+3,current_date+3);
      reset role;
      select pg_temp.ok((select planned_break_minutes=10 and break_unpaid from public.roster_slots where id='${slot}'),'shortened plan persists after invalid update rollback');
      select pg_temp.ok((select count(*)=1 from public.roster_slots where scheduled_start::date=current_date+3 and planned_break_minutes=10 and break_unpaid),'repeated plan preserved');
      update public.roster_slots set planned_break_minutes=20 where id='${slot}';
      select set_config('request.jwt.claim.sub','${officer}',false);
      set role authenticated;
      select pg_temp.ok(public.get_officer_break_plan('${shift}')->>'planned_minutes'='20','officer reads plan');
      select pg_temp.fails($q$select public.set_roster_slot_break('${slot}','draft',20,false)$q$,'administrator');
      reset role;
      update public.user_profiles set deactivated_at=now() where id='${officer}';
      set role authenticated;
      select pg_temp.fails($q$select public.get_officer_attendance_readiness('${shift}')$q$,'Active officer');
      commit;
    `;
    try { docker(['exec', '-i', name, 'psql', '-X', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'], sql); }
    catch (error) { throw new Error(error.stderr || error.message); }
  } finally { if (created) docker(['rm', '--force', name]); }
});
