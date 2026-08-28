create or replace function public.generate_shift_stops (
  p_shift_id   uuid,
  p_shift_date date
)
  returns integer
  language plpgsql
  security definer
  AS $function$
DECLARE
  v_shift           record;
  v_config          record;
  v_stop_id         uuid;
  v_stop_count      integer := 0;
  v_visit           integer;
  v_sla_open        timestamptz;
  v_sla_arrive_by   timestamptz;
  v_sla_depart_by   timestamptz;
  v_day_of_week     integer;
  v_month           integer;
  v_module_count    integer;
BEGIN
  -- Load shift.
  SELECT * INTO v_shift FROM shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift % not found', p_shift_id;
  END IF;

  v_day_of_week := extract(isodow FROM p_shift_date)::integer;
  v_month       := extract(month  FROM p_shift_date)::integer;

  -- Delete any previously generated (non-adhoc) stops for this shift.
  -- shift_stop_modules rows cascade via FK ON DELETE CASCADE (0138).
  DELETE FROM shift_stops
  WHERE shift_id = p_shift_id
    AND is_adhoc = false;

  -- Iterate over all active patrol configs for this route (site OR zone stops).
  FOR v_config IN
    SELECT cspc.*
    FROM   client_site_patrol_config cspc
    WHERE  cspc.patrol_route_id = v_shift.patrol_route_id
      AND  cspc.active = true
      AND  (array_length(cspc.active_days, 1) IS NULL
            OR v_day_of_week = ANY(cspc.active_days))
      AND  (array_length(cspc.active_months, 1) IS NULL
            OR array_length(cspc.active_months, 1) = 0
            OR v_month = ANY(cspc.active_months))
    ORDER BY cspc.preferred_stop_order, cspc.id
  LOOP
    -- Calculate SLA window from config (same rule as 0030).
    IF v_config.time_window_type = 'fixed'
       AND v_config.window_start IS NOT NULL THEN
      v_sla_open      := (p_shift_date + v_config.window_start) AT TIME ZONE 'Pacific/Auckland';
      v_sla_arrive_by := v_sla_open + (v_config.sla_arrive_within_minutes || ' minutes')::interval;
      v_sla_depart_by := v_sla_arrive_by + (v_config.sla_depart_within_minutes || ' minutes')::interval;
    ELSE
      v_sla_open      := NULL;
      v_sla_arrive_by := v_shift.scheduled_end;
      v_sla_depart_by := NULL;
    END IF;

    -- Insert one stop per required visit. PLACE XOR: set EITHER site_id OR
    -- zone_id from the config (never both) so shift_stops_place_xor holds.
    FOR v_visit IN 1..v_config.visits_per_shift LOOP
      INSERT INTO shift_stops (
        organization_id,
        shift_id,
        patrol_config_id,
        site_id,
        zone_id,
        module_key,
        stop_order,
        visit_number,
        is_adhoc,
        sla_window_open,
        sla_arrive_by,
        sla_depart_by,
        required_dwell_minutes,
        officer_instructions,
        status,
        sla_status
      ) VALUES (
        v_shift.organization_id,
        p_shift_id,
        v_config.id,
        v_config.site_id,     -- null for a zone-stop
        v_config.zone_id,     -- null for a site-stop
        v_config.module_key,  -- legacy singular (dual-write)
        (v_config.preferred_stop_order * 10) + v_visit,
        v_visit,
        false,
        v_sla_open,
        v_sla_arrive_by,
        v_sla_depart_by,
        v_config.dwell_minutes,
        v_config.officer_instructions,
        'pending',
        'on_track'
      )
      RETURNING id INTO v_stop_id;

      -- DUAL-WRITE shift_stop_modules for this stop.
      -- NOW ALSO COPIES service_agreement_module_id + service_agreement_location_id
      -- from the plan-time module rows (contract inheritance, #328).
      INSERT INTO shift_stop_modules (
        organization_id, shift_stop_id, module_key, is_required,
        service_agreement_module_id, service_agreement_location_id
      )
      SELECT
        v_shift.organization_id,
        v_stop_id,
        prsm.module_key,
        prsm.is_required,
        prsm.service_agreement_module_id,
        prsm.service_agreement_location_id
      FROM   patrol_route_stop_modules prsm
      WHERE  prsm.patrol_config_id = v_config.id
        AND  prsm.active = true
      ON CONFLICT (shift_stop_id, module_key) DO NOTHING;

      GET DIAGNOSTICS v_module_count = ROW_COUNT;
      IF v_module_count = 0 THEN
        -- No plan-time module rows: seed one from the legacy singular module_key.
        -- No contract to inherit in this fallback path (legacy config).
        INSERT INTO shift_stop_modules (
          organization_id, shift_stop_id, module_key, is_required
        )
        VALUES (v_shift.organization_id, v_stop_id, v_config.module_key, true)
        ON CONFLICT (shift_stop_id, module_key) DO NOTHING;
      END IF;

      v_stop_count := v_stop_count + 1;
    END LOOP;
  END LOOP;

  -- Update shift with stop count and generation timestamp.
  UPDATE shifts
  SET total_stops  = v_stop_count,
      generated_at = now()
  WHERE id = p_shift_id;

  RETURN v_stop_count;
END;
$function$;

grant execute on function "public"."generate_shift_stops"(uuid, date) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."generate_shift_stops"(uuid, date) is 'Generates shift_stops from client_site_patrol_config for a shift+date. Phase 1b (0140) + contract inheritance (0363, #328): materialises ZONE-stops, dual-writes shift_stop_modules with service_agreement_module_id + service_agreement_location_id inherited from patrol_route_stop_modules. Called by apps/api when a shift is published.';
