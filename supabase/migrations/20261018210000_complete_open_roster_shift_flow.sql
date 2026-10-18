-- Complete the governed open-shift lifecycle.
-- Open slots may be created without staff. Assignment through overtime acceptance
-- or administrative reassignment materializes and synchronizes the field shift.

create or replace function public.create_roster_slot(
  p_client_request_id uuid,
  p_work_unit_id uuid,
  p_staff_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_publish boolean default false,
  p_notes text default null
)
returns public.roster_slots
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_slot public.roster_slots%rowtype;
begin
  select u.* into v_unit
  from public.roster_work_units u
  where u.id = p_work_unit_id and u.active;

  if not found or not public.is_admin_for_org(v_unit.organization_id) then
    raise exception 'Active authorized work unit required';
  end if;

  if p_client_request_id is null then
    raise exception 'client_request_id is required';
  end if;
  if p_scheduled_start is null
    or p_scheduled_end is null
    or p_scheduled_start >= p_scheduled_end
    or p_scheduled_start < now() - interval '5 minutes'
    or p_scheduled_end - p_scheduled_start > interval '24 hours'
  then
    raise exception 'Slot timing is outside the accepted range';
  end if;

  select s.* into v_slot
  from public.roster_slots s
  where s.organization_id = v_unit.organization_id
    and s.client_request_id = p_client_request_id;
  if found then
    return v_slot;
  end if;

  if p_staff_id is not null then
    select sp.* into v_staff
    from public.staff_profiles sp
    where sp.id = p_staff_id and sp.work_ready;

    if not found or not (
      v_staff.organization_id = v_unit.organization_id
      or exists (
        select 1
        from public.staff_branch_authorisations sba
        where sba.user_id = v_staff.user_id
          and sba.branch_org_id = v_unit.organization_id
          and sba.status = 'active'
      )
    ) then
      raise exception 'Work-ready staff profile required';
    end if;

    if exists (
      select 1
      from public.leave_requests l
      where l.staff_id = p_staff_id
        and l.status = 'approved'
        and daterange(l.starts_on, l.ends_on, '[]')
          && daterange(p_scheduled_start::date, p_scheduled_end::date, '[]')
    ) then
      raise exception 'Staff member has approved leave';
    end if;

    if exists (
      select 1
      from public.roster_slots s
      where s.staff_id = p_staff_id
        and s.status not in ('declined', 'cancelled')
        and s.scheduled_start < p_scheduled_end
        and s.scheduled_end > p_scheduled_start
    ) then
      raise exception 'Staff member already has an overlapping roster slot';
    end if;
  end if;

  insert into public.roster_slots (
    organization_id,
    work_unit_id,
    staff_id,
    scheduled_start,
    scheduled_end,
    status,
    client_request_id,
    notes,
    created_by
  )
  values (
    v_unit.organization_id,
    v_unit.id,
    p_staff_id,
    p_scheduled_start,
    p_scheduled_end,
    case when p_publish then 'published' else 'draft' end,
    p_client_request_id,
    nullif(trim(coalesce(p_notes, '')), ''),
    v_actor
  )
  returning * into v_slot;

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_unit.organization_id,
    v_actor,
    'roster_slot_created',
    'roster_slots',
    v_slot.id,
    jsonb_build_object(
      'work_unit_id', v_unit.id,
      'work_unit_type', v_unit.work_unit_type,
      'staff_id', p_staff_id,
      'is_open', p_staff_id is null,
      'status', v_slot.status
    )
  );

  return v_slot;
end;
$function$;

