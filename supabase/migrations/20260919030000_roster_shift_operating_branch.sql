-- Roster shifts belong to the operating branch that rostered them, not the officer's home organisation.
--
-- Before: create_roster_shift authorised the actor against the OFFICER's home organisation
-- (user_profiles.organization_id), looked the staff profile up in that same organisation, and
-- stamped shifts.organization_id + the audit row with it. materialize_roster_slot then overwrote
-- shifts.organization_id with the slot's branch. Result: an officer whose home organisation is not
-- the branch's parent (e.g. home Iron Eagle, employed by First Security, authorised to be rostered
-- at First Security Nelson) could appear on the Nelson roster board yet fail at publish with
-- "Not authorised to roster this officer", and every roster_shift_created audit row landed in the
-- officer's home organisation instead of the branch that did the rostering.
--
-- After: an optional p_organization_id names the operating organisation. The actor must be an
-- administrator for it; the officer must either belong to it or hold an active, rosterable
-- branch authorisation for it; the staff profile is resolved through the officer's employer; the
-- shift and its audit row are stamped with it. Callers that pass nothing keep the old behaviour.
-- Doctrine: "a guard on a place for a shift" for the operating branch (docs/canon, unified field
-- operations model); "employment remains corporate; branch authorisations control delivery access".

drop function if exists public.create_roster_shift(uuid, text, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid, text, boolean);

create or replace function public.create_roster_shift(
  p_officer_user_id uuid,
  p_service_type text,
  p_scheduled_start timestamp with time zone,
  p_scheduled_end timestamp with time zone,
  p_location_id uuid default null,
  p_zone_id uuid default null,
  p_patrol_route_id uuid default null,
  p_notes text default null,
  p_publish boolean default false,
  p_organization_id uuid default null
) returns public.shifts
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_shift public.shifts%rowtype;
  v_org uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select * into v_profile from public.user_profiles where id = p_officer_user_id and deactivated_at is null;
  if not found or v_profile.organization_id is null then raise exception 'Active officer profile not found'; end if;

  v_org := coalesce(p_organization_id, v_profile.organization_id);
  if not exists (select 1 from public.organizations o where o.id = v_org and o.active) then raise exception 'Operating organisation not found'; end if;
  if not public.is_admin_for_org(v_org) then raise exception 'Not authorised to roster for this organisation'; end if;
  if v_profile.role not in ('officer', 'admin_officer') then raise exception 'Selected user is not rosterable as an officer'; end if;

  -- The officer works at their home organisation, or at a branch that has authorised them to be rostered there.
  if v_org <> v_profile.organization_id and not exists (
    select 1 from public.staff_branch_authorisations a
    where a.user_id = p_officer_user_id
      and a.branch_org_id = v_org
      and a.status = 'active'
      and a.can_be_rostered
      and (a.starts_on is null or a.starts_on <= current_date)
      and (a.ends_on is null or a.ends_on >= current_date)
  ) then raise exception 'Officer is not authorised to be rostered at this branch'; end if;

  -- Employment is corporate: the staff profile lives with the employer, which may be the branch's parent.
  select s.* into v_staff
  from public.staff_profiles s
  where (s.id = p_officer_user_id or s.user_id = p_officer_user_id)
    and (
      s.organization_id = v_org
      or s.organization_id = v_profile.organization_id
      or s.organization_id = v_profile.employer_organization_id
      or v_org = any(public.get_descendant_organizations(s.organization_id))
    )
  order by (s.organization_id = v_org) desc, (s.organization_id = v_profile.employer_organization_id) desc, (s.organization_id = v_profile.organization_id) desc
  limit 1;
  if not found or not v_staff.work_ready then raise exception 'Officer is not work ready'; end if;

  if p_scheduled_start is null or p_scheduled_end is null or p_scheduled_start >= p_scheduled_end then raise exception 'Shift end must be after shift start'; end if;
  if p_scheduled_start < now() - interval '5 minutes' or p_scheduled_end - p_scheduled_start > interval '24 hours' then raise exception 'Shift timing is outside the accepted range'; end if;
  if nullif(trim(coalesce(p_service_type, '')), '') is null then raise exception 'Service type is required'; end if;
  if exists (
    select 1 from public.leave_requests l
    where l.staff_id = v_staff.id and l.status = 'approved'
      and daterange(l.starts_on, l.ends_on, '[]') && daterange(p_scheduled_start::date, p_scheduled_end::date, '[]')
  ) then raise exception 'Officer has approved leave during this shift'; end if;
  if exists (
    select 1 from public.shifts s
    where s.officer_user_id = p_officer_user_id
      and s.status not in ('declined', 'cancelled')
      and s.scheduled_end > s.scheduled_start
      and s.scheduled_start < p_scheduled_end
      and s.scheduled_end > p_scheduled_start
  ) then raise exception 'Officer already has an overlapping shift'; end if;

  insert into public.shifts(organization_id, officer_user_id, service_type, location_id, zone_id, patrol_route_id, scheduled_start, scheduled_end, status, notes)
  values (v_org, p_officer_user_id, trim(p_service_type), p_location_id, p_zone_id, p_patrol_route_id, p_scheduled_start, p_scheduled_end, case when p_publish then 'published' else 'scheduled' end, nullif(trim(coalesce(p_notes, '')), ''))
  returning * into v_shift;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org, v_actor, 'roster_shift_created', 'shifts', v_shift.id, jsonb_build_object(
    'officer_user_id', p_officer_user_id,
    'officer_home_organization_id', v_profile.organization_id,
    'staff_id', v_staff.id,
    'scheduled_start', p_scheduled_start,
    'scheduled_end', p_scheduled_end,
    'status', v_shift.status
  ));
  return v_shift;
