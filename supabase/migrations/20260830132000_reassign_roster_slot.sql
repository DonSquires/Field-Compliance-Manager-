create function public.reassign_roster_slot(p_slot_id uuid,p_expected_status text,p_new_staff_id uuid,p_reason text)
returns table(slot_id uuid,slot_status text,staff_id uuid,shift_id uuid,shift_status text) language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_slot public.roster_slots%rowtype;v_unit public.roster_work_units%rowtype;v_staff public.staff_profiles%rowtype;v_shift public.shifts%rowtype;v_old_staff_id uuid;v_new_status text;
begin
  select s.* into v_slot from public.roster_slots s where s.id=p_slot_id for update;if not found then raise exception 'Roster slot not found';end if;
  if not public.is_admin_for_org(v_slot.organization_id) then raise exception 'Not authorised to reassign this roster slot';end if;
  if v_slot.status<>p_expected_status then raise exception 'Roster slot changed from expected status % to %',p_expected_status,v_slot.status;end if;
  if v_slot.status not in('draft','published','accepted','declined') then raise exception 'This roster slot can no longer be reassigned';end if;
  if p_new_staff_id=v_slot.staff_id then raise exception 'Select a different staff member';end if;
  if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Reassignment reason is required';end if;
  select u.* into v_unit from public.roster_work_units u where u.id=v_slot.work_unit_id and u.organization_id=v_slot.organization_id and u.active;if not found then raise exception 'Active work unit not found';end if;
  select sp.* into v_staff from public.staff_profiles sp where sp.id=p_new_staff_id and sp.organization_id=v_slot.organization_id and sp.work_ready;if not found then raise exception 'Work-ready staff profile required';end if;
  if v_staff.user_id is null or not exists(select 1 from public.user_profiles up where up.id=v_staff.user_id and up.organization_id=v_slot.organization_id and up.deactivated_at is null and up.role in('officer','admin_officer')) then raise exception 'Replacement staff is not an active roster officer';end if;
  if exists(select 1 from public.leave_requests l where l.staff_id=p_new_staff_id and l.status='approved' and daterange(l.starts_on,l.ends_on,'[]')&&daterange(v_slot.scheduled_start::date,v_slot.scheduled_end::date,'[]')) then raise exception 'Replacement staff member has approved leave';end if;
  if exists(select 1 from public.roster_slots s where s.id<>v_slot.id and s.staff_id=p_new_staff_id and s.status not in('declined','cancelled') and s.scheduled_start<v_slot.scheduled_end and s.scheduled_end>v_slot.scheduled_start) then raise exception 'Replacement staff member has an overlapping roster slot';end if;
  if exists(select 1 from public.shifts s where s.id<>coalesce(v_slot.linked_shift_id,'00000000-0000-0000-0000-000000000000'::uuid) and s.officer_user_id=v_staff.user_id and s.status not in('declined','cancelled') and s.scheduled_start<v_slot.scheduled_end and s.scheduled_end>v_slot.scheduled_start) then raise exception 'Replacement officer has an overlapping field shift';end if;
  if v_slot.linked_shift_id is not null then
    select s.* into v_shift from public.shifts s where s.id=v_slot.linked_shift_id for update;if not found then raise exception 'Linked field shift not found';end if;
    if v_shift.status not in('published','accepted','declined') or v_shift.actual_start is not null then raise exception 'Field shift has started or is no longer reassignable';end if;
    if exists(select 1 from public.patrols p where p.shift_id=v_shift.id and p.status='in_progress') then raise exception 'Active patrol prevents reassignment';end if;
    if exists(select 1 from public.dispatch_jobs d where d.shift_id=v_shift.id and d.status in('pending','pending_approval','dispatched','acknowledged','en_route','on_scene')) then raise exception 'Active dispatch work prevents reassignment';end if;
    if exists(select 1 from public.shift_stop_actions a where a.shift_id=v_shift.id) then raise exception 'Recorded field activity prevents reassignment';end if;
    update public.shifts sh set officer_user_id=v_staff.user_id,status='published',notes=concat_ws(E'\n',nullif(sh.notes,''),'Reassigned: '||trim(p_reason)) where sh.id=v_shift.id returning sh.* into v_shift;
  end if;
  v_old_staff_id:=v_slot.staff_id;v_new_status:=case when v_slot.status='draft' then 'draft' else 'published' end;
  update public.roster_slots rs set staff_id=p_new_staff_id,status=v_new_status,notes=concat_ws(E'\n',nullif(rs.notes,''),'Reassigned: '||trim(p_reason)) where rs.id=v_slot.id returning rs.* into v_slot;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_slot.organization_id,v_actor,'roster_slot_reassigned','roster_slots',v_slot.id,jsonb_build_object('work_unit_id',v_unit.id,'old_staff_id',v_old_staff_id,'new_staff_id',p_new_staff_id,'linked_shift_id',v_slot.linked_shift_id,'reason',trim(p_reason)));
  return query select v_slot.id,v_slot.status,v_slot.staff_id,v_slot.linked_shift_id,case when v_shift.id is null then null else v_shift.status end;
end;$$;
revoke all on function public.reassign_roster_slot(uuid,text,uuid,text) from public,anon;
grant execute on function public.reassign_roster_slot(uuid,text,uuid,text) to authenticated,service_role;