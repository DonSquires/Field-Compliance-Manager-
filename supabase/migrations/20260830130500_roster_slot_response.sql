drop policy if exists roster_slots_select on public.roster_slots;
create policy roster_slots_select on public.roster_slots for select to authenticated using(
  public.is_admin_for_org(organization_id) or exists(
    select 1 from public.staff_profiles sp
    where sp.id=roster_slots.staff_id and (sp.user_id=auth.uid() or sp.id=auth.uid())
  )
);

create or replace function public.respond_to_roster_slot(p_slot_id uuid,p_expected_status text,p_response text,p_decline_reason text default null)
returns table(slot_id uuid,slot_status text,shift_id uuid,shift_status text) language plpgsql volatile security definer set search_path=public as $$
declare v_user uuid:=auth.uid();v_slot public.roster_slots%rowtype;v_staff public.staff_profiles%rowtype;v_next text;v_shift_status text;
begin
  if v_user is null then raise exception 'Authentication required';end if;
  select s.* into v_slot from public.roster_slots s where s.id=p_slot_id for update;if not found then raise exception 'Roster slot not found';end if;
  select sp.* into v_staff from public.staff_profiles sp where sp.id=v_slot.staff_id and (sp.user_id=v_user or sp.id=v_user);if not found then raise exception 'Roster slot does not belong to the authenticated staff member';end if;
  if v_slot.status<>p_expected_status then raise exception 'Roster slot changed from expected status % to %',p_expected_status,v_slot.status;end if;
  if v_slot.status<>'published' then raise exception 'Only published roster slots can be accepted or declined';end if;
  if p_response='accept' then v_next:='accepted';elsif p_response='decline' then if nullif(trim(coalesce(p_decline_reason,'')),'') is null then raise exception 'Decline reason is required';end if;v_next:='declined';else raise exception 'Unsupported roster response';end if;
  if v_slot.linked_shift_id is not null then
    select s.status into v_shift_status from public.shifts s where s.id=v_slot.linked_shift_id for update;
    if v_shift_status is null then raise exception 'Linked field shift not found';end if;
    if v_shift_status<>'published' then raise exception 'Linked field shift changed from expected status published to %',v_shift_status;end if;
    update public.shifts set status=v_next where id=v_slot.linked_shift_id returning status into v_shift_status;
  end if;
  update public.roster_slots set status=v_next,notes=case when v_next='declined' then concat_ws(E'\n',nullif(notes,''),'Declined: '||trim(p_decline_reason)) else notes end where id=v_slot.id returning * into v_slot;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  values(v_slot.organization_id,v_user,case when v_next='accepted' then 'roster_slot_accepted' else 'roster_slot_declined' end,'roster_slots',v_slot.id,jsonb_build_object('linked_shift_id',v_slot.linked_shift_id,'decline_reason',case when v_next='declined' then trim(p_decline_reason) else null end));
  return query select v_slot.id,v_slot.status,v_slot.linked_shift_id,v_shift_status;
end;$$;
revoke all on function public.respond_to_roster_slot(uuid,text,text,text) from public,anon;
grant execute on function public.respond_to_roster_slot(uuid,text,text,text) to authenticated,service_role;