end;
$$;

revoke all on function public.create_roster_shift(uuid, text, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid, text, boolean, uuid) from public, anon, authenticated, service_role;
grant execute on function public.create_roster_shift(uuid, text, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid, text, boolean, uuid) to postgres, authenticated, service_role;
comment on function public.create_roster_shift(uuid, text, timestamp with time zone, timestamp with time zone, uuid, uuid, uuid, text, boolean, uuid) is
  'Creates a field shift for an officer at the operating organisation p_organization_id (default: the officer''s home organisation). The actor must administer that organisation; the officer must belong to it or hold an active rosterable branch authorisation for it. Stamps the shift and its audit row with the operating organisation.';

-- The roster slot knows its branch; hand it down so the shift is born in the right organisation.
CREATE OR REPLACE FUNCTION "public"."materialize_roster_slot"(p_slot_id uuid, p_expected_status text DEFAULT 'published'::text)
 RETURNS TABLE(slot_id uuid, shift_id uuid, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_user uuid;
  v_shift public.shifts%rowtype;
  v_sal public.service_agreement_locations%rowtype;
  v_site_location uuid;
  v_stop uuid;
BEGIN
  SELECT s.* INTO v_slot FROM public.roster_slots s WHERE s.id=p_slot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Roster slot not found'; END IF;
  IF NOT public.is_admin_for_org(v_slot.organization_id) THEN RAISE EXCEPTION 'Not authorised to materialize this roster slot'; END IF;
  IF v_slot.status <> p_expected_status THEN RAISE EXCEPTION 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status; END IF;
  IF v_slot.linked_shift_id IS NOT NULL THEN RETURN QUERY SELECT v_slot.id,v_slot.linked_shift_id,false; RETURN; END IF;

  SELECT u.* INTO v_unit FROM public.roster_work_units u WHERE u.id=v_slot.work_unit_id AND u.organization_id=v_slot.organization_id AND u.active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active work unit not found'; END IF;
  IF v_unit.work_unit_type='internal' THEN RAISE EXCEPTION 'Internal roster slots do not materialize field shifts'; END IF;

  SELECT sp.* INTO v_staff
  FROM public.staff_profiles sp
  WHERE sp.id=v_slot.staff_id AND sp.work_ready;
  IF NOT FOUND OR NOT (
    v_staff.organization_id = v_slot.organization_id
    OR EXISTS(
      SELECT 1 FROM public.staff_branch_authorisations sba
      WHERE sba.user_id = v_staff.user_id
        AND sba.branch_org_id = v_slot.organization_id
        AND sba.status = 'active'
    )
  ) THEN RAISE EXCEPTION 'Work-ready staff profile required'; END IF;

  v_user := coalesce(v_staff.user_id,v_staff.id);
  IF NOT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id=v_user AND up.deactivated_at IS NULL AND up.role IN('officer','admin_officer')) THEN RAISE EXCEPTION 'Roster slot staff is not an active field officer'; END IF;

  IF v_unit.work_unit_type='patrol' THEN
    SELECT * INTO v_shift FROM public.create_roster_shift(v_user,v_unit.service_type,v_slot.scheduled_start,v_slot.scheduled_end,NULL,NULL,v_unit.patrol_route_id,v_slot.notes,true,v_slot.organization_id);
    UPDATE public.shifts SET roster_slot_id=v_slot.id WHERE id=v_shift.id RETURNING * INTO v_shift;
    PERFORM public.generate_shift_stops(v_shift.id,(v_slot.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date);
  ELSIF v_unit.work_unit_type='static' THEN
    SELECT sal.* INTO v_sal FROM public.service_agreement_locations sal WHERE sal.id=v_unit.service_agreement_location_id AND sal.status='active';
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.service_agreement_modules sam WHERE sam.id=v_unit.service_agreement_module_id AND sam.service_agreement_id=v_sal.service_agreement_id AND sam.enabled AND sam.module_key='static_guarding') THEN RAISE EXCEPTION 'Static work unit contract is no longer active'; END IF;
    IF v_sal.site_id IS NOT NULL THEN SELECT cs.location_id INTO v_site_location FROM public.client_sites cs WHERE cs.id=v_sal.site_id; END IF;
    SELECT * INTO v_shift FROM public.create_roster_shift(v_user,v_unit.service_type,v_slot.scheduled_start,v_slot.scheduled_end,v_site_location,v_sal.zone_id,NULL,v_slot.notes,true,v_slot.organization_id);
    UPDATE public.shifts
    SET roster_slot_id=v_slot.id,
        service_agreement_location_id=v_unit.service_agreement_location_id,
        service_agreement_module_id=v_unit.service_agreement_module_id,
        total_stops=1,
        generated_at=clock_timestamp()
    WHERE id=v_shift.id
    RETURNING * INTO v_shift;
    INSERT INTO public.shift_stops(organization_id,shift_id,site_id,zone_id,module_key,stop_order,visit_number,is_adhoc,sla_arrive_by,required_dwell_minutes,status,sla_status,officer_notes)
    VALUES(v_slot.organization_id,v_shift.id,v_sal.site_id,v_sal.zone_id,'static_guarding',1,1,false,v_slot.scheduled_start,0,'pending','on_track',v_slot.notes)
    RETURNING id INTO v_stop;
    INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required,service_agreement_module_id,service_agreement_location_id)
    VALUES(v_slot.organization_id,v_stop,'static_guarding',true,v_unit.service_agreement_module_id,v_unit.service_agreement_location_id);
  ELSE
    RAISE EXCEPTION 'Unsupported field work unit type';
  END IF;

  UPDATE public.roster_slots SET linked_shift_id=v_shift.id WHERE id=v_slot.id;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_slot.organization_id,v_actor,'roster_slot_materialized','roster_slots',v_slot.id,jsonb_build_object('work_unit_id',v_unit.id,'work_unit_type',v_unit.work_unit_type,'shift_id',v_shift.id));
  RETURN QUERY SELECT v_slot.id,v_shift.id,true;
END;
$function$;

-- Audit rows written for branch-rostered shifts before this migration name the officer's home organisation.
-- Re-home them to the branch that owns the shift so the branch's audit trail is complete.
with moved as (
  update public.audit_log a
  set organization_id = s.organization_id,
      metadata = a.metadata || jsonb_build_object('rehomed_from_organization_id', a.organization_id, 'rehomed_by_migration', '20260919030000_roster_shift_operating_branch')
  from public.shifts s
  where a.target_table = 'shifts' and a.action = 'roster_shift_created' and a.target_id = s.id and a.organization_id <> s.organization_id
  returning a.id
)
select count(*) as rehomed_audit_rows from moved;
