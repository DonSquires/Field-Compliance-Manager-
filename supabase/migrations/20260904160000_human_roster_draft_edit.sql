-- Human-controlled edits for Bob-created draft plans. Published, accepted,
-- in-progress, completed, and cancelled slots remain outside this RPC.
CREATE OR REPLACE FUNCTION public.update_roster_slot(
  p_slot_id uuid,
  p_expected_status text,
  p_staff_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_notes text DEFAULT NULL
)
RETURNS public.roster_slots
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_staff public.staff_profiles%rowtype;
begin
  select s.* into v_slot from public.roster_slots s where s.id = p_slot_id for update;
  if not found then raise exception 'Roster slot not found'; end if;
  if not public.is_admin_for_org(v_slot.organization_id) then raise exception 'Not authorised to edit this roster slot'; end if;
  if v_slot.status <> p_expected_status then raise exception 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status; end if;
  if v_slot.status <> 'draft' then raise exception 'Only draft roster slots can be edited'; end if;
  if p_scheduled_end <= p_scheduled_start then raise exception 'Roster slot must end after it starts'; end if;

  select sp.* into v_staff from public.staff_profiles sp where sp.id = p_staff_id;
  if not found or v_staff.organization_id <> v_slot.organization_id or not v_staff.work_ready then raise exception 'Assigned staff member is not work-ready'; end if;
  if public.staff_has_roster_availability_conflict(v_staff.id, p_scheduled_start, p_scheduled_end) then raise exception 'Staff member is unavailable during this roster slot'; end if;
  if public.staff_fatigue_conflict(v_staff.id, p_scheduled_start, p_scheduled_end, v_slot.id) is not null then raise exception 'Fatigue rule breach for assigned staff'; end if;

  update public.roster_slots set staff_id = p_staff_id, scheduled_start = p_scheduled_start, scheduled_end = p_scheduled_end, notes = nullif(trim(coalesce(p_notes, '')), '') where id = v_slot.id returning * into v_slot;
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_slot.organization_id, v_actor, 'roster_slot_human_edited', 'roster_slots', v_slot.id, jsonb_build_object('staff_id', p_staff_id, 'scheduled_start', p_scheduled_start, 'scheduled_end', p_scheduled_end));
  return v_slot;
end;
$$;

REVOKE ALL ON FUNCTION public.update_roster_slot(uuid,text,uuid,timestamptz,timestamptz,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_roster_slot(uuid,text,uuid,timestamptz,timestamptz,text) TO authenticated, service_role;
