create function public.complete_officer_shift(p_shift_id uuid,p_expected_status text) returns table(shift_id uuid,shift_status text,completed_at timestamptz) language plpgsql security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_shift public.shifts%rowtype;v_completed_at timestamptz:=clock_timestamp();
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  select s.* into v_shift from public.shifts s where s.id=p_shift_id for update;
  if not found then raise exception 'Shift not found';end if;
  if v_shift.officer_user_id<>v_actor then raise exception 'Shift does not belong to the authenticated officer';end if;
  if v_shift.status<>p_expected_status then raise exception 'Shift changed from expected status % to %',p_expected_status,v_shift.status;end if;
  if v_shift.status<>'in_progress' then raise exception 'Only an in-progress shift can be completed';end if;
  if not exists(select 1 from public.shift_debriefs d where d.shift_id=v_shift.id and d.officer_user_id=v_actor) then raise exception 'Submit the shift debrief before completing the shift';end if;
  if exists(select 1 from public.shift_stops st where st.shift_id=v_shift.id and st.status not in('completed','skipped','cancelled')) then raise exception 'Complete or skip every shift stop before completing the shift';end if;
  if exists(select 1 from public.shift_stop_modules sm join public.shift_stops st on st.id=sm.shift_stop_id where st.shift_id=v_shift.id and sm.is_required and sm.status not in('completed','skipped')) then raise exception 'Complete or skip every required module task before completing the shift';end if;
  if exists(select 1 from public.dispatch_jobs j where j.shift_id=v_shift.id and j.status not in('completed','cancelled')) then raise exception 'Complete or cancel every dispatch job before completing the shift';end if;
  if exists(select 1 from public.welfare_alerts w where w.shift_id=v_shift.id and w.status<>'resolved') then raise exception 'Resolve active welfare alerts before completing the shift';end if;
  update public.shifts set status='completed',actual_end=coalesce(actual_end,v_completed_at) where id=v_shift.id returning * into v_shift;
  update public.roster_slots set status='completed',updated_at=v_completed_at where linked_shift_id=v_shift.id and status in('published','accepted');
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_shift.organization_id,v_actor,'officer_shift_completed','shifts',v_shift.id,jsonb_build_object('previous_status',p_expected_status,'actual_end',v_shift.actual_end));
  return query select v_shift.id,v_shift.status,v_shift.actual_end;
end;
$$;
comment on function public.complete_officer_shift(uuid,text) is 'Allows the owning officer to complete an in-progress shift only after debrief and all operational, module, dispatch, and welfare work is terminal.';
revoke all on function public.complete_officer_shift(uuid,text) from public,anon;
grant execute on function public.complete_officer_shift(uuid,text) to authenticated,service_role;