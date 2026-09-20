-- Patrol visits are spread across the contracted window, and the rosterer is told when a shift
-- cannot honour the contract.
--
-- Before: generate_shift_stops gave every visit of a multi-visit stop the SAME window (visit 1 and
-- visit 2 both "arrive between 07:00 and 07:30"), ignored window_end and the shift's own hours, and
-- stamped a window that opened before the shift started when the shift began later than the
-- contract window. Observed live 2026-09-20 on the Multi Module Nelson run (2 visits, 07:00–19:00,
-- min gap 60): both visits due 07:00–07:30 on a 07:00–11:00 shift. preview_work_unit_coverage only
-- knew the date, so the roster could warn about the weekday but not about a shift that sits
-- outside the contracted hours or is too short for the contracted visits. get_officer_patrol_stops
-- returned only the legacy singular module_key ('general_patrol') so the officer was never told the
-- stop's toolset (here: parking enforcement).
--
-- After:
--  * generate_shift_stops intersects the contract window with the shift, slices it evenly by
--    visits_per_shift, and gives visit k its own open / arrive-by / depart-by. A shift wholly outside
--    the window keeps the contract's own window so the breach is visible, not hidden. Windows that
--    cross midnight are handled. Non-windowed configs with several visits are spread across the shift.
--  * preview_work_unit_coverage(p_work_unit_id, p_shift_date, p_scheduled_start, p_scheduled_end)
--    also returns the contracted hours, the largest visit count / minimum gap, and two plain flags:
--    outside_window (no overlap between the shift and any contracted window that day) and
--    too_short_for_visits (the overlap cannot fit the contracted visits their minimum gap apart).
--  * get_officer_patrol_stops returns `modules` (the stop's toolset from shift_stop_modules).
-- Doctrine: "a guard on a place for a shift, with a toolset" (docs/canon unified field operations).

CREATE OR REPLACE FUNCTION "public"."generate_shift_stops"(p_shift_id uuid, p_shift_date date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_shift           record;
  v_config          record;
  v_stop_id         uuid;
  v_stop_count      integer := 0;
  v_visit           integer;
  v_visits          integer;
  v_window_open     timestamptz;
  v_window_close    timestamptz;
  v_eff_open        timestamptz;
  v_eff_close       timestamptz;
  v_step            interval;
  v_sla_open        timestamptz;
  v_sla_arrive_by   timestamptz;
  v_sla_depart_by   timestamptz;
  v_day_of_week     integer;
  v_month           integer;
  v_module_count    integer;
BEGIN
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift % not found', p_shift_id;
  END IF;

  v_day_of_week := extract(isodow FROM p_shift_date)::integer;
  v_month       := extract(month  FROM p_shift_date)::integer;

  -- Regenerate the contracted (non-adhoc) stops; shift_stop_modules cascade.
  DELETE FROM shift_stops WHERE shift_id = p_shift_id AND is_adhoc = false;

  FOR v_config IN
    SELECT cspc.*
    FROM   client_site_patrol_config cspc
    WHERE  cspc.patrol_route_id = v_shift.patrol_route_id
      AND  cspc.active = true
      AND  (array_length(cspc.active_days, 1) IS NULL OR v_day_of_week = ANY(cspc.active_days))
      AND  (array_length(cspc.active_months, 1) IS NULL OR array_length(cspc.active_months, 1) = 0 OR v_month = ANY(cspc.active_months))
    ORDER BY cspc.preferred_stop_order, cspc.id
  LOOP
    v_visits := greatest(coalesce(v_config.visits_per_shift, 1), 1);

    IF v_config.time_window_type = 'fixed' AND v_config.window_start IS NOT NULL THEN
      v_window_open  := (p_shift_date + v_config.window_start) AT TIME ZONE 'Pacific/Auckland';
      v_window_close := CASE WHEN v_config.window_end IS NOT NULL THEN (p_shift_date + v_config.window_end) AT TIME ZONE 'Pacific/Auckland' END;
      -- A window that "ends" before it starts crosses midnight (e.g. 22:00–02:00).
      IF v_window_close IS NOT NULL AND v_window_close <= v_window_open THEN v_window_close := v_window_close + interval '1 day'; END IF;
      -- The visits are due inside the part of the contract window this shift actually covers.
      v_eff_open  := greatest(v_window_open, v_shift.scheduled_start);
      v_eff_close := least(coalesce(v_window_close, v_shift.scheduled_end), v_shift.scheduled_end);
      IF v_eff_close <= v_eff_open THEN
        -- The shift sits outside the contracted hours: keep the contract's own window so the breach shows.
        v_eff_open  := v_window_open;
        v_eff_close := coalesce(v_window_close, v_window_open + make_interval(mins => coalesce(v_config.sla_arrive_within_minutes, 30)));
      END IF;
      v_step := CASE WHEN v_visits > 1 THEN (v_eff_close - v_eff_open) / v_visits ELSE interval '0' END;
    ELSE
      v_eff_open  := v_shift.scheduled_start;
      v_eff_close := v_shift.scheduled_end;
      v_step := CASE WHEN v_visits > 1 THEN (v_eff_close - v_eff_open) / v_visits ELSE interval '0' END;
    END IF;

    FOR v_visit IN 1..v_visits LOOP
      IF v_config.time_window_type = 'fixed' AND v_config.window_start IS NOT NULL THEN
        v_sla_open      := v_eff_open + v_step * (v_visit - 1);
        v_sla_arrive_by := v_sla_open + make_interval(mins => coalesce(v_config.sla_arrive_within_minutes, 30));
        v_sla_depart_by := v_sla_arrive_by + make_interval(mins => coalesce(v_config.sla_depart_within_minutes, 45));
      ELSIF v_visits > 1 THEN
        -- No contracted clock time: each visit owns an equal slice of the shift.
        v_sla_open      := v_eff_open + v_step * (v_visit - 1);
        v_sla_arrive_by := v_sla_open + v_step;
        v_sla_depart_by := NULL;
      ELSE
        v_sla_open      := NULL;
        v_sla_arrive_by := v_shift.scheduled_end;
        v_sla_depart_by := NULL;
      END IF;

      INSERT INTO shift_stops (
        organization_id, shift_id, patrol_config_id, site_id, zone_id, module_key,
        stop_order, visit_number, is_adhoc, sla_window_open, sla_arrive_by, sla_depart_by,
        required_dwell_minutes, officer_instructions, status, sla_status
      ) VALUES (
        v_shift.organization_id, p_shift_id, v_config.id, v_config.site_id, v_config.zone_id, v_config.module_key,
        (v_config.preferred_stop_order * 10) + v_visit, v_visit, false, v_sla_open, v_sla_arrive_by, v_sla_depart_by,
        v_config.dwell_minutes, v_config.officer_instructions, 'pending', 'on_track'
      )
      RETURNING id INTO v_stop_id;

      INSERT INTO shift_stop_modules (organization_id, shift_stop_id, module_key, is_required, service_agreement_module_id, service_agreement_location_id)
      SELECT v_shift.organization_id, v_stop_id, prsm.module_key, prsm.is_required, prsm.service_agreement_module_id, prsm.service_agreement_location_id
      FROM   patrol_route_stop_modules prsm
      WHERE  prsm.patrol_config_id = v_config.id AND prsm.active = true
      ON CONFLICT (shift_stop_id, module_key) DO NOTHING;

      GET DIAGNOSTICS v_module_count = ROW_COUNT;
      IF v_module_count = 0 THEN
        INSERT INTO shift_stop_modules (organization_id, shift_stop_id, module_key, is_required)
        VALUES (v_shift.organization_id, v_stop_id, v_config.module_key, true)
        ON CONFLICT (shift_stop_id, module_key) DO NOTHING;
      END IF;

      v_stop_count := v_stop_count + 1;
    END LOOP;
  END LOOP;

  UPDATE shifts SET total_stops = v_stop_count, generated_at = now() WHERE id = p_shift_id;
  RETURN v_stop_count;
END;
$function$;
COMMENT ON FUNCTION "public"."generate_shift_stops"(p_shift_id uuid, p_shift_date date) IS 'Generates the contracted shift_stops for a patrol shift from client_site_patrol_config on that date. Visits are spread evenly across the part of the contract window the shift covers (each visit has its own open / arrive-by / depart-by); a shift outside the window keeps the contract window so the breach is visible. Dual-writes shift_stop_modules (toolset + contract inheritance from patrol_route_stop_modules).';
-- It was executable by PUBLIC and anon (a definer function that rewrites any shift's stops). Signed-in callers and the service role only.
REVOKE ALL ON FUNCTION "public"."generate_shift_stops"(p_shift_id uuid, p_shift_date date) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."generate_shift_stops"(p_shift_id uuid, p_shift_date date) TO "authenticated", "service_role";

-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.preview_work_unit_coverage(uuid, date);

CREATE OR REPLACE FUNCTION "public"."preview_work_unit_coverage"(p_work_unit_id uuid, p_shift_date date, p_scheduled_start timestamptz DEFAULT NULL, p_scheduled_end timestamptz DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_window_start time;
  v_window_end time;
  v_visits_max integer := 1;
  v_min_gap integer := 0;
  v_outside_window boolean := false;
  v_too_short boolean := false;
  v_cfg record;
  v_open timestamptz;
  v_close timestamptz;
  v_eff_open timestamptz;
  v_eff_close timestamptz;
  v_overlaps integer := 0;
  v_windowed integer := 0;
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
           count(*)::integer,
           min(c.window_start) filter (where c.time_window_type = 'fixed'),
           max(c.window_end) filter (where c.time_window_type = 'fixed'),
           coalesce(max(c.visits_per_shift), 1),
           coalesce(max(c.min_gap_between_visits_minutes), 0)
    into v_stop_count, v_config_count, v_window_start, v_window_end, v_visits_max, v_min_gap
    from public.client_site_patrol_config c
    where c.patrol_route_id = v_unit.patrol_route_id and c.active;

    select coalesce(array_agg(distinct d order by d), '{}') into v_days
    from public.client_site_patrol_config c
    cross join lateral unnest(case when array_length(c.active_days, 1) is null then '{1,2,3,4,5,6,7}'::integer[] else c.active_days end) as d
    where c.patrol_route_id = v_unit.patrol_route_id and c.active;

    -- With the shift's hours we can say whether it sits inside the contracted window and can fit the visits.
    if p_scheduled_start is not null and p_scheduled_end is not null and p_scheduled_end > p_scheduled_start then
      for v_cfg in
        select c.* from public.client_site_patrol_config c
        where c.patrol_route_id = v_unit.patrol_route_id and c.active
          and (array_length(c.active_days, 1) is null or v_dow = any(c.active_days))
          and (array_length(c.active_months, 1) is null or array_length(c.active_months, 1) = 0 or v_month = any(c.active_months))
      loop
        if v_cfg.time_window_type = 'fixed' and v_cfg.window_start is not null then
          v_windowed := v_windowed + 1;
          v_open := (p_shift_date + v_cfg.window_start) at time zone 'Pacific/Auckland';
          v_close := case when v_cfg.window_end is not null then (p_shift_date + v_cfg.window_end) at time zone 'Pacific/Auckland' end;
          if v_close is not null and v_close <= v_open then v_close := v_close + interval '1 day'; end if;
          v_eff_open := greatest(v_open, p_scheduled_start);
          v_eff_close := least(coalesce(v_close, p_scheduled_end), p_scheduled_end);
          if v_eff_close > v_eff_open then
            v_overlaps := v_overlaps + 1;
            if coalesce(v_cfg.visits_per_shift, 1) > 1
               and extract(epoch from (v_eff_close - v_eff_open)) / 60 < (coalesce(v_cfg.visits_per_shift, 1) - 1) * coalesce(v_cfg.min_gap_between_visits_minutes, 0) then
              v_too_short := true;
            end if;
          end if;
        elsif coalesce(v_cfg.visits_per_shift, 1) > 1
              and extract(epoch from (p_scheduled_end - p_scheduled_start)) / 60 < (coalesce(v_cfg.visits_per_shift, 1) - 1) * coalesce(v_cfg.min_gap_between_visits_minutes, 0) then
          v_too_short := true;
        end if;
      end loop;
      v_outside_window := v_windowed > 0 and v_overlaps = 0;
    end if;

    return jsonb_build_object(
      'kind', 'patrol',
      'day_of_week', v_dow,
      'stop_count', v_stop_count,
      'config_count', v_config_count,
      'contracted_days', to_jsonb(v_days),
      'has_route', v_unit.patrol_route_id is not null,
      'window_start', to_char(v_window_start, 'HH24:MI'),
      'window_end', to_char(v_window_end, 'HH24:MI'),
      'visits_max', v_visits_max,
      'min_gap_minutes', v_min_gap,
      'outside_window', v_outside_window,
      'too_short_for_visits', v_too_short,
      'ok', v_stop_count > 0 and not v_outside_window
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
$function$;
COMMENT ON FUNCTION "public"."preview_work_unit_coverage"(p_work_unit_id uuid, p_shift_date date, p_scheduled_start timestamptz, p_scheduled_end timestamptz) IS 'Before a roster slot is created: for a patrol run, how many contracted stops the route produces on that date, which weekdays and hours the contract covers, and — given the shift hours — whether the shift sits outside the contracted window or is too short to fit the contracted visits their minimum gap apart. For a static post, whether the place has a verified boundary and a static guarding module.';
REVOKE ALL ON FUNCTION "public"."preview_work_unit_coverage"(uuid, date, timestamptz, timestamptz) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."preview_work_unit_coverage"(uuid, date, timestamptz, timestamptz) TO "authenticated", "service_role";

-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "public"."get_officer_patrol_stops"(p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_shift_id is not null then
    select * into v_shift from public.shifts where id = p_shift_id and officer_user_id = v_actor;
  else
    select * into v_shift from public.shifts
    where officer_user_id = v_actor and status in ('in_progress', 'accepted')
    order by case status when 'in_progress' then 0 else 1 end, scheduled_start desc limit 1;
  end if;
  if not found then return null; end if;

  return jsonb_build_object(
    'shift', jsonb_build_object('id', v_shift.id, 'status', v_shift.status, 'scheduled_start', v_shift.scheduled_start, 'scheduled_end', v_shift.scheduled_end,
      'route_name', (select r.name from public.patrol_routes r where r.id = v_shift.patrol_route_id)),
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', st.id, 'stop_order', st.stop_order, 'visit_number', st.visit_number,
        'visits_total', (select count(*) from public.shift_stops v where v.shift_id = st.shift_id and v.patrol_config_id is not distinct from st.patrol_config_id and v.site_id is not distinct from st.site_id and v.zone_id is not distinct from st.zone_id and v.is_adhoc = false),
        'status', st.status, 'sla_status', st.sla_status,
        'sla_window_open', st.sla_window_open, 'sla_arrive_by', st.sla_arrive_by, 'sla_depart_by', st.sla_depart_by,
        'required_dwell_minutes', st.required_dwell_minutes, 'officer_instructions', st.officer_instructions,
        'actual_arrived_at', st.actual_arrived_at, 'actual_departed_at', st.actual_departed_at,
        'arrival_verification', st.arrival_verification, 'arrival_distance_m', st.arrival_distance_m, 'officer_notes', st.officer_notes,
        'module_key', st.module_key,
        -- The toolset for this stop: what the officer is there to do (module-as-data, from shift_stop_modules).
        'modules', coalesce((select jsonb_agg(jsonb_build_object('module_key', m.module_key, 'is_required', m.is_required, 'status', m.status) order by m.is_required desc, m.module_key)
                             from public.shift_stop_modules m where m.shift_stop_id = st.id), '[]'::jsonb),
        'place', case
          when st.site_id is not null then (select jsonb_build_object('kind', 'site', 'name', cs.name, 'address', cs.address, 'access_instructions', cs.access_instructions, 'hs_notes', cs.hs_notes) from public.client_sites cs where cs.id = st.site_id)
          when st.zone_id is not null then (select jsonb_build_object('kind', 'zone', 'name', lz.name, 'address', null, 'access_instructions', null, 'hs_notes', null) from public.location_zones lz where lz.id = st.zone_id)
          else jsonb_build_object('kind', 'unknown', 'name', 'Contracted place', 'address', null, 'access_instructions', null, 'hs_notes', null) end
      ) order by st.stop_order, st.visit_number)
      from public.shift_stops st
      where st.shift_id = v_shift.id and st.is_adhoc = false and st.module_key <> 'static_guarding'
    ), '[]'::jsonb)
  );
end;
$function$;
COMMENT ON FUNCTION "public"."get_officer_patrol_stops"(p_shift_id uuid) IS 'Officer-scoped read of the contracted (non-adhoc, non-static) shift stops for one of the caller''s shifts, with place brief, timing window, toolset (modules), instructions, and attendance evidence. Returns null when the caller has no such shift.';

-- Re-time the stops of shifts that have not started yet, so already-published rosters carry the corrected windows.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT s.id, s.scheduled_start
    FROM public.shifts s
    WHERE s.patrol_route_id IS NOT NULL
      AND s.status IN ('scheduled', 'published', 'accepted')
      AND s.scheduled_start > now()
      AND EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id = s.id AND st.is_adhoc = false AND st.status = 'pending')
      AND NOT EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id = s.id AND st.status <> 'pending')
  LOOP
    PERFORM public.generate_shift_stops(r.id, (r.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date);
  END LOOP;
END $$;
