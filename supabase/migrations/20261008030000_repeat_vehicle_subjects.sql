-- Repeat-vehicle summary across patrol sightings and human-accepted CCTV detections.
-- Access is checked once per organisation (not per row) so the summary stays fast, and it never returns a person's name:
-- only plates, counts, places and a flag that R&M has identified an owner.
CREATE OR REPLACE FUNCTION public.list_repeat_vehicle_subjects(
  p_min_sightings integer DEFAULT 2,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
) RETURNS TABLE (
  plate text,
  sightings bigint,
  places bigint,
  officers bigint,
  patrol_sightings bigint,
  cctv_sightings bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  owner_identified boolean,
  total_count bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  return query
  with orgs as (
    select distinct x.organization_id from (
      select o.organization_id from public.observations o
      union
      select c.organization_id from public.cctv_entity_observations c where c.entity_kind = 'vehicle'
    ) x
    where public.org_access_allowed(x.organization_id)
  ),
  seen as (
    select upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) as pl, o.canonical_vehicle_id as cv,
           o.observed_at as at, coalesce(o.zone_id, o.site_id) as place, o.officer_id as officer, 'patrol'::text as src
    from public.observations o
    where o.organization_id in (select organization_id from orgs)
      and o.observed_at <= now()
      and (p_from is null or o.observed_at >= p_from) and (p_to is null or o.observed_at < p_to)
    union all
    select upper(regexp_replace(c.candidate_plate, '[^A-Za-z0-9]', '', 'g')), c.canonical_vehicle_id,
           c.observed_at, coalesce(c.zone_id, c.site_id), null::uuid, 'cctv'::text
    from public.cctv_entity_observations c
    where c.entity_kind = 'vehicle' and c.review_state = 'accepted' and c.candidate_plate is not null
      and c.organization_id in (select organization_id from orgs)
      and c.observed_at <= now()
      and (p_from is null or c.observed_at >= p_from) and (p_to is null or c.observed_at < p_to)
  ),
  grouped as (
    select s.pl, count(*) as n, count(distinct s.place) as pl_count, count(distinct s.officer) as off_count,
           count(*) filter (where s.src = 'patrol') as patrol_n, count(*) filter (where s.src = 'cctv') as cctv_n,
           min(s.at) as first_at, max(s.at) as last_at,
           coalesce(bool_or(exists (select 1 from public.canonical_vehicles v where v.id = s.cv and v.registered_owner_name is not null)), false) as owner_flag
    from seen s where s.pl <> ''
    group by s.pl
    having count(*) >= greatest(coalesce(p_min_sightings, 2), 1)
  )
  select g.pl, g.n, g.pl_count, g.off_count, g.patrol_n, g.cctv_n, g.first_at, g.last_at, g.owner_flag, count(*) over ()
  from grouped g
  order by g.n desc, g.last_at desc
  limit least(greatest(coalesce(p_limit, 100), 1), 500) offset greatest(coalesce(p_offset, 0), 0);
end;
$function$;

-- Every sighting of one plate, newest first, from both sources.
CREATE OR REPLACE FUNCTION public.list_vehicle_subject_history(p_plate text, p_limit integer DEFAULT 200)
RETURNS TABLE (
  source text,
  record_id uuid,
  observed_at timestamptz,
  place_id uuid,
  officer_id uuid,
  note text
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_plate text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if v_plate = '' then return; end if;
  return query
  with orgs as (
    select distinct x.organization_id from (
      select o.organization_id from public.observations o where upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate
      union
      select c.organization_id from public.cctv_entity_observations c where c.entity_kind = 'vehicle' and upper(regexp_replace(coalesce(c.candidate_plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_plate
    ) x
    where public.org_access_allowed(x.organization_id)
  )
  select * from (
    select 'patrol'::text, o.id, o.observed_at, coalesce(o.zone_id, o.site_id), o.officer_id, o.officer_notes
    from public.observations o
    where o.organization_id in (select organization_id from orgs) and o.observed_at <= now()
      and upper(regexp_replace(o.plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate
    union all
    select 'cctv'::text, c.id, c.observed_at, coalesce(c.zone_id, c.site_id), null::uuid, null::text
    from public.cctv_entity_observations c
    where c.entity_kind = 'vehicle' and c.review_state = 'accepted' and c.organization_id in (select organization_id from orgs)
      and c.observed_at <= now()
      and upper(regexp_replace(coalesce(c.candidate_plate, ''), '[^A-Za-z0-9]', '', 'g')) = v_plate
  ) h
  order by 3 desc
  limit least(greatest(coalesce(p_limit, 200), 1), 500);
end;
$function$;

REVOKE ALL ON FUNCTION public.list_repeat_vehicle_subjects(integer, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_vehicle_subject_history(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_repeat_vehicle_subjects(integer, timestamptz, timestamptz, integer, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_vehicle_subject_history(text, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.list_repeat_vehicle_subjects(integer, timestamptz, timestamptz, integer, integer) IS
  'Repeat-vehicle summary over patrol sightings and accepted CCTV detections. Returns no personal names; owner_identified is a flag only.';
COMMENT ON FUNCTION public.list_vehicle_subject_history(text, integer) IS
  'All sightings of one plate across patrol and accepted CCTV detections, scoped to organisations the caller can access.';
