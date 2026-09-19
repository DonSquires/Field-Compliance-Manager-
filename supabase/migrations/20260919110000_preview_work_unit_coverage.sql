-- Roster-time coverage preview (owner walk finding 2026-09-19): a patrol run rostered on a day its contract does not
-- cover materialises with 0 stops, and a static post on a place without a verified boundary cannot record
-- attendance. Both were only discovered after the shift existed. This read tells the rosterer before they create it.
-- Advisory only: the rosterer may still create the shift (ad-hoc weekend run, boundary being verified).

create or replace function public.preview_work_unit_coverage(p_work_unit_id uuid, p_shift_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_unit public.roster_work_units%rowtype;
  v_dow integer := extract(isodow from p_shift_date)::integer;
  v_month integer := extract(month from p_shift_date)::integer;
  v_stop_count integer := 0;
  v_config_count integer := 0;
  v_days integer[] := '{}';
  v_place_name text;
  v_place_kind text;
  v_boundary_verified boolean := false;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_shift_date is null then raise exception 'A shift date is required'; end if;
  select * into v_unit from public.roster_work_units w where w.id = p_work_unit_id;
  if not found then raise exception 'Work unit not found'; end if;
  if not (public.is_admin_for_org(v_unit.organization_id) or public.user_can_operate_organization(v_unit.organization_id)) then
    raise exception 'Not authorised to roster this work unit';
  end if;

  if v_unit.work_unit_type = 'patrol' then
    -- Same day/month rule as generate_shift_stops.
    select coalesce(sum(case when (array_length(c.active_days, 1) is null or v_dow = any(c.active_days))
                                and (array_length(c.active_months, 1) is null or array_length(c.active_months, 1) = 0 or v_month = any(c.active_months))
                           then coalesce(c.visits_per_shift, 1) else 0 end), 0)::integer,
           count(*)::integer
    into v_stop_count, v_config_count
    from public.client_site_patrol_config c
    where c.patrol_route_id = v_unit.patrol_route_id and c.active;

    select coalesce(array_agg(distinct d order by d), '{}') into v_days
    from public.client_site_patrol_config c
    cross join lateral unnest(case when array_length(c.active_days, 1) is null then '{1,2,3,4,5,6,7}'::integer[] else c.active_days end) as d
    where c.patrol_route_id = v_unit.patrol_route_id and c.active;

    return jsonb_build_object(
      'kind', 'patrol',
      'day_of_week', v_dow,
      'stop_count', v_stop_count,
      'config_count', v_config_count,
      'contracted_days', to_jsonb(v_days),
      'has_route', v_unit.patrol_route_id is not null,
      'ok', v_stop_count > 0
    );
  elsif v_unit.work_unit_type = 'static' then
    select coalesce(s.name, z.name), case when s.id is not null then 'site' when z.id is not null then 'zone' else null end,
           s.id is not null and s.active and s.boundary is not null and s.boundary_verification = 'verified' and st_isvalid(s.boundary) and not st_isempty(s.boundary)
    into v_place_name, v_place_kind, v_boundary_verified
    from public.service_agreement_locations sal
    left join public.client_sites s on s.id = sal.site_id
    left join public.location_zones z on z.id = sal.zone_id
    where sal.id = v_unit.service_agreement_location_id;

    return jsonb_build_object(
      'kind', 'static',
      'place_name', v_place_name,
      'place_kind', v_place_kind,
      'boundary_verified', coalesce(v_boundary_verified, false),
      'has_module', v_unit.service_agreement_module_id is not null,
      'ok', coalesce(v_boundary_verified, false) and v_unit.service_agreement_module_id is not null
    );
  end if;

  return jsonb_build_object('kind', coalesce(v_unit.work_unit_type, 'internal'), 'ok', true);
end;
$$;

revoke all on function public.preview_work_unit_coverage(uuid, date) from public, anon, authenticated, service_role;
grant execute on function public.preview_work_unit_coverage(uuid, date) to postgres, authenticated, service_role;
comment on function public.preview_work_unit_coverage(uuid, date) is
  'Before a roster slot is created: for a patrol run, how many contracted stops the route produces on that date and which weekdays it covers (same rule as generate_shift_stops); for a static post, whether its place has a verified boundary so attendance can be recorded. Advisory, never a gate.';
