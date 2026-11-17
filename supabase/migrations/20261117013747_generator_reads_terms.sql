-- Versioned patrol terms add the officer-facing checks to each generated stop.
ALTER TABLE public.shift_stops
  ADD COLUMN required_checks text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.shift_stops.required_checks IS
  'Checks required by the approved place-service terms that were in force when this stop was generated.';

CREATE OR REPLACE FUNCTION public.generate_shift_stops_internal(p_shift_id uuid,p_shift_date date,p_config_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $function$
DECLARE
  v_shift public.shifts%rowtype;
  v_config public.client_site_patrol_config%rowtype;
  v_stop_id uuid; v_stop_count integer:=0; v_visit integer; v_visits integer;
  v_window_open timestamptz; v_window_close timestamptz; v_eff_open timestamptz; v_eff_close timestamptz;
  v_step interval; v_sla_open timestamptz; v_sla_arrive_by timestamptz; v_sla_depart_by timestamptz;
  v_day integer:=extract(isodow FROM p_shift_date)::integer;
  v_month integer:=extract(month FROM p_shift_date)::integer;
  v_module_count integer; v_windowed boolean; v_reason text; v_initial_materialization boolean;
  v_shift_unit uuid; v_resp public.patrol_config_responsibilities%rowtype;
  v_terms jsonb; v_runs boolean; v_point geometry(Point,4326);
  v_min_gap integer; v_dwell integer; v_instructions text; v_checks text[];
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id;
  IF NOT FOUND OR p_shift_date IS NULL THEN RAISE EXCEPTION 'Shift and NZ service date are required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('patrol-plan-org:'||v_shift.organization_id,0));
  SELECT * INTO STRICT v_shift FROM public.shifts WHERE id=p_shift_id FOR UPDATE NOWAIT;
  IF p_shift_date<>(v_shift.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date THEN
    RAISE EXCEPTION 'Stop generation must use the shift NZ service date';
  END IF;
  v_reason:=public.patrol_shift_plan_locked_reason(p_shift_id);
  v_initial_materialization:=p_config_id IS NULL AND v_shift.generated_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.shift_stops WHERE shift_id=p_shift_id)
    AND (
      (v_reason='Scheduled start has passed' AND v_shift.status IN('scheduled','published','accepted')
        AND v_shift.actual_start IS NULL AND v_shift.actual_end IS NULL)
      OR (v_reason='Shift already started or is no longer an unstarted plan'
        AND v_shift.shift_origin='ad_hoc' AND v_shift.status='in_progress' AND v_shift.actual_end IS NULL)
    );
  IF v_reason IS NOT NULL AND NOT coalesce(v_initial_materialization,false) THEN
    RAISE EXCEPTION 'Cannot regenerate patrol plan: %',v_reason USING ERRCODE='40001';
  END IF;
  DELETE FROM public.shift_stops WHERE shift_id=p_shift_id AND NOT is_adhoc
    AND (p_config_id IS NULL OR patrol_config_id=p_config_id);
  v_shift_unit:=public.patrol_shift_work_unit_id(p_shift_id);
  FOR v_config IN SELECT c.* FROM public.client_site_patrol_config c
    WHERE c.organization_id=v_shift.organization_id AND c.active AND c.time_window_type<>'as_attended'
      AND public.patrol_config_serves(c.id,p_shift_date,v_shift.patrol_route_id,v_shift_unit)
      AND (p_config_id IS NULL OR c.id=p_config_id)
    ORDER BY c.preferred_stop_order,c.id
  LOOP
    v_resp:=NULL;
    SELECT * INTO v_resp FROM public.patrol_config_responsibilities r
      WHERE r.patrol_config_id=v_config.id AND r.superseded_at IS NULL
        AND r.effective_from<=p_shift_date AND (r.effective_to IS NULL OR r.effective_to>=p_shift_date)
      ORDER BY r.effective_from DESC LIMIT 1;

    v_terms:=NULL;
    IF v_config.delivery_schedule_id IS NOT NULL THEN
      v_terms:=public.place_service_terms_at(v_config.delivery_schedule_id,p_shift_date);
      IF v_terms IS NULL AND (public.place_service_version_at(v_config.delivery_schedule_id,p_shift_date)).change_kind='end' THEN
        CONTINUE;
      END IF;
    END IF;
    IF v_terms IS NULL THEN
      IF (array_length(v_config.active_days,1) IS NOT NULL AND NOT (v_day=ANY(v_config.active_days)))
        OR (cardinality(v_config.active_months)>0 AND NOT (v_month=ANY(v_config.active_months))) THEN
        CONTINUE;
      END IF;
      v_visits:=greatest(coalesce(v_config.visits_per_shift,1),1);
      v_min_gap:=coalesce(v_config.min_gap_between_visits_minutes,0);
      v_dwell:=v_config.dwell_minutes;
      v_instructions:=v_config.officer_instructions;
      v_checks:='{}'::text[];
      v_windowed:=v_config.time_window_type='fixed' AND v_config.window_start IS NOT NULL;
      IF v_windowed THEN
        SELECT b.window_open,b.window_close INTO v_window_open,v_window_close
          FROM public.patrol_window_bounds(p_shift_date,v_config.window_start,v_config.window_end,
            v_shift.scheduled_start,v_shift.scheduled_end) b;
        v_eff_open:=greatest(v_window_open,v_shift.scheduled_start);
        v_eff_close:=least(coalesce(v_window_close,v_shift.scheduled_end),v_shift.scheduled_end);
        IF v_eff_close<=v_eff_open THEN
          v_eff_open:=v_window_open;
          v_eff_close:=coalesce(v_window_close,v_window_open+make_interval(mins=>coalesce(v_config.sla_arrive_within_minutes,30)));
        END IF;
      ELSE
        v_eff_open:=v_shift.scheduled_start;
        v_eff_close:=v_shift.scheduled_end;
      END IF;
    ELSE
      v_runs:=public.place_service_runs_on(v_terms,v_config.delivery_schedule_id,p_shift_date);
      IF v_runs IS NULL THEN
        RAISE EXCEPTION 'Random patrol days are not configured for this service';
      END IF;
      IF NOT v_runs THEN
        CONTINUE;
      END IF;

      v_visits:=greatest(public.place_service_json_int(v_terms->'visits_per_shift'),1);
      v_min_gap:=greatest(coalesce(public.place_service_json_int(v_terms->'min_gap_minutes'),0),0);
      v_dwell:=public.place_service_json_int(v_terms->'dwell_minutes');
      v_instructions:=nullif(btrim(coalesce(v_terms->>'officer_instructions','')),'');
      SELECT coalesce(array_agg(e.check_key ORDER BY e.ordinality),'{}'::text[])
        INTO v_checks
      FROM jsonb_array_elements_text(coalesce(v_terms->'checks','[]'::jsonb))
        WITH ORDINALITY AS e(check_key,ordinality);
      v_point:=public.place_anchor_point(
        nullif(v_terms->'anchor'->>'site_id','')::uuid,
        nullif(v_terms->'anchor'->>'zone_id','')::uuid);
      SELECT w.window_open,w.window_close INTO v_window_open,v_window_close
        FROM public.place_service_window_at(v_terms,p_shift_date,v_point,
          v_shift.scheduled_start,v_shift.scheduled_end) w;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;
      v_windowed:=v_terms->'window'->>'mode' IN('fixed','solar');
      IF v_windowed THEN
        IF v_window_open IS NULL OR v_window_close IS NULL THEN
          CONTINUE;
        END IF;
        v_eff_open:=v_window_open;
        v_eff_close:=v_window_close;
      ELSE
        v_eff_open:=v_shift.scheduled_start;
        v_eff_close:=v_shift.scheduled_end;
      END IF;
    END IF;

    v_step:=CASE WHEN v_visits>1 THEN
      CASE WHEN v_terms IS NOT NULL
        THEN greatest((v_eff_close-v_eff_open)/v_visits,make_interval(mins=>v_min_gap))
        ELSE (v_eff_close-v_eff_open)/v_visits END
      ELSE interval '0' END;
    FOR v_visit IN 1..v_visits LOOP
      IF v_terms IS NOT NULL AND v_windowed THEN
        v_sla_open:=v_eff_open+v_step*(v_visit-1);
        v_sla_arrive_by:=CASE WHEN v_visits=1 THEN v_eff_close
          ELSE least(v_eff_close,v_sla_open+v_step) END;
        v_sla_depart_by:=NULL;
      ELSIF v_windowed THEN
        v_sla_open:=v_eff_open+v_step*(v_visit-1);
        v_sla_arrive_by:=v_sla_open+make_interval(mins=>coalesce(v_config.sla_arrive_within_minutes,30));
        v_sla_depart_by:=v_sla_arrive_by+make_interval(mins=>coalesce(v_config.sla_depart_within_minutes,45));
      ELSIF v_visits>1 THEN
        v_sla_open:=v_eff_open+v_step*(v_visit-1);
        v_sla_arrive_by:=v_sla_open+v_step;
        v_sla_depart_by:=NULL;
      ELSE
        v_sla_open:=NULL;
        v_sla_arrive_by:=v_shift.scheduled_end;
        v_sla_depart_by:=NULL;
      END IF;
      INSERT INTO public.shift_stops(organization_id,shift_id,patrol_config_id,site_id,zone_id,module_key,
        stop_order,visit_number,is_adhoc,sla_window_open,sla_arrive_by,sla_depart_by,
        required_dwell_minutes,officer_instructions,required_checks,status,sla_status)
      VALUES(v_shift.organization_id,p_shift_id,v_config.id,v_config.site_id,v_config.zone_id,v_config.module_key,
        v_config.preferred_stop_order*10+v_visit,v_visit,false,v_sla_open,v_sla_arrive_by,v_sla_depart_by,
        v_dwell,v_instructions,v_checks,'pending','on_track') RETURNING id INTO v_stop_id;
      INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required,
        service_agreement_module_id,service_agreement_location_id)
        SELECT v_shift.organization_id,v_stop_id,m.module_key,m.is_required,
          coalesce(m.service_agreement_module_id,
            CASE WHEN m.module_key=v_config.module_key THEN v_resp.service_agreement_module_id END),
          coalesce(m.service_agreement_location_id,v_resp.service_agreement_location_id)
        FROM public.patrol_route_stop_modules m WHERE m.patrol_config_id=v_config.id AND m.active
        ON CONFLICT(shift_stop_id,module_key) DO NOTHING;
      GET DIAGNOSTICS v_module_count=ROW_COUNT;
      IF v_module_count=0 THEN
        INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required,
          service_agreement_module_id,service_agreement_location_id)
          VALUES(v_shift.organization_id,v_stop_id,v_config.module_key,true,
            v_resp.service_agreement_module_id,v_resp.service_agreement_location_id)
          ON CONFLICT(shift_stop_id,module_key) DO NOTHING;
      END IF;
      v_stop_count:=v_stop_count+1;
    END LOOP;
  END LOOP;
  UPDATE public.shifts SET total_stops=(SELECT count(*) FROM public.shift_stops WHERE shift_id=p_shift_id),
    generated_at=clock_timestamp() WHERE id=p_shift_id;
  RETURN v_stop_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.generate_shift_stops_internal(uuid,date,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.generate_shift_stops_internal(uuid,date,uuid) TO postgres;