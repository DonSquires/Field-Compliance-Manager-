-- Zone activation schedules become human-editable, Monday-first, and honour months.
--
-- Owner rulings 2026-09-20: Monday is the first day of the week; a human must be able to edit
-- geofences. Before: location_zones.active_schedule (jsonb {days,start,end}) had no writer and no
-- editor (49 live zones, 0 schedules); the Zones page printed the raw JSON; _geofence_active_at read
-- `days` with 0 = Sunday, unlike every other weekday in the schema (ISO 1–7). After:
--  * _geofence_active_at reads ISO days (1 = Monday … 7 = Sunday; a legacy 0 is still Sunday) and an
--    optional `months` array (1–12) for seasonal rules; start/end keep their same-day / overnight
--    semantics; an empty object or null means always active.
--  * manage_zone_active_schedule(...) is the single governed writer: CRM administrator for the zone's
--    location (or an administrator of the zone's organisation), optimistic version check, validation
--    in plain words, configuration_version bump, audit row with before/after.
-- Runtime readers (resolve_context*, process-officer-scan manual zone selection) are unchanged.

CREATE OR REPLACE FUNCTION "public"."_geofence_active_at"(p_schedule jsonb, p_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_local   timestamp := p_at at time zone 'Pacific/Auckland';
  v_minutes int := extract(hour from v_local)::int * 60 + extract(minute from v_local)::int;
  v_isodow  int := extract(isodow from v_local)::int;   -- 1 = Monday … 7 = Sunday
  v_month   int := extract(month from v_local)::int;
  v_start   text;
  v_end     text;
  v_start_m int;
  v_end_m   int;
  v_days    jsonb;
  v_months  jsonb;
begin
  if p_schedule is null or p_schedule = '{}'::jsonb then
    return true;
  end if;

  -- Day-of-week filter (ISO; a legacy 0 still means Sunday).
  v_days := p_schedule -> 'days';
  if v_days is not null and jsonb_typeof(v_days) = 'array' and jsonb_array_length(v_days) > 0 then
    if not exists (
      select 1 from jsonb_array_elements_text(v_days) d
      where case when d::int = 0 then 7 else d::int end = v_isodow
    ) then
      return false;
    end if;
  end if;

  -- Month filter (seasonal rules).
  v_months := p_schedule -> 'months';
  if v_months is not null and jsonb_typeof(v_months) = 'array' and jsonb_array_length(v_months) > 0 then
    if not exists (select 1 from jsonb_array_elements_text(v_months) m where m::int = v_month) then
      return false;
    end if;
  end if;

  -- Time-of-day window.
  v_start := p_schedule ->> 'start';
  v_end   := p_schedule ->> 'end';
  if v_start is null or v_end is null then
    return true;
  end if;

  v_start_m := split_part(v_start, ':', 1)::int * 60 + split_part(v_start, ':', 2)::int;
  v_end_m   := split_part(v_end,   ':', 1)::int * 60 + split_part(v_end,   ':', 2)::int;

  if v_start_m <= v_end_m then
    return v_minutes >= v_start_m and v_minutes < v_end_m;
  else
    return v_minutes >= v_start_m or v_minutes < v_end_m;   -- overnight wrap
  end if;
end;
$function$;
COMMENT ON FUNCTION "public"."_geofence_active_at"(p_schedule jsonb, p_at timestamp with time zone) IS 'True if a zone active_schedule (jsonb {days (ISO 1=Mon..7=Sun; legacy 0=Sun), months (1-12), start "HH:MM", end "HH:MM"}) is in force at the given time in Pacific/Auckland. Null or {} = always active; start > end wraps overnight.';

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."manage_zone_active_schedule"(
  p_zone_id uuid,
  p_expected_version integer,
  p_days integer[] DEFAULT NULL,
  p_start time DEFAULT NULL,
  p_end time DEFAULT NULL,
  p_months integer[] DEFAULT NULL
) RETURNS public.location_zones
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_zone public.location_zones%rowtype;
  v_days integer[];
  v_months integer[];
  v_schedule jsonb := '{}'::jsonb;
  v_before jsonb;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select * into v_zone from public.location_zones z where z.id = p_zone_id for update;
  if not found then raise exception 'Zone not found'; end if;
  if not (
    (v_zone.location_id is not null and public.crm_actor_can_manage_location(v_zone.location_id))
    or public.is_admin_for_org(v_zone.organization_id)
  ) then raise exception 'Active CRM administrator required for this zone'; end if;
  if v_zone.configuration_version <> p_expected_version then
    raise exception 'Zone configuration changed since it was opened; reload and try again';
  end if;

  -- Days: ISO 1..7, distinct, sorted. All seven (or none) is no restriction.
  select coalesce(array_agg(distinct d order by d), '{}') into v_days from unnest(coalesce(p_days, '{}')) d;
  if exists (select 1 from unnest(v_days) d where d < 1 or d > 7) then
    raise exception 'Days must be 1 (Monday) to 7 (Sunday)';
  end if;
  select coalesce(array_agg(distinct m order by m), '{}') into v_months from unnest(coalesce(p_months, '{}')) m;
  if exists (select 1 from unnest(v_months) m where m < 1 or m > 12) then
    raise exception 'Months must be 1 (January) to 12 (December)';
  end if;
  if (p_start is null) <> (p_end is null) then
    raise exception 'Give both a start and an end time, or neither for any time of day';
  end if;
  if p_start is not null and p_start = p_end then
    raise exception 'Start and end times must differ (leave both empty for any time of day)';
  end if;

  if array_length(v_days, 1) between 1 and 6 then v_schedule := v_schedule || jsonb_build_object('days', to_jsonb(v_days)); end if;
  if array_length(v_months, 1) between 1 and 11 then v_schedule := v_schedule || jsonb_build_object('months', to_jsonb(v_months)); end if;
  if p_start is not null then v_schedule := v_schedule || jsonb_build_object('start', to_char(p_start, 'HH24:MI'), 'end', to_char(p_end, 'HH24:MI')); end if;

  v_before := v_zone.active_schedule;
  update public.location_zones
     set active_schedule = case when v_schedule = '{}'::jsonb then null else v_schedule end,
         configuration_version = configuration_version + 1
   where id = v_zone.id
   returning * into v_zone;

  insert into public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  values (v_zone.organization_id, v_actor, 'zone_active_schedule_updated', 'location_zones', v_zone.id,
          jsonb_build_object('before', v_before, 'after', v_zone.active_schedule, 'configuration_version', v_zone.configuration_version));
  return v_zone;
end;
$function$;
COMMENT ON FUNCTION "public"."manage_zone_active_schedule"(uuid, integer, integer[], time, time, integer[]) IS 'Governed writer for location_zones.active_schedule: ISO days (1=Mon..7=Sun), optional start/end time (overnight allowed), optional months. All-days / no-times / all-months collapse to always active (null). Optimistic version check; audit row with before/after.';
REVOKE ALL ON FUNCTION "public"."manage_zone_active_schedule"(uuid, integer, integer[], time, time, integer[]) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."manage_zone_active_schedule"(uuid, integer, integer[], time, time, integer[]) TO "authenticated", "service_role";
