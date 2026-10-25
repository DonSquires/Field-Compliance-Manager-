-- Route historical patrol-log labour onto the officer's patrol route.
--
-- Owner ruling (2026-10-30): imported patrol shifts belong on the Blenheim or Nelson
-- forestry patrol route, not in per-client "Patrol log - <client>" holding units.
-- Dave Porter is the usual Blenheim patrol officer and Dan Douglas the usual Nelson
-- patrol officer. Every place they mostly attend belongs to their route, and other
-- staff covering those places work that route too.
--
-- The rule is generic: a route's primary officer anchors the places they mostly
-- attend. Places the primary officers never attend go to the route whose anchored
-- working area is nearest, then to an exclusive existing route zone list. A shift
-- follows the majority of its places, then the officer's dated route assignment,
-- then the officer's usual route. Unresolvable shifts stay where they are and are
-- reported. Client provenance stays on each slot; historical slots remain pay-only.

-- 1. Primary officer per patrol route ----------------------------------------------------------
ALTER TABLE public.patrol_routes
  ADD COLUMN IF NOT EXISTS primary_staff_id uuid REFERENCES public.staff_profiles(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.patrol_routes.primary_staff_id IS
  'Usual officer for this route. Places this officer mostly attends belong to the route; other staff may still cover it.';
CREATE INDEX IF NOT EXISTS patrol_routes_primary_staff_idx
  ON public.patrol_routes(primary_staff_id) WHERE primary_staff_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_patrol_route_primary_staff()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if new.primary_staff_id is not null and not exists (
    select 1 from public.staff_profiles where id = new.primary_staff_id and organization_id = new.organization_id
  ) then
    raise exception 'The primary officer must be a staff member of the route organisation';
  end if;
  return new;
end;
$function$;
REVOKE ALL ON FUNCTION public.validate_patrol_route_primary_staff() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_validate_patrol_route_primary_staff ON public.patrol_routes;
CREATE TRIGGER trg_validate_patrol_route_primary_staff
  BEFORE INSERT OR UPDATE OF primary_staff_id, organization_id ON public.patrol_routes
  FOR EACH ROW EXECUTE FUNCTION public.validate_patrol_route_primary_staff();

CREATE OR REPLACE FUNCTION public.set_patrol_route_primary_officer(
  p_route_id uuid,
  p_staff_id uuid,
  p_reason text
) RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_route public.patrol_routes%rowtype;
  v_receipt jsonb;
begin
  select * into v_route from public.patrol_routes where id = p_route_id for update;
  if not found then raise exception 'Patrol route not found'; end if;
  if v_actor is null or not public.is_admin_for_org(v_route.organization_id) then
    raise exception 'Not authorised to change the primary officer for this route';
  end if;
  if length(trim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required to change the primary officer';
  end if;
  if p_staff_id is not null and not exists (
    select 1 from public.staff_profiles where id = p_staff_id and organization_id = v_route.organization_id
  ) then
    raise exception 'The primary officer must be a staff member of this organisation';
  end if;

  update public.patrol_routes set primary_staff_id = p_staff_id where id = p_route_id;
  v_receipt := jsonb_build_object('route_id', p_route_id, 'route_code', v_route.route_code,
    'previous_staff_id', v_route.primary_staff_id, 'staff_id', p_staff_id, 'reason', trim(p_reason));
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_route.organization_id, v_actor, 'patrol_route_primary_officer_set', 'patrol_routes', p_route_id, v_receipt);
  return v_receipt;
end;
$function$;
COMMENT ON FUNCTION public.set_patrol_route_primary_officer(uuid, uuid, text) IS
  'Admin-only, audited change of the usual officer for a patrol route.';
REVOKE ALL ON FUNCTION public.set_patrol_route_primary_officer(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_patrol_route_primary_officer(uuid, uuid, text) TO authenticated, service_role;

-- 2. Routing engine (internal) ------------------------------------------------------------------
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
  v_summary jsonb;
begin
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
    return jsonb_build_object('routes', 0, 'moved', 0, 'unrouted', null,
      'skipped_reason', 'No patrol route has both a primary officer and an active patrol work unit');
  end if;

  create temp table _hpl_events on commit drop as
  select slot.id as slot_id, slot.staff_id, event.zone_id,
    coalesce(event.zone_id::text, 'site:' || event.client_site_id::text) as place
  from public.roster_slots slot
  cross join lateral jsonb_array_elements_text(slot.external_refs->'source_records') ref(value)
  join public.location_events event
    on event.id = case when ref.value ~ '^event:[0-9a-f-]{36}$' then substr(ref.value, 7)::uuid end
  where slot.organization_id = p_organization_id
    and slot.external_refs->>'source' = 'rm_patrol_log_labour'
    and coalesce(event.zone_id, event.client_site_id) is not null;

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
    select ev.slot_id, p.route_id, count(*) as n
    from _hpl_events ev join _hpl_places p on p.place = ev.place
    where p.route_id is not null and ev.slot_id in (select slot_id from pending)
    group by 1, 2
  ), best as (
    select slot_id, route_id, rank() over (partition by slot_id order by n desc) as rk,
      count(*) over (partition by slot_id, n) as ties
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

  update public.roster_work_units unit set active = false, updated_at = now()
  where unit.organization_id = p_organization_id and unit.active
    and unit.external_refs->>'source' = 'rm_patrol_log_labour'
    and not exists (select 1 from public.roster_slots slot where slot.work_unit_id = unit.id);
  get diagnostics v_units_closed = row_count;

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
    'holding_units_closed', v_units_closed)
  into v_summary;
  return v_summary;
end;
$function$;
COMMENT ON FUNCTION public.route_historical_patrol_labour(uuid, uuid) IS
  'Internal: moves unrouted historical patrol-log labour onto the patrol route of each place''s primary officer. Called by audited RPCs only.';
REVOKE ALL ON FUNCTION public.route_historical_patrol_labour(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

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
  'Admin-only, idempotent, audited routing of historical patrol-log labour onto primary-officer patrol routes.';
REVOKE ALL ON FUNCTION public.apply_historical_patrol_labour_routes(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_historical_patrol_labour_routes(uuid, uuid) TO authenticated, service_role;

-- 3. R&M: Dave Porter (Blenheim) and Dan Douglas (Nelson), then route the existing labour ------
DO $seed$
declare
  v_org constant uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_actor constant uuid := 'f1c00000-0000-4000-8000-000000000001';
  v_request constant uuid := '6c1f3b2a-9d4e-4f7a-8b21-30a1c0de2026';
  v_receipt jsonb;
begin
  if not exists (select 1 from public.organizations where id = v_org) then return; end if;

  update public.patrol_routes set primary_staff_id = '5bd14029-b00b-4240-b42a-c739c168b6e4'
  where organization_id = v_org and route_code = 'RM-BLENHEIM-FORESTRY'
    and exists (select 1 from public.staff_profiles where id = '5bd14029-b00b-4240-b42a-c739c168b6e4' and organization_id = v_org);
  update public.patrol_routes set primary_staff_id = '60b73649-ddae-4386-be6b-3d9243db625c'
  where organization_id = v_org and route_code = 'RM-NELSON-FORESTRY'
    and exists (select 1 from public.staff_profiles where id = '60b73649-ddae-4386-be6b-3d9243db625c' and organization_id = v_org);

  if exists (select 1 from public.audit_log where organization_id = v_org and action = 'historical_patrol_labour_routed'
             and metadata->>'request_id' = v_request::text) then
    return;
  end if;

  v_receipt := public.route_historical_patrol_labour(v_org, v_request)
    || jsonb_build_object('ruling', 'Dave Porter usual Blenheim officer; Dan Douglas usual Nelson officer (owner, 2026-10-30)');
  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_org, case when exists (select 1 from public.user_profiles where id = v_actor) then v_actor end,
    'historical_patrol_labour_routed', 'roster_slots', null, v_receipt);
end;
$seed$;

-- 4. Seeded spreadsheet jobs are verified truth ----------------------------------------------
-- Owner ruling (2026-10-26): every job seeded from R&M's spreadsheets is already verified
-- truth. Those sheets are R&M's source of record for reporting and billing until R&M operate
-- in FCM, so seeded jobs carry no geofence requirement and are not billing, quote or geofence
-- exceptions. Seeded sources are listed explicitly: other tagged slots (e.g. Bob's tentative
-- blocks) are not seeded truth.
CREATE OR REPLACE FUNCTION public.roster_slot_is_source_truth(p_external_refs jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(p_external_refs->>'source', '') = any (array['rm_patrol_log_labour']);
$function$;
COMMENT ON FUNCTION public.roster_slot_is_source_truth(jsonb) IS
  'True when a roster slot was seeded from an owner-verified source of record (R&M spreadsheets). Such slots need no geofence and are billed by their source.';
REVOKE ALL ON FUNCTION public.roster_slot_is_source_truth(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.roster_slot_is_source_truth(jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_roster_commercial_readiness(p_organization_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(slot_id uuid, pay_status text, billing_status text, quote_status text, geofence_status text, cost_centre_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin_for_org(p_organization_id) then raise exception 'Not authorised to view roster commercial readiness';end if;
  if p_from is null or p_to is null or p_from>=p_to or p_to-p_from>interval '62 days' then raise exception 'Readiness window must be between 1 and 62 days';end if;
  return query
  select s.id,
    case when exists(select 1 from public.rate_rules r where r.organization_id=s.organization_id and r.rule_kind='pay' and r.active and (r.service_type is null or r.service_type=u.service_type) and (r.effective_from is null or r.effective_from<=s.scheduled_start::date) and (r.effective_to is null or r.effective_to>=s.scheduled_start::date)) then 'ready' else 'missing_rule' end,
    case
      when public.roster_slot_is_source_truth(s.external_refs) then 'source_verified'
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' and not exists(select 1 from public.service_agreement_locations l join public.service_agreements a on a.id=l.service_agreement_id join public.service_agreement_modules m on m.id=u.service_agreement_module_id and m.service_agreement_id=a.id and m.enabled where l.id=u.service_agreement_location_id and l.status='active' and a.agreement_type='operational' and (a.starts_on is null or a.starts_on<=s.scheduled_start::date) and (a.ends_on is null or a.ends_on>=s.scheduled_start::date)) then 'missing_contract'
      when u.work_unit_type='static' and public.roster_agreement_billing_ready((select l.service_agreement_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.site_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.zone_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id)) then 'ready'
      when u.work_unit_type='static' then 'missing_rate'
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id) or exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required where st.shift_id=s.linked_shift_id and (sm.service_agreement_location_id is null or sm.service_agreement_module_id is null)) then 'missing_attribution'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required join public.service_agreement_locations l on l.id=sm.service_agreement_location_id where st.shift_id=s.linked_shift_id and not public.roster_agreement_billing_ready(l.service_agreement_id,l.site_id,l.zone_id)) then 'missing_rate'
      else 'ready' end,
    case
      when public.roster_slot_is_source_truth(s.external_refs) then 'source_verified'
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' and exists(select 1 from public.service_agreement_locations l join public.quotes q on q.service_agreement_id=l.service_agreement_id and q.status='accepted' where l.id=u.service_agreement_location_id) then 'accepted'
      when u.work_unit_type='static' then 'missing'
      when s.linked_shift_id is null then 'pending_materialization'
      when exists(select 1 from public.shift_stops st join public.shift_stop_modules sm on sm.shift_stop_id=st.id and sm.is_required left join public.service_agreement_locations l on l.id=sm.service_agreement_location_id left join public.quotes q on q.service_agreement_id=l.service_agreement_id and q.status='accepted' where st.shift_id=s.linked_shift_id and q.id is null) then 'missing'
      else 'accepted' end,
    case
      when public.roster_slot_is_source_truth(s.external_refs) then 'source_verified'
      when u.work_unit_type in ('internal', 'workshop') then 'not_applicable'
      when u.work_unit_type='static' then public.roster_place_geofence_state((select l.site_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id),(select l.zone_id from public.service_agreement_locations l where l.id=u.service_agreement_location_id))
      when s.linked_shift_id is null then 'pending_materialization'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id) then 'pending_materialization'
      when exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)='missing') then 'missing'
      when not exists(select 1 from public.shift_stops st where st.shift_id=s.linked_shift_id and public.roster_place_geofence_state(st.site_id,st.zone_id)<>'verified') then 'verified'
      else 'mapped_unverified' end,
    case when u.work_unit_type in ('patrol', 'static') then 'not_applicable' when u.cost_centre_id is not null then 'ready' else 'missing' end
  from public.roster_slots s join public.roster_work_units u on u.id=s.work_unit_id
  where s.organization_id=p_organization_id and s.scheduled_start<p_to and s.scheduled_end>p_from and s.status<>'cancelled';
end;$function$;
COMMENT ON FUNCTION public.get_roster_commercial_readiness(uuid, timestamp with time zone, timestamp with time zone) IS
  'Admin-only pay, billing, quote, geofence and cost-centre readiness per roster slot. Slots seeded from an owner-verified source of record report source_verified: no geofence requirement, billed by their source.';
