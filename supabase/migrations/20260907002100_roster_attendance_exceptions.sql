-- Read-only attendance exception resolver over the canonical shifts ledger.

create or replace function public.get_roster_attendance_exceptions(
  p_organization_id uuid,
  p_grace_minutes integer default 15,
  p_from timestamptz default now() - interval '24 hours',
  p_to timestamptz default now() + interval '24 hours'
) returns table (
  shift_id uuid,
  officer_user_id uuid,
  service_type text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  status text,
  exception_type text,
  minutes_overdue integer
)
language plpgsql security definer stable set search_path = public
as $$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Roster administrator required'; end if;
  if p_grace_minutes < 0 or p_grace_minutes > 240 then raise exception 'Grace period is outside the accepted range'; end if;
  return query
  select s.id, s.officer_user_id, s.service_type, s.scheduled_start, s.scheduled_end, s.status,
    case when s.status in ('scheduled', 'published', 'accepted') and s.scheduled_start + make_interval(mins => p_grace_minutes) < clock_timestamp() then 'late_start' else 'active_overrun' end,
    case when s.status in ('scheduled', 'published', 'accepted') then greatest(0, floor(extract(epoch from (clock_timestamp() - (s.scheduled_start + make_interval(mins => p_grace_minutes)))) / 60)::integer) else greatest(0, floor(extract(epoch from (clock_timestamp() - s.scheduled_end)) / 60)::integer) end
  from public.shifts s
  where s.organization_id = p_organization_id
    and s.scheduled_start >= p_from and s.scheduled_start <= p_to
    and ((s.status in ('scheduled', 'published', 'accepted') and s.scheduled_start + make_interval(mins => p_grace_minutes) < clock_timestamp() and s.actual_start is null)
      or (s.status = 'in_progress' and s.scheduled_end < clock_timestamp()))
  order by s.scheduled_start;
end;
$$;

revoke all on function public.get_roster_attendance_exceptions(uuid, integer, timestamptz, timestamptz) from public, anon;
grant execute on function public.get_roster_attendance_exceptions(uuid, integer, timestamptz, timestamptz) to authenticated, service_role;