create or replace function public.materialize_roster_slot_core(
  p_slot_id uuid,
  p_expected_status text
)
returns table(slot_id uuid, shift_id uuid, created boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_user uuid;
  v_shift public.shifts%rowtype;
  v_shift_status text;
  v_sal public.service_agreement_locations%rowtype;
  v_site_location uuid;
  v_stop uuid;
  v_fatigue_conflict text;
begin
  select s.* into v_slot
  from public.roster_slots s
  where s.id = p_slot_id
  for update;
  if not found then
    raise exception 'Roster slot not found';
  end if;
  if v_slot.status <> p_expected_status then
    raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status;
  end if;

  select u.* into v_unit
  from public.roster_work_units u
  where u.id = v_slot.work_unit_id
    and u.organization_id = v_slot.organization_id
    and u.active;
  if not found then
    raise exception 'Active work unit not found';
  end if;
  if v_unit.work_unit_type = 'internal' then
    raise exception 'Internal roster slots do not materialize field shifts';
  end if;

  select sp.* into v_staff
  from public.staff_profiles sp
  where sp.id = v_slot.staff_id and sp.work_ready;
  if not found or not (
    v_staff.organization_id = v_slot.organization_id
    or exists (
      select 1
      from public.staff_branch_authorisations sba
      where sba.user_id = v_staff.user_id
        and sba.branch_org_id = v_slot.organization_id
        and sba.status = 'active'
    )
  ) then
    raise exception 'Work-ready staff profile required';
  end if;

  v_user := coalesce(v_staff.user_id, v_staff.id);
  if not exists (
    select 1
    from public.user_profiles up
    where up.id = v_user
      and up.deactivated_at is null
      and up.role in ('officer', 'admin_officer')
  ) then
    raise exception 'Roster slot staff is not an active field officer';
  end if;

  if v_slot.scheduled_start < now() - interval '5 minutes'
    or v_slot.scheduled_end <= v_slot.scheduled_start
    or v_slot.scheduled_end - v_slot.scheduled_start > interval '24 hours'
  then
    raise exception 'Slot timing is outside the accepted range';
  end if;

  if exists (
    select 1
    from public.leave_requests l
    where l.staff_id = v_staff.id
      and l.status = 'approved'
      and daterange(l.starts_on, l.ends_on, '[]')
        && daterange(v_slot.scheduled_start::date, v_slot.scheduled_end::date, '[]')
  ) then
    raise exception 'Staff member has approved leave';
  end if;

  if public.staff_has_roster_availability_conflict(
    v_staff.id,
    v_slot.scheduled_start,
    v_slot.scheduled_end
  ) then
    raise exception 'Staff member is unavailable during this roster slot';
  end if;

  v_fatigue_conflict := public.staff_fatigue_conflict(
    v_staff.id,
    v_slot.scheduled_start,
    v_slot.scheduled_end,
    v_slot.id
  );
  if v_fatigue_conflict is not null then
    raise exception 'Fatigue rule breach: %', v_fatigue_conflict;
  end if;

  if exists (
    select 1
    from public.shifts s
    where s.id <> coalesce(v_slot.linked_shift_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and s.officer_user_id = v_user
      and s.status not in ('declined', 'cancelled')
      and s.scheduled_start < v_slot.scheduled_end
      and s.scheduled_end > v_slot.scheduled_start
  ) then
    raise exception 'Officer already has an overlapping field shift';
  end if;

  v_shift_status := case when v_slot.status = 'accepted' then 'accepted' else 'published' end;

  if v_slot.linked_shift_id is not null then
    select s.* into v_shift
    from public.shifts s
    where s.id = v_slot.linked_shift_id
    for update;
    if not found then
      raise exception 'Linked field shift not found';
    end if;

    if v_shift.officer_user_id <> v_user then
      if v_shift.status not in ('published', 'accepted', 'declined')
        or v_shift.actual_start is not null
      then
        raise exception 'Field shift has started or is no longer reassignable';
      end if;
      if exists (
        select 1 from public.patrols p
        where p.shift_id = v_shift.id and p.status = 'in_progress'
      ) then
        raise exception 'Active patrol prevents reassignment';
      end if;
      if exists (
        select 1 from public.dispatch_jobs d
        where d.shift_id = v_shift.id
          and d.status in ('pending', 'pending_approval', 'dispatched', 'acknowledged', 'en_route', 'on_scene')
      ) then
        raise exception 'Active dispatch work prevents reassignment';
      end if;
      if exists (
        select 1 from public.shift_stop_actions a
        where a.shift_id = v_shift.id
      ) then
        raise exception 'Recorded field activity prevents reassignment';
      end if;
    end if;

    update public.shifts
    set officer_user_id = v_user,
        status = v_shift_status
    where id = v_shift.id
    returning * into v_shift;

    return query select v_slot.id, v_shift.id, false;
    return;
  end if;

  if v_unit.work_unit_type = 'patrol' then
    insert into public.shifts (
      organization_id,
      officer_user_id,
      service_type,
      patrol_route_id,
      scheduled_start,
      scheduled_end,
      status,
      notes,
      roster_slot_id
    )
    values (
      v_slot.organization_id,
      v_user,
      v_unit.service_type,
      v_unit.patrol_route_id,
      v_slot.scheduled_start,
      v_slot.scheduled_end,
      v_shift_status,
      v_slot.notes,
      v_slot.id
    )
    returning * into v_shift;

    perform public.generate_shift_stops(
      v_shift.id,
      (v_slot.scheduled_start at time zone 'Pacific/Auckland')::date
    );
  elsif v_unit.work_unit_type = 'static' then
    select sal.* into v_sal
    from public.service_agreement_locations sal
    where sal.id = v_unit.service_agreement_location_id
      and sal.status = 'active';
    if not found or not exists (
      select 1
      from public.service_agreement_modules sam
      where sam.id = v_unit.service_agreement_module_id
        and sam.service_agreement_id = v_sal.service_agreement_id
        and sam.enabled
        and sam.module_key = 'static_guarding'
    ) then
      raise exception 'Static work unit contract is no longer active';
    end if;

    if v_sal.site_id is not null then
      select cs.location_id into v_site_location
      from public.client_sites cs
      where cs.id = v_sal.site_id;
    end if;

    insert into public.shifts (
      organization_id,
      officer_user_id,
      service_type,
      location_id,
      zone_id,
      scheduled_start,
      scheduled_end,
      status,
      notes,
      roster_slot_id,
      service_agreement_location_id,
      service_agreement_module_id,
      total_stops,
      generated_at
    )
    values (
      v_slot.organization_id,
      v_user,
      v_unit.service_type,
      v_site_location,
      v_sal.zone_id,
      v_slot.scheduled_start,
      v_slot.scheduled_end,
      v_shift_status,
      v_slot.notes,
      v_slot.id,
      v_unit.service_agreement_location_id,
      v_unit.service_agreement_module_id,
      1,
      clock_timestamp()
    )
    returning * into v_shift;

    insert into public.shift_stops (
      organization_id,
      shift_id,
      site_id,
      zone_id,
      module_key,
      stop_order,
      visit_number,
      is_adhoc,
      sla_arrive_by,
      required_dwell_minutes,
      status,
      sla_status,
      officer_notes
    )
    values (
      v_slot.organization_id,
      v_shift.id,
      v_sal.site_id,
      v_sal.zone_id,
      'static_guarding',
      1,
      1,
      false,
      v_slot.scheduled_start,
      0,
      'pending',
      'on_track',
      v_slot.notes
    )
    returning id into v_stop;

    insert into public.shift_stop_modules (
      organization_id,
      shift_stop_id,
      module_key,
      is_required,
      service_agreement_module_id,
      service_agreement_location_id
    )
    values (
      v_slot.organization_id,
      v_stop,
      'static_guarding',
      true,
      v_unit.service_agreement_module_id,
      v_unit.service_agreement_location_id
    );
  else
    raise exception 'Unsupported field work unit type';
  end if;

  update public.roster_slots
  set linked_shift_id = v_shift.id
  where id = v_slot.id;

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_slot.organization_id,
    v_actor,
    'roster_shift_created',
    'shifts',
    v_shift.id,
    jsonb_build_object(
      'officer_user_id', v_user,
      'staff_id', v_staff.id,
      'roster_slot_id', v_slot.id,
      'status', v_shift.status
    )
  );

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_slot.organization_id,
    v_actor,
    'roster_slot_materialized',
    'roster_slots',
    v_slot.id,
    jsonb_build_object(
      'work_unit_id', v_unit.id,
      'work_unit_type', v_unit.work_unit_type,
      'shift_id', v_shift.id
    )
  );

  return query select v_slot.id, v_shift.id, true;
