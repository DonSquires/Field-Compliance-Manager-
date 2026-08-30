create function public.manage_roster_slot(p_slot_id uuid,p_expected_status text,p_action text,p_reason text default null)
returns table(slot_id uuid,slot_status text,shift_id uuid,shift_status text) language plpgsql volatile security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_slot public.roster_slots%rowtype;v_unit public.roster_work_units%rowtype;v_shift public.shifts%rowtype;v_materialized record;
begin
  select s.* into v_slot from public.roster_slots s where s.id=p_slot_id for update;if not found then raise exception 'Roster slot not found';end if;
  if not public.is_admin_for_org(v_slot.organization_id) then raise exception 'Not authorised to manage this roster slot';end if;
  if v_slot.status<>p_expected_status then raise exception 'Roster slot changed from expected status % to %',p_expected_status,v_slot.status;end if;
  select u.* into v_unit from public.roster_work_units u where u.id=v_slot.work_unit_id;
  if p_action='publish' then
    if v_slot.status<>'draft' then raise exception 'Only draft roster slots can be published';end if;
    update public.roster_slots rs set status='published' where rs.id=v_slot.id returning rs.* into v_slot;
    if v_unit.work_unit_type in('patrol','static') then select * into v_materialized from public.materialize_roster_slot(v_slot.id,'published');v_slot.linked_shift_id:=v_materialized.shift_id;end if;
  elsif p_action='cancel' then
    if v_slot.status not in('draft','published','accepted') then raise exception 'This roster slot can no longer be cancelled';end if;
    if nullif(trim(coalesce(p_reason,'')),'') is null then raise exception 'Cancellation reason is required';end if;
    if v_slot.linked_shift_id is not null then
      select s.* into v_shift from public.shifts s where s.id=v_slot.linked_shift_id for update;if not found then raise exception 'Linked field shift not found';end if;
      if v_shift.status not in('scheduled','published','accepted') or v_shift.actual_start is not null then raise exception 'Field shift has started or is no longer cancellable';end if;
      if exists(select 1 from public.patrols p where p.shift_id=v_shift.id and p.status='in_progress') then raise exception 'Active patrol prevents cancellation';end if;
      if exists(select 1 from public.dispatch_jobs d where d.shift_id=v_shift.id and d.status in('pending','pending_approval','dispatched','acknowledged','en_route','on_scene')) then raise exception 'Active dispatch work prevents cancellation';end if;
      if exists(select 1 from public.shift_stop_actions a where a.shift_id=v_shift.id) then raise exception 'Recorded field activity prevents cancellation';end if;
      update public.shift_stop_modules m set status='skipped',updated_at=clock_timestamp() from public.shift_stops st where m.shift_stop_id=st.id and st.shift_id=v_shift.id and m.status in('pending','in_progress');
      update public.shift_stops st set status='cancelled',updated_at=clock_timestamp() where st.shift_id=v_shift.id and st.status in('pending','en_route','on_scene');
      update public.shifts sh set status='cancelled',notes=concat_ws(E'\n',nullif(sh.notes,''),'Cancelled: '||trim(p_reason)) where sh.id=v_shift.id returning sh.* into v_shift;
    end if;
    update public.roster_slots rs set status='cancelled',notes=concat_ws(E'\n',nullif(rs.notes,''),'Cancelled: '||trim(p_reason)) where rs.id=v_slot.id returning rs.* into v_slot;
  else raise exception 'Unsupported roster slot action';end if;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_slot.organization_id,v_actor,case when p_action='publish' then 'roster_slot_published' else 'roster_slot_cancelled' end,'roster_slots',v_slot.id,jsonb_build_object('work_unit_type',v_unit.work_unit_type,'linked_shift_id',v_slot.linked_shift_id,'reason',case when p_action='cancel' then trim(p_reason) else null end));
  return query select v_slot.id,v_slot.status,v_slot.linked_shift_id,case when v_shift.id is null then null else v_shift.status end;
end;$$;
revoke all on function public.manage_roster_slot(uuid,text,text,text) from public,anon;
grant execute on function public.manage_roster_slot(uuid,text,text,text) to authenticated,service_role;