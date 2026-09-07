-- Preview template-generated roster work before creating draft slots.

create or replace function public.preview_roster_from_templates(
  p_organization_id uuid,
  p_from_date date,
  p_to_date date
) returns table (
  templates_applied integer,
  candidate_slots integer,
  existing_slots integer,
  new_slots integer
)
language plpgsql security definer stable set search_path = public
as $$
declare v_actor uuid := auth.uid(); v_unit_id uuid; v_templates integer := 0; v_candidates integer := 0; v_existing integer := 0;
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Active roster administrator required'; end if;
  if p_from_date is null or p_to_date is null or p_from_date > p_to_date or p_to_date - p_from_date > 92 then raise exception 'Preview period must be between 1 and 93 days'; end if;
  select wu.id into v_unit_id from public.roster_work_units wu where wu.organization_id = p_organization_id and wu.active order by wu.name limit 1;
  if v_unit_id is null then raise exception 'Active work unit required to preview roster slots'; end if;
  with candidates as (
    select st.id, d.day::date as roster_date, st.start_time, st.end_time
    from public.shift_templates st cross join lateral generate_series(p_from_date, p_to_date, interval '1 day') d(day)
    where st.organization_id = p_organization_id and st.is_active and extract(isodow from d.day)::integer = any(st.active_days)
  ), counted as (
    select c.*, exists(select 1 from public.roster_slots rs where rs.organization_id = p_organization_id and rs.work_unit_id = v_unit_id and rs.scheduled_start = c.roster_date + c.start_time) as exists_already
    from candidates c
  )
  select count(distinct id)::integer, count(*)::integer, count(*) filter (where exists_already)::integer into v_templates, v_candidates, v_existing from counted;
  return query select v_templates, v_candidates, v_existing, greatest(0, v_candidates - v_existing);
end;
$$;

revoke all on function public.preview_roster_from_templates(uuid, date, date) from public, anon;
grant execute on function public.preview_roster_from_templates(uuid, date, date) to authenticated, service_role;
