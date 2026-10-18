-- Behavioural contract for open roster slots and their field-shift handoff.
begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;
select plan(3);

create temporary table open_roster_test_results (
  label text not null,
  passed boolean not null
) on commit drop;
grant insert, select on open_roster_test_results to authenticated;

create or replace function pg_temp.as_user(p_user uuid)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;
end
$$;

create or replace function pg_temp.as_postgres()
returns void
language plpgsql
as $$
begin
  set local role postgres;
end
$$;

create or replace function pg_temp.check(p_label text, p_ok boolean)
returns void
language plpgsql
as $$
begin
  insert into open_roster_test_results (label, passed)
  values (p_label, coalesce(p_ok, false));
end
$$;

do $$
declare
  v_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_officer_one uuid := gen_random_uuid();
  v_officer_two uuid := gen_random_uuid();
  v_route uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid();
  v_slot public.roster_slots%rowtype;
  v_offer public.overtime_offers%rowtype;
  v_offer_id uuid;
  v_shift public.shifts%rowtype;
  v_reassigned record;
begin
  perform pg_temp.as_postgres();

  insert into public.organizations (
    id,
    name,
    organization_type,
    active,
    status
  )
  values (
    v_org,
    'Open roster flow test',
    'service_provider',
    true,
    'active'
  );

  insert into auth.users (id, instance_id, aud, role, email)
  values
    (
      v_admin,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'open-roster-admin@example.test'
    ),
    (
      v_officer_one,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'open-roster-one@example.test'
    ),
    (
      v_officer_two,
      '00000000-0000-0000-0000-000000000000',
      'authenticated',
      'authenticated',
      'open-roster-two@example.test'
    );

  insert into public.user_profiles (
    id,
    role,
    organization_id,
    employer_organization_id,
    display_name
  )
  values
    (v_admin, 'master', v_org, v_org, 'Roster Administrator'),
    (v_officer_one, 'officer', v_org, v_org, 'First Officer'),
    (v_officer_two, 'officer', v_org, v_org, 'Second Officer');

  insert into public.staff_profiles (
    id,
    organization_id,
    user_id,
    work_ready,
    overtime_eligible,
    seniority_date,
    role_code
  )
  values
    (
      v_officer_one,
      v_org,
      v_officer_one,
      true,
      true,
      current_date - 1000,
      'guard'
    ),
    (
      v_officer_two,
      v_org,
      v_officer_two,
      true,
      true,
      current_date - 100,
      'guard'
    );

  insert into public.patrol_routes (
    id,
    organization_id,
    name,
    route_type,
    is_active
  )
  values (
    v_route,
    v_org,
    'Open shift patrol',
    'patrol',
    true
  );

  insert into public.roster_work_units (
    id,
    organization_id,
    name,
    work_unit_type,
    service_type,
    patrol_route_id,
    active,
    created_by
  )
  values (
    v_unit,
    v_org,
    'Open shift patrol unit',
    'patrol',
    'patrol',
    v_route,
    true,
    v_admin
  );

  perform pg_temp.as_user(v_admin);

  select * into v_slot
  from public.create_roster_slot(
    gen_random_uuid(),
    v_unit,
    null,
    now() + interval '4 days',
    now() + interval '4 days 8 hours',
    true,
    'Advertise this open shift'
  );

  perform pg_temp.check(
    'administrator can create a published open slot',
    v_slot.staff_id is null
      and v_slot.status = 'published'
      and v_slot.linked_shift_id is null
  );

  perform public.offer_overtime_by_seniority(
    gen_random_uuid(),
    v_slot.id,
    1,
    60
  );

  select o.id into v_offer_id
  from public.overtime_offers o
  where o.roster_slot_id = v_slot.id
    and o.staff_id = v_officer_one
    and o.status = 'offered';

  perform pg_temp.as_user(v_officer_one);

  select * into v_offer
  from public.respond_to_overtime_offer(
    v_offer_id,
    'offered',
    'accepted',
    null
  );

  select s.* into v_slot
  from public.roster_slots s
  where s.id = v_slot.id;

  select sh.* into v_shift
  from public.shifts sh
  where sh.id = v_slot.linked_shift_id;

  perform pg_temp.check(
    'accepting an overtime offer assigns and materializes the field shift',
    v_offer.status = 'accepted'
      and v_slot.staff_id = v_officer_one
      and v_slot.status = 'accepted'
      and v_slot.linked_shift_id is not null
      and v_shift.roster_slot_id = v_slot.id
      and v_shift.officer_user_id = v_officer_one
      and v_shift.status = 'accepted'
  );

  perform pg_temp.as_user(v_admin);

  select * into v_slot
  from public.create_roster_slot(
    gen_random_uuid(),
    v_unit,
    null,
    now() + interval '6 days',
    now() + interval '6 days 8 hours',
    true,
    'Assign this open shift directly'
  );

  select * into v_reassigned
  from public.reassign_roster_slot(
    v_slot.id,
    'published',
    v_officer_two,
    'Supervisor assigned the available officer'
  );

  select sh.* into v_shift
  from public.shifts sh
  where sh.id = v_reassigned.shift_id;

  perform pg_temp.check(
    'administrative assignment materializes the field shift',
    v_reassigned.staff_id = v_officer_two
      and v_reassigned.slot_status = 'published'
      and v_reassigned.shift_id is not null
      and v_shift.roster_slot_id = v_reassigned.slot_id
      and v_shift.officer_user_id = v_officer_two
      and v_shift.status = 'published'
  );
end
$$;

select ok(r.passed, r.label)
from open_roster_test_results r;
select * from finish();
rollback;
