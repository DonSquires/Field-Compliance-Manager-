-- Governed admin acknowledgment for late-start and active-overrun exceptions.

create or replace function public.acknowledge_roster_attendance_exception(
  p_shift_id uuid,
  p_exception_type text,
  p_notes text
) returns table (shift_id uuid, acknowledged_at timestamptz)
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_shift public.shifts%rowtype; v_user uuid; v_at timestamptz := clock_timestamp(); v_notes text := nullif(trim(coalesce(p_notes, '')), '');
begin
  if v_notes is null then raise exception 'Attendance exception notes are required'; end if;
  if p_exception_type not in ('late_start', 'active_overrun') then raise exception 'Unsupported attendance exception type'; end if;
  select s.* into v_shift from public.shifts s where s.id = p_shift_id for update;
  if not found then raise exception 'Shift not found'; end if;
  if not public.is_admin_for_org(v_shift.organization_id) then raise exception 'Roster administrator required'; end if;
  select coalesce(sp.user_id, sp.id) into v_user from public.staff_profiles sp where sp.id = (select rs.staff_id from public.roster_slots rs where rs.linked_shift_id = v_shift.id limit 1);
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_shift.organization_id, v_actor, 'roster_attendance_exception_acknowledged', 'shifts', v_shift.id, jsonb_build_object('exception_type', p_exception_type, 'notes', v_notes, 'acknowledged_at', v_at));
  if v_user is not null then perform public.enqueue_notification(p_organization_id => v_shift.organization_id, p_category => 'roster', p_title => 'Attendance exception acknowledged', p_body => v_notes, p_severity => 'warning', p_recipient_user_id => v_user, p_link_page => 'schedule', p_link_payload => jsonb_build_object('shift_id', v_shift.id, 'exception_type', p_exception_type), p_dedup_key => 'attendance_exception_ack:' || v_shift.id::text || ':' || p_exception_type || ':' || v_at::text); end if;
  return query select v_shift.id, v_at;
end;
$$;

revoke all on function public.acknowledge_roster_attendance_exception(uuid, text, text) from public, anon;
grant execute on function public.acknowledge_roster_attendance_exception(uuid, text, text) to authenticated, service_role;
