-- Repeat one roster assignment across a date range as governed draft slots.

create or replace function public.repeat_roster_slot_range(
  p_source_slot_id uuid,
  p_from_date date,
  p_to_date date
) returns table (created_count integer, skipped_conflict_count integer, leave_conflict_count integer)
language plpgsql security definer set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_source public.roster_slots%rowtype; v_day date; v_start timestamptz; v_end timestamptz; v_created integer := 0; v_skipped integer := 0; v_leave integer := 0; v_duration interval;
begin
  select s.* into v_source from public.roster_slots s where s.id = p_source_slot_id for update;
  if not found then raise exception 'Roster slot not found'; end if;
  if not public.is_admin_for_org(v_source.organization_id) then raise exception 'Roster administrator required'; end if;
  if v_source.status in ('completed', 'cancelled') then raise exception 'Completed or cancelled slots cannot be repeated'; end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date or p_to_date - p_from_date > 92 then raise exception 'Repeat period must be between 1 and 93 days'; end if;
  v_duration := v_source.scheduled_end - v_source.scheduled_start;
  for v_day in select generate_series(p_from_date, p_to_date, interval '1 day')::date loop
    v_start := v_day + (v_source.scheduled_start::time);
    v_end := v_start + v_duration;
    if exists (select 1 from public.leave_requests l where l.staff_id = v_source.staff_id and l.status = 'approved' and daterange(l.starts_on, l.ends_on, '[]') && daterange(v_start::date, v_end::date, '[]')) then v_leave := v_leave + 1; continue; end if;
    if exists (select 1 from public.roster_slots s where s.staff_id = v_source.staff_id and s.status not in ('declined','cancelled') and s.scheduled_start < v_end and s.scheduled_end > v_start) then v_skipped := v_skipped + 1; continue; end if;
    insert into public.roster_slots (organization_id, work_unit_id, staff_id, scheduled_start, scheduled_end, status, client_request_id, notes, created_by) values (v_source.organization_id, v_source.work_unit_id, v_source.staff_id, v_start, v_end, 'draft', gen_random_uuid(), coalesce(v_source.notes, '') || ' · Repeated assignment', v_actor);
    v_created := v_created + 1;
  end loop;
  insert into public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata) values (v_source.organization_id, v_actor, 'roster_slot_repeated', 'roster_slots', v_source.id, jsonb_build_object('from_date', p_from_date, 'to_date', p_to_date, 'created_count', v_created, 'skipped_conflict_count', v_skipped, 'leave_conflict_count', v_leave));
  return query select v_created, v_skipped, v_leave;
end;
$$;

revoke all on function public.repeat_roster_slot_range(uuid, date, date) from public, anon;
grant execute on function public.repeat_roster_slot_range(uuid, date, date) to authenticated, service_role;
