-- Patrols are 24-hour, 7-day work by default; contracted windows that cross midnight follow the shift.
--
-- Owner ruling 2026-09-20: Monday is the first day of the week (ISO 1–7 everywhere, already the
-- schema's convention) and a patrol may be required at any hour of any day. A contracted window is
-- the exception, not the rule — and when one exists it must work at night as well as by day.
--
-- Before (20260920130000): generate_shift_stops and preview_work_unit_coverage anchored the contract
-- window on the shift's start date only. A 22:00–06:00 window was handled when the shift began before
-- midnight, but a 00:00–06:00 shift on the same contract was judged "outside the window" because the
-- window was anchored on the shift's own date (22:00 that night) instead of the night before.
--
-- After: patrol_window_bounds(...) resolves the contract window for a shift — same-day anchor first,
-- previous-day anchor when only that one overlaps the shift — and both functions use it. Nothing else
-- about the visit spreading (20260920130000) changes. A config without a window means any time of
-- day: the visits are spread across the shift.

CREATE OR REPLACE FUNCTION "public"."patrol_window_bounds"(p_shift_date date, p_window_start time, p_window_end time, p_shift_start timestamptz, p_shift_end timestamptz)
 RETURNS TABLE(window_open timestamptz, window_close timestamptz)
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
DECLARE
  v_open timestamptz;
  v_close timestamptz;
BEGIN
  IF p_window_start IS NULL THEN
    RETURN QUERY SELECT NULL::timestamptz, NULL::timestamptz;
    RETURN;
  END IF;
  v_open := (p_shift_date + p_window_start) AT TIME ZONE 'Pacific/Auckland';
  v_close := CASE WHEN p_window_end IS NOT NULL THEN (p_shift_date + p_window_end) AT TIME ZONE 'Pacific/Auckland' END;
  -- A window that "ends" before it starts crosses midnight (e.g. 22:00–06:00).
  IF v_close IS NOT NULL AND v_close <= v_open THEN v_close := v_close + interval '1 day'; END IF;
  -- Last night's window may still be running when a shift starts after midnight.
  IF p_shift_start IS NOT NULL AND p_shift_end IS NOT NULL AND v_close IS NOT NULL
     AND NOT (v_open < p_shift_end AND p_shift_start < v_close)
     AND (v_open - interval '1 day') < p_shift_end AND p_shift_start < (v_close - interval '1 day') THEN
    v_open := v_open - interval '1 day';
    v_close := v_close - interval '1 day';
  END IF;
  RETURN QUERY SELECT v_open, v_close;
END;
$function$;
COMMENT ON FUNCTION "public"."patrol_window_bounds"(date, time, time, timestamptz, timestamptz) IS 'The contracted patrol window for a shift, as timestamps: anchored on the shift date, extended past midnight when the window crosses it, and anchored on the previous day when only last night''s window overlaps a shift that starts after midnight. Null window_start = any time of day.';
REVOKE ALL ON FUNCTION "public"."patrol_window_bounds"(date, time, time, timestamptz, timestamptz) FROM PUBLIC, "anon";
GRANT EXECUTE ON FUNCTION "public"."patrol_window_bounds"(date, time, time, timestamptz, timestamptz) TO "authenticated", "service_role";

-- ---------------------------------------------------------------------------------------------
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
  v_windowed        boolean;
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
    v_windowed := v_config.time_window_type = 'fixed' AND v_config.window_start IS NOT NULL;

    IF v_windowed THEN
      SELECT b.window_open, b.window_close INTO v_window_open, v_window_close
      FROM public.patrol_window_bounds(p_shift_date, v_config.window_start, v_config.window_end, v_shift.scheduled_start, v_shift.scheduled_end) b;
      -- The visits are due inside the part of the contract window this shift actually covers.
      v_eff_open  := greatest(v_window_open, v_shift.scheduled_start);
      v_eff_close := least(coalesce(v_window_close, v_shift.scheduled_end), v_shift.scheduled_end);
      IF v_eff_close <= v_eff_open THEN
        -- The shift sits outside the contracted hours: keep the contract's own window so the breach shows.
        v_eff_open  := v_window_open;
        v_eff_close := coalesce(v_window_close, v_window_open + make_interval(mins => coalesce(v_config.sla_arrive_within_minutes, 30)));
      END IF;
    ELSE
      -- Any time of day: the visits are spread across the shift.
      v_eff_open  := v_shift.scheduled_start;
      v_eff_close := v_shift.scheduled_end;
    END IF;
    v_step := CASE WHEN v_visits > 1 THEN (v_eff_close - v_eff_open) / v_visits ELSE interval '0' END;

    FOR v_visit IN 1..v_visits LOOP
      IF v_windowed THEN
        v_sla_open      := v_eff_open + v_step * (v_visit - 1);
        v_sla_arrive_by := v_sla_open + make_interval(mins => coalesce(v_config.sla_arrive_within_minutes, 30));
        v_sla_depart_by := v_sla_arrive_by + make_interval(mins => coalesce(v_config.sla_depart_within_minutes, 45));
      ELSIF v_visits > 1 THEN
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

-- ---------------------------------------------------------------------------------------------
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
    -- Same day/month rule as generate_shift_stops. No active_days = every day; no window = any time of day.
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

    if p_scheduled_start is not null and p_scheduled_end is not null and p_scheduled_end > p_scheduled_start then
      for v_cfg in
        select c.* from public.client_site_patrol_config c
        where c.patrol_route_id = v_unit.patrol_route_id and c.active
          and (array_length(c.active_days, 1) is null or v_dow = any(c.active_days))
          and (array_length(c.active_months, 1) is null or array_length(c.active_months, 1) = 0 or v_month = any(c.active_months))
      loop
        if v_cfg.time_window_type = 'fixed' and v_cfg.window_start is not null then
          v_windowed := v_windowed + 1;
          select b.window_open, b.window_close into v_open, v_close
          from public.patrol_window_bounds(p_shift_date, v_cfg.window_start, v_cfg.window_end, p_scheduled_start, p_scheduled_end) b;
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