end;
$function$;

revoke all on function public.materialize_roster_slot_core(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.materialize_roster_slot_core(uuid, text) to postgres;

create or replace function public.materialize_roster_slot(
  p_slot_id uuid,
  p_expected_status text default 'published'
)
returns table(slot_id uuid, shift_id uuid, created boolean)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_slot public.roster_slots%rowtype;
begin
  select s.* into v_slot
  from public.roster_slots s
  where s.id = p_slot_id;
  if not found then
    raise exception 'Roster slot not found';
  end if;
  if not public.is_admin_for_org(v_slot.organization_id) then
    raise exception 'Not authorised to materialize this roster slot';
  end if;

  return query
  select *
  from public.materialize_roster_slot_core(p_slot_id, p_expected_status);
end;
$function$;

create or replace function public.reassign_roster_slot(
  p_slot_id uuid,
  p_expected_status text,
  p_new_staff_id uuid,
  p_reason text
)
returns table(slot_id uuid, slot_status text, staff_id uuid, shift_id uuid, shift_status text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_old_staff_id uuid;
  v_new_status text;
  v_materialized record;
begin
  select s.* into v_slot
  from public.roster_slots s
  where s.id = p_slot_id
  for update;
  if not found then
    raise exception 'Roster slot not found';
  end if;
  if not public.is_admin_for_org(v_slot.organization_id) then
    raise exception 'Not authorised to reassign this roster slot';
  end if;
  if v_slot.status <> p_expected_status then
    raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status;
  end if;
  if v_slot.status not in ('draft', 'published', 'accepted', 'declined') then
    raise exception 'This roster slot can no longer be reassigned';
  end if;
  if p_new_staff_id = v_slot.staff_id then
    raise exception 'Select a different staff member';
  end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Reassignment reason is required';
  end if;

  select u.* into v_unit
  from public.roster_work_units u
  where u.id = v_slot.work_unit_id
    and u.organization_id = v_slot.organization_id
    and u.active;
  if not found then
    raise exception 'Active work unit not found';
  end if;

  select sp.* into v_staff
  from public.staff_profiles sp
  where sp.id = p_new_staff_id and sp.work_ready
    and (
      sp.organization_id = v_slot.organization_id
      or exists (
        select 1
        from public.staff_branch_authorisations sba
        where sba.user_id = sp.user_id
          and sba.branch_org_id = v_slot.organization_id
          and sba.status = 'active'
      )
    );
  if not found then
    raise exception 'Work-ready staff profile required';
  end if;

  v_old_staff_id := v_slot.staff_id;
  v_new_status := case when v_slot.status = 'draft' then 'draft' else 'published' end;

  update public.roster_slots rs
  set staff_id = p_new_staff_id,
      status = v_new_status,
      notes = concat_ws(E'\n', nullif(rs.notes, ''), 'Reassigned: ' || trim(p_reason))
  where rs.id = v_slot.id
  returning rs.* into v_slot;

  if v_unit.work_unit_type <> 'internal' and v_slot.status <> 'draft' then
    select * into v_materialized
    from public.materialize_roster_slot_core(v_slot.id, v_slot.status);
    v_slot.linked_shift_id := v_materialized.shift_id;
  end if;

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_slot.organization_id,
    v_actor,
    'roster_slot_reassigned',
    'roster_slots',
    v_slot.id,
    jsonb_build_object(
      'work_unit_id', v_unit.id,
      'old_staff_id', v_old_staff_id,
      'new_staff_id', p_new_staff_id,
      'linked_shift_id', v_slot.linked_shift_id,
      'reason', trim(p_reason)
    )
  );

  return query
  select
    v_slot.id,
    v_slot.status,
    v_slot.staff_id,
    v_slot.linked_shift_id,
    (
      select s.status
      from public.shifts s
      where s.id = v_slot.linked_shift_id
    );
end;
$function$;

create or replace function public.respond_to_overtime_offer(
  p_offer_id uuid,
  p_expected_status text,
  p_response text,
  p_decline_reason text default null
)
returns public.overtime_offers
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor uuid := auth.uid();
  v_offer public.overtime_offers%rowtype;
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_reason text := nullif(trim(coalesce(p_decline_reason, '')), '');
begin
  select o.* into v_offer
  from public.overtime_offers o
  where o.id = p_offer_id
  for update;
  if not found then
    raise exception 'Overtime offer not found';
  end if;

  select sp.* into v_staff
  from public.staff_profiles sp
  where sp.id = v_offer.staff_id
    and sp.work_ready
    and (sp.user_id = v_actor or sp.id = v_actor);
  if not found then
    raise exception 'Only the offered work-ready staff member can respond';
  end if;

  if v_offer.status <> p_expected_status then
    raise exception 'Overtime offer changed from expected status % to %', p_expected_status, v_offer.status;
  end if;
  if v_offer.status <> 'offered' then
    raise exception 'Only open overtime offers can be answered';
  end if;
  if v_offer.expires_at < now() then
    update public.overtime_offers
    set status = 'expired'
    where id = v_offer.id
    returning * into v_offer;
    raise exception 'This overtime offer has expired';
  end if;
  if p_response not in ('accepted', 'declined') then
    raise exception 'Response must be accepted or declined';
  end if;

  if p_response = 'declined' then
    update public.overtime_offers
    set status = 'declined',
        decline_reason = v_reason,
        responded_at = now()
    where id = v_offer.id
    returning * into v_offer;
  else
    select s.* into v_slot
    from public.roster_slots s
    where s.id = v_offer.roster_slot_id
    for update;
    if not found or v_slot.status not in ('draft', 'published', 'declined') then
      raise exception 'Roster slot is no longer available';
    end if;

    select u.* into v_unit
    from public.roster_work_units u
    where u.id = v_slot.work_unit_id
      and u.organization_id = v_slot.organization_id
      and u.active;
    if not found then
      raise exception 'Active work unit not found';
    end if;

    if exists (
      select 1
      from public.roster_slots s
      where s.id <> v_slot.id
        and s.staff_id = v_staff.id
        and s.status not in ('declined', 'cancelled')
        and s.scheduled_start < v_slot.scheduled_end
        and s.scheduled_end > v_slot.scheduled_start
    ) then
      raise exception 'Staff member already has an overlapping roster slot';
    end if;

    update public.roster_slots
    set staff_id = v_offer.staff_id,
        status = 'accepted'
    where id = v_slot.id
    returning * into v_slot;

    if v_unit.work_unit_type <> 'internal' then
      perform public.materialize_roster_slot_core(v_slot.id, 'accepted');
      select s.* into v_slot
      from public.roster_slots s
      where s.id = v_slot.id;
    end if;

    update public.overtime_offers
    set status = 'accepted',
        responded_at = now()
    where id = v_offer.id
    returning * into v_offer;

    update public.overtime_offers
    set status = 'withdrawn'
    where roster_slot_id = v_offer.roster_slot_id
      and status = 'offered'
      and id <> v_offer.id;
  end if;

  insert into public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  values (
    v_offer.organization_id,
    v_actor,
    'overtime_offer_answered',
    'overtime_offers',
    v_offer.id,
    jsonb_build_object(
      'response', p_response,
      'roster_slot_id', v_offer.roster_slot_id,
      'seniority_position', v_offer.seniority_position,
      'decline_reason', v_reason,
      'linked_shift_id', v_slot.linked_shift_id
    )
  );

  return v_offer;
end;
$function$;
