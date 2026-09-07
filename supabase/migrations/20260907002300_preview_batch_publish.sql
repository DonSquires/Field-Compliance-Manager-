-- Preview batch publish impact without changing roster state.

create or replace function public.preview_batch_publish_roster_slots(
  p_organization_id uuid,
  p_from timestamptz,
  p_to timestamptz
) returns table (
  draft_count integer,
  leave_conflict_count integer,
  unassigned_count integer,
  field_shift_count integer
)
language plpgsql security definer stable set search_path = public
as $$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Active roster administrator required'; end if;
  return query
  select count(*)::integer,
    count(*) filter (where s.staff_id is not null and exists (select 1 from public.leave_requests l where l.staff_id = s.staff_id and l.status = 'approved' and daterange(l.starts_on, l.ends_on, '[]') && daterange(s.scheduled_start::date, s.scheduled_end::date, '[]')))::integer,
    count(*) filter (where s.staff_id is null)::integer,
    count(*) filter (where wu.work_unit_type <> 'internal')::integer
  from public.roster_slots s
  join public.roster_work_units wu on wu.id = s.work_unit_id
  where s.organization_id = p_organization_id and s.status = 'draft' and s.scheduled_start >= p_from and s.scheduled_start < p_to;
end;
$$;

revoke all on function public.preview_batch_publish_roster_slots(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.preview_batch_publish_roster_slots(uuid, timestamptz, timestamptz) to authenticated, service_role;
