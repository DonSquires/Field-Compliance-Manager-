-- Hardening for 20261030120000 (patrol labour route officers), from review of PR #232.
--
-- 1. A route's usual officer can only change through the audited
--    set_patrol_route_primary_officer RPC (reason + audit), never a direct table write.
-- 2. Routing reads place evidence from observations as well as patrol-log events.
-- 3. A shift follows the route holding most of its distinct places; log-entry volume only
--    breaks a tie, so repeat entries at one place cannot outvote several places.
-- 4. Holding units stay visible while they hold labour, including when a later
--    import reuses a closed unit or no route can take the labour.
-- 5. Routing is serialised per organisation, so concurrent replays of one request
--    cannot both route and record two receipts.

-- 1. Usual officer: RPC-only writes ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.validate_patrol_route_primary_staff()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  -- API roles reach this trigger directly; the audited SECURITY DEFINER RPC runs as its owner.
  if current_user in ('anon', 'authenticated', 'service_role')
     and new.primary_staff_id is distinct from (case when tg_op = 'UPDATE' then old.primary_staff_id end) then
    raise exception 'Change the usual officer with set_patrol_route_primary_officer, which records a reason and audit entry';
  end if;
  if new.primary_staff_id is not null and not exists (
    select 1 from public.staff_profiles where id = new.primary_staff_id and organization_id = new.organization_id
  ) then
    raise exception 'The primary officer must be a staff member of the route organisation';
  end if;
  return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.validate_patrol_route_primary_staff() FROM PUBLIC, anon, authenticated, service_role;

