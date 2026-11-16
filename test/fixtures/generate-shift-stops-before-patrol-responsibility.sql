-- generate_shift_stops as it was live before 20261116045308_location_patrol_responsibility.sql
-- (taken from the catalog snapshot at 9e6f4585). The migration test replays it as the baseline.
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
      AND  cspc.time_window_type <> 'as_attended'
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
