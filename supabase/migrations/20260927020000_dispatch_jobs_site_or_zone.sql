-- A dispatch job is work at one governed place. Existing jobs are all Site-anchored;
-- this adds the Zone sibling without changing the legacy site-only RPC contract.

ALTER TABLE public.dispatch_jobs
  ADD COLUMN zone_id uuid REFERENCES public.location_zones(id);

ALTER TABLE public.dispatch_jobs
  ADD CONSTRAINT dispatch_jobs_place_xor
  CHECK (num_nonnulls(client_site_id, zone_id) = 1);

CREATE INDEX idx_dispatch_jobs_zone
  ON public.dispatch_jobs(zone_id)
  WHERE zone_id IS NOT NULL;

COMMENT ON COLUMN public.dispatch_jobs.zone_id IS
  'Zone where the job is performed when the agreement place is not an addressed Site. Exactly one of client_site_id or zone_id is required.';

CREATE OR REPLACE FUNCTION public.create_dispatch_job_for_place(
  p_organization_id uuid,
  p_service_agreement_id uuid,
  p_client_site_id uuid,
  p_zone_id uuid,
  p_client_request_id uuid,
  p_job_type text,
  p_priority text,
  p_sla_minutes integer,
  p_dispatch_resource_id uuid DEFAULT NULL,
  p_briefing_notes text DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL
)
RETURNS TABLE(id uuid, created boolean, status text, sla_respond_by timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existing public.dispatch_jobs%rowtype;
  v_created public.dispatch_jobs%rowtype;
  v_resource public.dispatch_resources%rowtype;
  v_shift public.shifts%rowtype;
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Not authorised to create dispatch jobs for this organisation';
  END IF;
  IF p_sla_minutes IS NULL OR p_sla_minutes < 1 OR p_sla_minutes > 1440 THEN
    RAISE EXCEPTION 'SLA minutes must be between 1 and 1440';
  END IF;
  IF num_nonnulls(p_client_site_id, p_zone_id) <> 1 THEN
    RAISE EXCEPTION 'Choose exactly one dispatch place: a Site or Zone';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.service_agreements agreement
    JOIN public.service_agreement_locations link
      ON link.service_agreement_id = agreement.id
    LEFT JOIN public.client_sites site
      ON site.id = link.site_id
    LEFT JOIN public.location_zones zone
      ON zone.id = link.zone_id
    WHERE agreement.id = p_service_agreement_id
      AND agreement.provider_organization_id = p_organization_id
      AND link.status = 'active'
      AND (
        (p_client_site_id IS NOT NULL AND link.site_id = p_client_site_id AND site.active)
        OR (p_zone_id IS NOT NULL AND link.zone_id = p_zone_id AND zone.is_active)
      )
  ) THEN
    RAISE EXCEPTION 'Place is not active under this service agreement';
  END IF;

  SELECT * INTO v_existing
  FROM public.dispatch_jobs job
  WHERE job.organization_id = p_organization_id
    AND job.client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_existing.id, false, v_existing.status, v_existing.sla_respond_by;
    RETURN;
  END IF;

  IF p_dispatch_resource_id IS NOT NULL THEN
    IF p_shift_id IS NULL THEN
      RAISE EXCEPTION 'A shift is required when dispatching to a resource';
    END IF;
    SELECT * INTO v_resource
    FROM public.dispatch_resources resource
    WHERE resource.id = p_dispatch_resource_id
      AND resource.organization_id = p_organization_id
    FOR UPDATE;
    IF NOT FOUND OR v_resource.status <> 'available' OR v_resource.assigned_officer_id IS NULL THEN
      RAISE EXCEPTION 'Dispatch resource is not available with an assigned officer';
    END IF;
    SELECT * INTO v_shift
    FROM public.shifts shift
    WHERE shift.id = p_shift_id
      AND shift.organization_id = p_organization_id
      AND shift.status IN ('accepted', 'in_progress')
    FOR SHARE;
    IF NOT FOUND OR v_shift.officer_user_id <> v_resource.assigned_officer_id THEN
      RAISE EXCEPTION 'Shift officer does not match the selected dispatch resource';
    END IF;
  ELSIF p_shift_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.shifts shift
    WHERE shift.id = p_shift_id
      AND shift.organization_id = p_organization_id
      AND shift.status IN ('accepted', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'Shift is not active in this organisation';
  END IF;

  BEGIN
    INSERT INTO public.dispatch_jobs (
      organization_id, service_agreement_id, client_site_id, zone_id,
      client_request_id, dispatch_resource_id, job_type, priority, status,
      sla_minutes, sla_respond_by, briefing_notes, shift_id, dispatched_at
    ) VALUES (
      p_organization_id, p_service_agreement_id, p_client_site_id, p_zone_id,
      p_client_request_id, p_dispatch_resource_id, p_job_type, p_priority,
      CASE WHEN p_dispatch_resource_id IS NULL THEN 'pending' ELSE 'dispatched' END,
      p_sla_minutes, now() + make_interval(mins => p_sla_minutes),
      nullif(trim(p_briefing_notes), ''), p_shift_id,
      CASE WHEN p_dispatch_resource_id IS NULL THEN NULL ELSE now() END
    ) RETURNING * INTO v_created;

    IF p_dispatch_resource_id IS NOT NULL THEN
      UPDATE public.dispatch_resources SET status = 'busy'
      WHERE dispatch_resources.id = p_dispatch_resource_id;
    END IF;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_created
    FROM public.dispatch_jobs job
    WHERE job.organization_id = p_organization_id
      AND job.client_request_id = p_client_request_id;
    RETURN QUERY SELECT v_created.id, false, v_created.status, v_created.sla_respond_by;
    RETURN;
  END;

  RETURN QUERY SELECT v_created.id, true, v_created.status, v_created.sla_respond_by;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_dispatch_job_for_place(uuid, uuid, uuid, uuid, uuid, text, text, integer, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_dispatch_job_for_place(uuid, uuid, uuid, uuid, uuid, text, text, integer, uuid, text, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_dispatch_job_for_place(uuid, uuid, uuid, uuid, uuid, text, text, integer, uuid, text, uuid) IS
  'Creates one retry-safe dispatch job at exactly one active agreement-linked Site or Zone.';

CREATE OR REPLACE FUNCTION public.create_dispatch_job(
  p_organization_id uuid,
  p_service_agreement_id uuid,
  p_client_site_id uuid,
  p_client_request_id uuid,
  p_job_type text,
  p_priority text,
  p_sla_minutes integer,
  p_dispatch_resource_id uuid DEFAULT NULL,
  p_briefing_notes text DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL
)
RETURNS TABLE(id uuid, created boolean, status text, sla_respond_by timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT *
  FROM public.create_dispatch_job_for_place(
    p_organization_id,
    p_service_agreement_id,
    p_client_site_id,
    NULL,
    p_client_request_id,
    p_job_type,
    p_priority,
    p_sla_minutes,
    p_dispatch_resource_id,
    p_briefing_notes,
    p_shift_id
  );
$function$;

COMMENT ON FUNCTION public.create_dispatch_job(uuid, uuid, uuid, uuid, text, text, integer, uuid, text, uuid) IS
  'Backward-compatible Site-only wrapper around create_dispatch_job_for_place.';

CREATE OR REPLACE FUNCTION public.record_alarm_signal(
  p_dispatch_job_id uuid,
  p_received_at timestamptz,
  p_signal_type text,
  p_intake_channel text,
  p_panel_id text DEFAULT NULL,
  p_zone_number text DEFAULT NULL,
  p_zone_name text DEFAULT NULL,
  p_account_number text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.alarm_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job public.dispatch_jobs%rowtype;
  v_event public.alarm_events%rowtype;
  v_place_name text;
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs job WHERE job.id = p_dispatch_job_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_job.organization_id) THEN
    RAISE EXCEPTION 'Dispatch job not found or access denied';
  END IF;
  IF v_job.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'The alarm cannot be changed on a job that is already %', v_job.status;
  END IF;
  IF p_received_at IS NULL OR p_received_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The alarm received time cannot be in the future';
  END IF;
  IF p_received_at < v_job.created_at - interval '7 days' THEN
    RAISE EXCEPTION 'The alarm received time is more than 7 days before the job was created';
  END IF;
  IF p_signal_type IS NULL OR p_signal_type NOT IN ('burglary', 'panic_duress', 'fire', 'medical', 'tamper', 'power_fail', 'unknown') THEN
    RAISE EXCEPTION 'Unknown alarm signal type';
  END IF;
  IF p_intake_channel IS NULL OR p_intake_channel NOT IN ('phone', 'email', 'sms', 'radio', 'monitoring_portal', 'other') THEN
    RAISE EXCEPTION 'Unknown alarm intake channel';
  END IF;

  IF v_job.client_site_id IS NOT NULL THEN
    SELECT site.name INTO v_place_name FROM public.client_sites site WHERE site.id = v_job.client_site_id;
  ELSE
    SELECT zone.name INTO v_place_name FROM public.location_zones zone WHERE zone.id = v_job.zone_id;
  END IF;

  INSERT INTO public.alarm_events (
    organization_id, site_id, dispatch_job_id, signal_type, intake_channel,
    panel_id, zone_number, zone_name, account_number, location_name, notes,
    received_at, recorded_by
  ) VALUES (
    v_job.organization_id, v_job.client_site_id, v_job.id, p_signal_type,
    p_intake_channel, nullif(trim(p_panel_id), ''), nullif(trim(p_zone_number), ''),
    nullif(trim(p_zone_name), ''), nullif(trim(p_account_number), ''),
    v_place_name, nullif(trim(p_notes), ''), p_received_at, auth.uid()
  )
  ON CONFLICT (dispatch_job_id) WHERE dispatch_job_id IS NOT NULL DO UPDATE
    SET site_id = excluded.site_id,
        signal_type = excluded.signal_type,
        intake_channel = excluded.intake_channel,
        panel_id = excluded.panel_id,
        zone_number = excluded.zone_number,
        zone_name = excluded.zone_name,
        account_number = excluded.account_number,
        location_name = excluded.location_name,
        notes = excluded.notes,
        received_at = excluded.received_at,
        recorded_by = excluded.recorded_by
  RETURNING * INTO v_event;

  IF v_job.job_type = 'alarm_response' AND v_job.sla_minutes IS NOT NULL THEN
    UPDATE public.dispatch_jobs job
    SET sla_respond_by = p_received_at + make_interval(mins => job.sla_minutes),
        sla_breached = CASE
          WHEN job.on_scene_at IS NOT NULL THEN job.on_scene_at > p_received_at + make_interval(mins => job.sla_minutes)
          ELSE false
        END
    WHERE job.id = v_job.id;
    UPDATE public.sla_clocks clock
    SET started_at = p_received_at,
        alarm_event_id = v_event.id,
        updated_at = now(),
        elapsed_minutes = CASE WHEN clock.arrived_at IS NULL THEN NULL ELSE ceil(extract(epoch FROM (clock.arrived_at - p_received_at)) / 60.0)::integer END,
        status = CASE
          WHEN clock.arrived_at IS NULL THEN clock.status
          WHEN clock.target_minutes IS NULL OR ceil(extract(epoch FROM (clock.arrived_at - p_received_at)) / 60.0) <= clock.target_minutes THEN 'met'
          ELSE 'breached'
        END
    WHERE clock.dispatch_job_id = v_job.id AND clock.status <> 'cancelled';
  ELSE
    UPDATE public.sla_clocks clock
    SET alarm_event_id = v_event.id, updated_at = now()
    WHERE clock.dispatch_job_id = v_job.id AND clock.alarm_event_id IS NULL;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_job.organization_id, auth.uid(), 'alarm_signal_recorded', 'alarm_events', v_event.id,
    jsonb_build_object('dispatch_job_id', v_job.id, 'signal_type', p_signal_type, 'intake_channel', p_intake_channel, 'received_at', p_received_at)
  );
  RETURN v_event;
END;
$function$;

COMMENT ON FUNCTION public.record_alarm_signal(uuid, timestamptz, text, text, text, text, text, text, text) IS
  'Records or corrects one alarm signal per dispatch job, retaining the Site or Zone place name and anchoring the response clock at receipt time.';

CREATE OR REPLACE FUNCTION public.resolve_dispatch_job_financials_internal(
  p_actor uuid,
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_day_category text DEFAULT NULL
)
RETURNS TABLE(lines_written integer, total_pay numeric, unresolved_count integer, charge_lines_written integer, total_charge numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job public.dispatch_jobs%rowtype;
  v_site public.client_sites%rowtype;
  v_client_org uuid;
  v_charge record;
  v_charge_written integer := 0;
  v_charge_total numeric := 0;
  v_charge_line numeric;
  v_shift_service text;
  v_officer uuid;
  v_role_code text;
  v_worked_hours numeric;
  v_place_lat double precision;
  v_place_lng double precision;
  v_distance numeric;
  v_distance_reason text;
  v_rule record;
  v_written integer := 0;
  v_unresolved integer := 0;
  v_total numeric := 0;
  v_line_total numeric;
  v_pl_period_id uuid;
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT job.* INTO v_job FROM public.dispatch_jobs job WHERE job.id = p_dispatch_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF v_job.status <> 'completed' OR v_job.completed_at IS NULL THEN
    RAISE EXCEPTION 'Only completed dispatch jobs produce pay lines';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.dispatch_job_pay_lines line
    WHERE line.source_dispatch_id = v_job.id AND line.rate_rule_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1 FROM public.dispatch_job_charge_lines line
    WHERE line.source_dispatch_id = v_job.id AND line.rate_rule_id IS NOT NULL
  ) THEN
    SELECT count(*)::integer, coalesce(sum(line.line_total), 0)
      INTO v_written, v_total
      FROM public.dispatch_job_pay_lines line WHERE line.source_dispatch_id = v_job.id;
    SELECT count(*)::integer, coalesce(sum(line.line_total), 0)
      INTO v_charge_written, v_charge_total
      FROM public.dispatch_job_charge_lines line WHERE line.source_dispatch_id = v_job.id;
    RETURN QUERY SELECT v_written, v_total,
      (SELECT count(*)::integer FROM public.dispatch_job_pay_lines line WHERE line.source_dispatch_id = v_job.id AND line.rate_rule_id IS NULL),
      v_charge_written, v_charge_total;
    RETURN;
  END IF;

  DELETE FROM public.dispatch_job_pay_lines WHERE source_dispatch_id = v_job.id AND rate_rule_id IS NULL;
  DELETE FROM public.dispatch_job_charge_lines WHERE source_dispatch_id = v_job.id AND rate_rule_id IS NULL;

  SELECT shift.officer_user_id, shift.service_type
    INTO v_officer, v_shift_service
    FROM public.shifts shift WHERE shift.id = v_job.shift_id;
  SELECT staff.role_code INTO v_role_code
    FROM public.staff_profiles staff
    WHERE staff.organization_id = v_job.organization_id
      AND (staff.user_id = v_officer OR staff.id = v_officer)
    LIMIT 1;
  v_worked_hours := CASE
    WHEN v_job.on_scene_at IS NOT NULL THEN extract(epoch FROM (v_job.completed_at - v_job.on_scene_at)) / 3600.0
    WHEN v_job.en_route_at IS NOT NULL THEN extract(epoch FROM (v_job.completed_at - v_job.en_route_at)) / 3600.0
    ELSE NULL
  END;

  IF v_job.client_site_id IS NOT NULL THEN
    SELECT site.* INTO v_site FROM public.client_sites site WHERE site.id = v_job.client_site_id;
    v_place_lat := v_site.gps_lat;
    v_place_lng := v_site.gps_lng;
  ELSE
    SELECT st_y(zone.center_point), st_x(zone.center_point)
      INTO v_place_lat, v_place_lng
      FROM public.location_zones zone WHERE zone.id = v_job.zone_id;
  END IF;
  v_distance := public.compute_travel_distance_km(v_job.insert_gps_lat, v_job.insert_gps_lng, v_place_lat, v_place_lng);
  v_distance_reason := CASE
    WHEN v_distance IS NOT NULL THEN CASE WHEN v_job.zone_id IS NULL THEN 'haversine_dispatch_origin_to_site' ELSE 'haversine_dispatch_origin_to_zone' END
    WHEN v_job.insert_gps_lat IS NULL THEN 'no_dispatch_origin_coordinate'
    WHEN v_place_lat IS NULL THEN 'place_has_no_coordinate'
    ELSE 'unavailable'
  END;

  SELECT * INTO v_rule FROM public.resolve_rate_rule(
    v_job.organization_id, 'pay', v_job.completed_at, NULL, v_job.job_type, NULL,
    NULL, v_job.client_site_id, v_job.zone_id, v_role_code, v_distance, p_day_category, 'hourly'
  );
  IF v_rule.rate_rule_id IS NULL AND v_shift_service IS NOT NULL THEN
    SELECT * INTO v_rule FROM public.resolve_rate_rule(
      v_job.organization_id, 'pay', v_job.completed_at, v_shift_service, NULL, NULL,
      NULL, v_job.client_site_id, v_job.zone_id, v_role_code, v_distance, p_day_category, 'hourly'
    );
  END IF;
  IF v_rule.rate_rule_id IS NOT NULL AND v_worked_hours IS NOT NULL THEN
    v_line_total := round(v_worked_hours * v_rule.amount, 2);
    INSERT INTO public.dispatch_job_pay_lines (
      organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
      rate_type, description, quantity, unit_rate, multiplier, line_total,
      distance_km, distance_reason, role_code, region_code, service_type, day_category
    ) VALUES (
      v_job.organization_id, v_job.id, v_officer, v_rule.rate_rule_id, v_rule.pay_code,
      'hourly', 'Attendance labour', round(v_worked_hours, 4), v_rule.amount, 1, v_line_total,
      v_distance, v_distance_reason, v_rule.role_code, v_rule.region_code, v_job.job_type, v_rule.day_category
    );
    v_written := v_written + 1;
    v_total := v_total + v_line_total;
  ELSE
    v_unresolved := v_unresolved + 1;
    INSERT INTO public.dispatch_job_pay_lines (
      organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
      rate_type, description, quantity, unit_rate, multiplier, line_total,
      distance_km, distance_reason, role_code, service_type, day_category
    ) VALUES (
      v_job.organization_id, v_job.id, v_officer, NULL, 'UNRESOLVED', 'hourly',
      CASE WHEN v_worked_hours IS NULL THEN 'Unresolved: no on-scene or en-route timestamp' ELSE 'Unresolved: no active hourly pay rule matched' END,
      coalesce(round(v_worked_hours, 4), 0), 0, 1, 0, v_distance, v_distance_reason,
      v_role_code, v_job.job_type, p_day_category
    );
    v_written := v_written + 1;
  END IF;

  IF v_distance IS NOT NULL THEN
    SELECT * INTO v_rule FROM public.resolve_rate_rule(
      v_job.organization_id, 'pay', v_job.completed_at, NULL, v_job.job_type, NULL,
      NULL, v_job.client_site_id, v_job.zone_id, v_role_code, v_distance, p_day_category, 'per_km'
    );
    IF v_rule.rate_rule_id IS NULL AND v_shift_service IS NOT NULL THEN
      SELECT * INTO v_rule FROM public.resolve_rate_rule(
        v_job.organization_id, 'pay', v_job.completed_at, v_shift_service, NULL, NULL,
        NULL, v_job.client_site_id, v_job.zone_id, v_role_code, v_distance, p_day_category, 'per_km'
      );
    END IF;
    IF v_rule.rate_rule_id IS NOT NULL THEN
      v_line_total := round(v_distance * v_rule.amount, 2);
      INSERT INTO public.dispatch_job_pay_lines (
        organization_id, source_dispatch_id, officer_user_id, rate_rule_id, pay_code,
        rate_type, description, quantity, unit_rate, multiplier, line_total,
        distance_km, distance_reason, role_code, region_code, service_type, day_category
      ) VALUES (
        v_job.organization_id, v_job.id, v_officer, v_rule.rate_rule_id,
        coalesce(v_rule.pay_code, 'TRAVEL'), 'per_km', 'Travel to place',
        v_distance, v_rule.amount, 1, v_line_total, v_distance, v_distance_reason,
        v_rule.role_code, v_rule.region_code, v_job.job_type, v_rule.day_category
      );
      v_written := v_written + 1;
      v_total := v_total + v_line_total;

      BEGIN
        SELECT period.id INTO v_pl_period_id
        FROM public.finance_pl_periods period
        WHERE period.organization_id = v_job.organization_id
          AND v_job.completed_at::date BETWEEN period.period_start AND period.period_end
          AND period.status NOT IN ('closed', 'archived')
        ORDER BY period.period_end DESC LIMIT 1;
        IF v_pl_period_id IS NOT NULL AND v_job.service_agreement_id IS NOT NULL THEN
          INSERT INTO public.finance_service_costs (
            organization_id, pl_period_id, service_agreement_id, client_organization_id,
            cost_type, dispatch_job_id, shift_id, source_document_type,
            source_reference, quantity, unit_cost, total_cost, created_by
          )
          SELECT v_job.organization_id, v_pl_period_id, v_job.service_agreement_id,
            agreement.client_organization_id, 'vehicle', v_job.id, v_job.shift_id,
            'dispatch_job', 'Travel to place (auto, dispatch completion)',
            v_distance, v_rule.amount, v_line_total, v_officer
          FROM public.service_agreements agreement WHERE agreement.id = v_job.service_agreement_id
          ON CONFLICT DO NOTHING;
        END IF;
      EXCEPTION WHEN others THEN NULL;
      END;
    END IF;
  END IF;

  SELECT coalesce(agreement.client_organization_id, v_site.client_organization_id)
    INTO v_client_org
    FROM (SELECT 1) seed
    LEFT JOIN public.service_agreements agreement ON agreement.id = v_job.service_agreement_id;
  SELECT * INTO v_charge FROM public.resolve_rate_rule(
    v_job.organization_id, 'billing', v_job.completed_at, NULL, v_job.job_type,
    v_job.module_key, v_client_org, v_job.client_site_id, v_job.zone_id,
    NULL, v_distance, p_day_category, 'hourly'
  );
  IF v_charge.rate_rule_id IS NULL AND v_shift_service IS NOT NULL THEN
    SELECT * INTO v_charge FROM public.resolve_rate_rule(
      v_job.organization_id, 'billing', v_job.completed_at, v_shift_service, NULL,
      v_job.module_key, v_client_org, v_job.client_site_id, v_job.zone_id,
      NULL, v_distance, p_day_category, 'hourly'
    );
  END IF;
  IF v_charge.rate_rule_id IS NOT NULL AND v_worked_hours IS NOT NULL THEN
    v_charge_line := round(v_worked_hours * v_charge.amount, 2);
    INSERT INTO public.dispatch_job_charge_lines (
      organization_id, source_dispatch_id, client_organization_id, service_agreement_id,
      rate_rule_id, rate_type, description, quantity, unit_rate, line_total,
      distance_km, service_type, day_category
    ) VALUES (
      v_job.organization_id, v_job.id, v_client_org, v_job.service_agreement_id,
      v_charge.rate_rule_id, 'hourly', 'Attendance', round(v_worked_hours, 4),
      v_charge.amount, v_charge_line, v_distance, v_job.job_type, v_charge.day_category
    );
    v_charge_written := v_charge_written + 1;
    v_charge_total := v_charge_total + v_charge_line;
  ELSE
    INSERT INTO public.dispatch_job_charge_lines (
      organization_id, source_dispatch_id, client_organization_id, service_agreement_id,
      rate_rule_id, rate_type, description, quantity, unit_rate, line_total,
      distance_km, service_type, day_category
    ) VALUES (
      v_job.organization_id, v_job.id, v_client_org, v_job.service_agreement_id,
      NULL, 'hourly', CASE WHEN v_worked_hours IS NULL THEN 'Unresolved: no on-scene or en-route timestamp' ELSE 'Unresolved: no active hourly charge rule matched' END,
      coalesce(round(v_worked_hours, 4), 0), 0, 0, v_distance, v_job.job_type, p_day_category
    );
    v_charge_written := v_charge_written + 1;
  END IF;

  IF v_distance IS NOT NULL THEN
    SELECT * INTO v_charge FROM public.resolve_rate_rule(
      v_job.organization_id, 'billing', v_job.completed_at, NULL, v_job.job_type,
      v_job.module_key, v_client_org, v_job.client_site_id, v_job.zone_id,
      NULL, v_distance, p_day_category, 'per_km'
    );
    IF v_charge.rate_rule_id IS NULL AND v_shift_service IS NOT NULL THEN
      SELECT * INTO v_charge FROM public.resolve_rate_rule(
        v_job.organization_id, 'billing', v_job.completed_at, v_shift_service, NULL,
        v_job.module_key, v_client_org, v_job.client_site_id, v_job.zone_id,
        NULL, v_distance, p_day_category, 'per_km'
      );
    END IF;
    IF v_charge.rate_rule_id IS NOT NULL THEN
      v_charge_line := round(v_distance * v_charge.amount, 2);
      INSERT INTO public.dispatch_job_charge_lines (
        organization_id, source_dispatch_id, client_organization_id, service_agreement_id,
        rate_rule_id, rate_type, description, quantity, unit_rate, line_total,
        distance_km, service_type, day_category
      ) VALUES (
        v_job.organization_id, v_job.id, v_client_org, v_job.service_agreement_id,
        v_charge.rate_rule_id, 'per_km', 'Travel to place', v_distance,
        v_charge.amount, v_charge_line, v_distance, v_job.job_type, v_charge.day_category
      );
      v_charge_written := v_charge_written + 1;
      v_charge_total := v_charge_total + v_charge_line;
    END IF;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_job.organization_id, p_actor, 'dispatch_financials_resolved',
    'dispatch_job_pay_lines', v_job.id,
    jsonb_build_object(
      'dispatch_job_id', v_job.id,
      'lines_written', v_written,
      'unresolved_count', v_unresolved,
      'total_pay', v_total,
      'charge_lines_written', v_charge_written,
      'total_charge', v_charge_total,
      'distance_km', v_distance,
      'distance_reason', v_distance_reason,
      'role_code', v_role_code,
      'client_request_id', p_client_request_id
    )
  );
  RETURN QUERY SELECT v_written, v_total, v_unresolved, v_charge_written, v_charge_total;
END;
$function$;

COMMENT ON FUNCTION public.resolve_dispatch_job_financials_internal(uuid, uuid, uuid, text) IS
  'Resolves completed dispatch pay, customer charges, travel distance, and vehicle cost for either a Site or Zone place.';