-- 2-4. Routing engine -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_historical_patrol_labour(
  p_organization_id uuid,
  p_request_id uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_moved integer := 0;
  v_zones_added integer := 0;
  v_units_closed integer := 0;
  v_units_reopened integer := 0;
  v_summary jsonb;
begin
  -- One routing run per organisation at a time; the audited wrapper takes the same lock first.
  perform pg_advisory_xact_lock(hashtextextended('historical_patrol_labour_routing:' || p_organization_id::text, 0));
  drop table if exists pg_temp._hpl_routes, pg_temp._hpl_events, pg_temp._hpl_attendance,
    pg_temp._hpl_places, pg_temp._hpl_centres, pg_temp._hpl_decisions;

  create temp table _hpl_routes on commit drop as
  select route.id as route_id, route.route_code, route.primary_staff_id,
    (select unit.id from public.roster_work_units unit
      where unit.organization_id = p_organization_id and unit.patrol_route_id = route.id
        and unit.active and unit.work_unit_type = 'patrol'
        and coalesce((unit.external_refs->>'historical_only')::boolean, false) = false
      order by unit.created_at, unit.id limit 1) as unit_id
  from public.patrol_routes route
  where route.organization_id = p_organization_id and route.primary_staff_id is not null;
  delete from _hpl_routes where unit_id is null;
  if not exists (select 1 from _hpl_routes) then
    -- Nothing can be routed, so every holding unit that still has labour must stay visible.
    update public.roster_work_units unit set active = true, updated_at = now()
    where unit.organization_id = p_organization_id and not unit.active
      and unit.external_refs->>'source' = 'rm_patrol_log_labour'
      and exists (select 1 from public.roster_slots slot where slot.work_unit_id = unit.id);
    get diagnostics v_units_reopened = row_count;
    return jsonb_build_object('routes', 0, 'moved', 0, 'unrouted', null, 'holding_units_reopened', v_units_reopened,
      'skipped_reason', 'No patrol route has both a primary officer and an active patrol work unit');
  end if;

  -- Place evidence from both supported source kinds: patrol-log events and observations.
  create temp table _hpl_events on commit drop as
  with refs as (
    select slot.id as slot_id, slot.staff_id, ref.value
    from public.roster_slots slot
    cross join lateral jsonb_array_elements_text(slot.external_refs->'source_records') ref(value)
    where slot.organization_id = p_organization_id
      and slot.external_refs->>'source' = 'rm_patrol_log_labour'
  ), places as (
    select refs.slot_id, refs.staff_id, event.zone_id, event.client_site_id as site_id
    from refs join public.location_events event
      on event.id = case when refs.value ~ '^event:[0-9a-f-]{36}$' then substr(refs.value, 7)::uuid end
    union all
    select refs.slot_id, refs.staff_id, observation.zone_id, observation.site_id
    from refs join public.observations observation
      on observation.id = case when refs.value ~ '^observation:[0-9a-f-]{36}$' then substr(refs.value, 13)::uuid end
  )
  select slot_id, staff_id, zone_id, coalesce(zone_id::text, 'site:' || site_id::text) as place
  from places
  where coalesce(zone_id, site_id) is not null;

  create temp table _hpl_attendance on commit drop as
  select ev.place, route.route_id, count(*) as visits
  from _hpl_events ev join _hpl_routes route on route.primary_staff_id = ev.staff_id
  group by 1, 2;

  create temp table _hpl_places on commit drop as
  select place, (array_agg(zone_id))[1] as zone_id, null::uuid as route_id, null::text as basis
  from _hpl_events group by place;

  -- a. The place is mostly attended by one route's primary officer.
  with ranked as (
    select place, route_id, rank() over (partition by place order by visits desc) as rk,
      count(*) over (partition by place, visits) as ties
    from _hpl_attendance
  )
  update _hpl_places p set route_id = ranked.route_id, basis = 'site_primary_officer'
  from ranked where ranked.place = p.place and ranked.rk = 1 and ranked.ties = 1;

  -- b. Nearest route working area, weighted by the primary officer's attendance.
  create temp table _hpl_centres on commit drop as
  select p.route_id,
    st_setsrid(st_makepoint(sum(st_x(geo.pt) * att.visits) / sum(att.visits),
                            sum(st_y(geo.pt) * att.visits) / sum(att.visits)), 4326) as centre
  from _hpl_places p
  join _hpl_attendance att on att.place = p.place and att.route_id = p.route_id
  join lateral (
    select st_transform(coalesce(zone.center_point, st_centroid(zone.boundary)), 4326) as pt
    from public.location_zones zone where zone.id = p.zone_id
  ) geo on geo.pt is not null
  where p.basis = 'site_primary_officer'
  group by p.route_id;

  update _hpl_places p set route_id = (
      select centre.route_id from _hpl_centres centre
      order by st_distance(centre.centre::geography, geo.pt::geography) limit 1),
    basis = 'site_nearest_route_area'
  from (
    select zone.id, st_transform(coalesce(zone.center_point, st_centroid(zone.boundary)), 4326) as pt
    from public.location_zones zone
  ) geo
  where p.route_id is null and geo.id = p.zone_id and geo.pt is not null
    and exists (select 1 from _hpl_centres);

  -- c. The zone already sits on exactly one candidate route's zone list.
  update _hpl_places p set route_id = listed.route_id, basis = 'site_route_zone_list'
  from (
    select route_zone.zone_id, (array_agg(route_zone.patrol_route_id))[1] as route_id
    from public.patrol_route_zones route_zone
    where route_zone.patrol_route_id in (select route_id from _hpl_routes)
    group by route_zone.zone_id having count(*) = 1
  ) listed
  where p.route_id is null and listed.zone_id = p.zone_id;

  create temp table _hpl_decisions on commit drop as
  with pending as (
    select slot.id as slot_id, slot.staff_id, staff.user_id, slot.work_unit_id, slot.external_refs,
      (slot.external_refs->>'work_date')::date as work_date
    from public.roster_slots slot
    join public.staff_profiles staff on staff.id = slot.staff_id
    where slot.organization_id = p_organization_id
      and slot.external_refs->>'source' = 'rm_patrol_log_labour'
      and slot.work_unit_id not in (select unit_id from _hpl_routes)
  ), votes as (
    -- Distinct places decide; entry volume only breaks a tie between routes.
    select ev.slot_id, p.route_id, count(distinct ev.place) as n, count(*) as entries
    from _hpl_events ev join _hpl_places p on p.place = ev.place
    where p.route_id is not null and ev.slot_id in (select slot_id from pending)
    group by 1, 2
  ), best as (
    select slot_id, route_id, rank() over (partition by slot_id order by n desc, entries desc) as rk,
      count(*) over (partition by slot_id, n, entries) as ties
    from votes
  )
  select pending.*,
    best.route_id as place_route_id,
    (select (array_agg(distinct assignment.patrol_route_id))[1]
       from public.roster_assignments assignment
      where assignment.organization_id = p_organization_id
        and assignment.officer_id = pending.user_id
        and assignment.specific_date = pending.work_date
        and assignment.patrol_route_id in (select route_id from _hpl_routes)
      having count(distinct assignment.patrol_route_id) = 1) as assignment_route_id,
    null::uuid as route_id,
    null::text as basis
  from pending
  left join best on best.slot_id = pending.slot_id and best.rk = 1 and best.ties = 1;

  update _hpl_decisions set route_id = place_route_id, basis = 'site' where place_route_id is not null;
  update _hpl_decisions set route_id = assignment_route_id, basis = 'dated_route_assignment'
  where route_id is null and assignment_route_id is not null;

  with history as (
    select slot.staff_id, route.route_id, count(*) as n
    from public.roster_slots slot join _hpl_routes route on route.unit_id = slot.work_unit_id
    where slot.organization_id = p_organization_id and slot.external_refs->>'source' = 'rm_patrol_log_labour'
    group by 1, 2
    union all
    select staff_id, route_id, count(*) from _hpl_decisions where route_id is not null group by 1, 2
  ), totals as (
    select staff_id, route_id, sum(n) as n from history group by 1, 2
  ), best as (
    select staff_id, route_id, rank() over (partition by staff_id order by n desc) as rk,
      count(*) over (partition by staff_id, n) as ties
    from totals
  )
  update _hpl_decisions d set route_id = best.route_id, basis = 'officer_usual_route'
  from best where d.route_id is null and best.staff_id = d.staff_id and best.rk = 1 and best.ties = 1;

  update public.roster_slots slot
  set work_unit_id = route.unit_id,
      external_refs = slot.external_refs || jsonb_build_object(
        'route_code', route.route_code,
        'route_basis', d.basis,
        'routed_from_work_unit_id', d.work_unit_id,
        'routed_request_id', p_request_id,
        'client_name', client.name)
  from _hpl_decisions d
  join _hpl_routes route on route.route_id = d.route_id
  left join public.organizations client on client.id = (d.external_refs->>'client_organization_id')::uuid
  where slot.id = d.slot_id;
  get diagnostics v_moved = row_count;

  -- Record the routed zones on their route so each officer's places are visible on the route.
  insert into public.patrol_route_zones(patrol_route_id, zone_id, notes)
  select p.route_id, p.zone_id, 'Primary officer coverage: routed from patrol-log attendance (' || p.basis || ').'
  from _hpl_places p
  where p.route_id is not null and p.zone_id is not null
    and not exists (select 1 from public.patrol_route_zones existing where existing.patrol_route_id = p.route_id and existing.zone_id = p.zone_id)
    and (
      exists (select 1 from public.location_zones zone where zone.id = p.zone_id and zone.organization_id = p_organization_id)
      or exists (
        select 1 from public.service_agreement_locations sal
        join public.service_agreements agreement on agreement.id = sal.service_agreement_id
        where sal.status = 'active' and sal.zone_id = p.zone_id and agreement.provider_organization_id = p_organization_id)
    )
  on conflict do nothing;
  get diagnostics v_zones_added = row_count;

  -- Holding units are visible exactly while they hold labour (a later import may reuse a closed one).
  update public.roster_work_units unit set active = false, updated_at = now()
  where unit.organization_id = p_organization_id and unit.active
    and unit.external_refs->>'source' = 'rm_patrol_log_labour'
    and not exists (select 1 from public.roster_slots slot where slot.work_unit_id = unit.id);
  get diagnostics v_units_closed = row_count;
  update public.roster_work_units unit set active = true, updated_at = now()
  where unit.organization_id = p_organization_id and not unit.active
    and unit.external_refs->>'source' = 'rm_patrol_log_labour'
    and exists (select 1 from public.roster_slots slot where slot.work_unit_id = unit.id);
  get diagnostics v_units_reopened = row_count;

  select jsonb_build_object(
    'request_id', p_request_id,
    'routes', (select jsonb_object_agg(route_code, jsonb_build_object('route_id', route_id, 'unit_id', unit_id, 'primary_staff_id', primary_staff_id)) from _hpl_routes),
    'moved', v_moved,
    'unrouted', (select count(*) from _hpl_decisions where route_id is null),
    'by_route', coalesce((select jsonb_object_agg(route_code, n) from (
        select route.route_code, count(*) as n from _hpl_decisions d join _hpl_routes route using (route_id) group by 1) x), '{}'::jsonb),
    'by_basis', coalesce((select jsonb_object_agg(coalesce(basis, 'unrouted'), n) from (
        select basis, count(*) as n from _hpl_decisions group by 1) x), '{}'::jsonb),
    'place_basis', coalesce((select jsonb_object_agg(coalesce(basis, 'unresolved'), n) from (
        select basis, count(*) as n from _hpl_places group by 1) x), '{}'::jsonb),
    'route_zones_added', v_zones_added,
    'holding_units_closed', v_units_closed,
    'holding_units_reopened', v_units_reopened)
  into v_summary;
  return v_summary;
end;
$function$;
COMMENT ON FUNCTION public.route_historical_patrol_labour(uuid, uuid) IS
  'Internal: moves unrouted historical patrol-log labour onto the patrol route of each place''s primary officer, using event and observation place evidence and a distinct-place majority. Serialised per organisation. Called by audited RPCs only.';
REVOKE ALL ON FUNCTION public.route_historical_patrol_labour(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- 5. Audited wrapper: lock before the receipt lookup ----------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_historical_patrol_labour_routes(
  p_organization_id uuid,
  p_client_request_id uuid
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_receipt jsonb;
begin
  if v_actor is null or not public.is_admin_for_org(p_organization_id) then
    raise exception 'Not authorised to route historical labour for this organization';
  end if;
  if p_client_request_id is null then raise exception 'A request ID is required'; end if;

  -- Held until commit, so a concurrent replay waits and then finds this receipt.
  perform pg_advisory_xact_lock(hashtextextended('historical_patrol_labour_routing:' || p_organization_id::text, 0));

  select metadata into v_receipt from public.audit_log
  where organization_id = p_organization_id and action = 'historical_patrol_labour_routed'
    and metadata->>'request_id' = p_client_request_id::text
  limit 1;
  if found then return v_receipt || jsonb_build_object('replayed', true); end if;

  v_receipt := public.route_historical_patrol_labour(p_organization_id, p_client_request_id);
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (p_organization_id, v_actor, 'historical_patrol_labour_routed', 'roster_slots', null, v_receipt);
  return v_receipt;
end;
$function$;
COMMENT ON FUNCTION public.apply_historical_patrol_labour_routes(uuid, uuid) IS
  'Admin-only, idempotent, audited routing of historical patrol-log labour onto primary-officer patrol routes. Serialised per organisation.';
REVOKE ALL ON FUNCTION public.apply_historical_patrol_labour_routes(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_historical_patrol_labour_routes(uuid, uuid) TO authenticated, service_role;