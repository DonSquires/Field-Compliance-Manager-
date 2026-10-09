ALTER TABLE public.sla_discount_bands
  ADD COLUMN IF NOT EXISTS module_key text,
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by uuid;

ALTER TABLE public.sla_discount_bands
  ADD CONSTRAINT sla_discount_bands_module_key_check
  CHECK (module_key IS NULL OR module_key = 'patrol');

CREATE TABLE public.patrol_stop_charge_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shift_stop_id uuid NOT NULL UNIQUE REFERENCES public.shift_stops(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE SET NULL,
  client_organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  rate_rule_id uuid REFERENCES public.rate_rules(id) ON DELETE SET NULL,
  module_key text NOT NULL,
  service_type text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready', 'unresolved_rate', 'unresolved_agreement', 'waived_sla', 'invoiced')),
  description text NOT NULL,
  quantity numeric(10, 2) NOT NULL DEFAULT 1 CHECK (quantity = 1),
  unit_rate numeric(12, 4),
  base_amount numeric(12, 2),
  discount_pct numeric(5, 4) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 1),
  discount_amount numeric(12, 2) NOT NULL DEFAULT 0,
  line_total numeric(12, 2),
  sla_over_by_minutes integer NOT NULL DEFAULT 0 CHECK (sla_over_by_minutes >= 0),
  invoice_line_item_id uuid REFERENCES public.invoice_line_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status IN ('ready', 'invoiced', 'waived_sla') AND rate_rule_id IS NOT NULL AND base_amount IS NOT NULL AND line_total IS NOT NULL)
      OR (status IN ('unresolved_rate', 'unresolved_agreement') AND rate_rule_id IS NULL AND line_total IS NULL)),
  CHECK ((status = 'invoiced') = (invoice_line_item_id IS NOT NULL))
);

CREATE INDEX patrol_stop_charge_lines_org_client_created_idx
  ON public.patrol_stop_charge_lines(organization_id, client_organization_id, created_at DESC);

ALTER TABLE public.patrol_stop_charge_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY patrol_stop_charge_lines_finance_read
  ON public.patrol_stop_charge_lines FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id) AND public.is_admin_for_org(organization_id));
REVOKE ALL ON public.patrol_stop_charge_lines FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.patrol_stop_charge_lines TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.patrol_stop_charge_lines TO service_role;

CREATE OR REPLACE FUNCTION public.manage_patrol_sla_discount_band(
  p_organization_id uuid,
  p_action text,
  p_band_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_service_type text DEFAULT NULL,
  p_over_by_minutes_min integer DEFAULT NULL,
  p_over_by_minutes_max integer DEFAULT NULL,
  p_discount_pct numeric DEFAULT NULL
) RETURNS public.sla_discount_bands
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_band public.sla_discount_bands%ROWTYPE;
  v_service_type text := nullif(trim(coalesce(p_service_type, '')), '');
BEGIN
  IF v_actor IS NULL OR NOT public.user_can_operate_organization(p_organization_id)
     OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Active authorized finance administrator required';
  END IF;

  IF p_action IN ('create', 'update') THEN
    IF p_over_by_minutes_min IS NULL OR p_over_by_minutes_min < 0
       OR (p_over_by_minutes_max IS NOT NULL AND p_over_by_minutes_max < p_over_by_minutes_min)
       OR p_discount_pct IS NULL OR p_discount_pct < 0 OR p_discount_pct > 1 THEN
      RAISE EXCEPTION 'Enter a valid late-minute range and a discount from 0 to 100 percent';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':patrol_sla_discount_bands', 0));
    IF EXISTS (
      SELECT 1 FROM public.sla_discount_bands existing
      WHERE existing.organization_id = p_organization_id
        AND existing.module_key = 'patrol' AND existing.active
        AND existing.service_type IS NOT DISTINCT FROM v_service_type
        AND existing.id IS DISTINCT FROM p_band_id
        AND coalesce(existing.over_by_minutes_max, 2147483647) >= p_over_by_minutes_min
        AND coalesce(p_over_by_minutes_max, 2147483647) >= existing.over_by_minutes_min
    ) THEN
      RAISE EXCEPTION 'This late-minute range overlaps an active patrol discount band';
    END IF;
  END IF;

  IF p_action = 'create' THEN
    INSERT INTO public.sla_discount_bands (
      organization_id, service_type, module_key, over_by_minutes_min, over_by_minutes_max,
      discount_pct, active, created_at, updated_at, updated_by
    ) VALUES (
      p_organization_id, v_service_type, 'patrol', p_over_by_minutes_min, p_over_by_minutes_max,
      p_discount_pct, true, now(), now(), v_actor
    ) RETURNING * INTO v_band;
  ELSE
    SELECT * INTO v_band FROM public.sla_discount_bands
    WHERE id = p_band_id AND organization_id = p_organization_id AND module_key = 'patrol'
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Patrol discount band not found'; END IF;
    IF p_expected_updated_at IS NOT NULL AND v_band.updated_at <> p_expected_updated_at THEN
      RAISE EXCEPTION 'Patrol discount band changed since it was opened';
    END IF;
    IF p_action = 'update' THEN
      UPDATE public.sla_discount_bands SET service_type = v_service_type,
        over_by_minutes_min = p_over_by_minutes_min, over_by_minutes_max = p_over_by_minutes_max,
        discount_pct = p_discount_pct, updated_at = now(), updated_by = v_actor
      WHERE id = v_band.id RETURNING * INTO v_band;
    ELSIF p_action = 'deactivate' THEN
      UPDATE public.sla_discount_bands SET active = false, updated_at = now(), updated_by = v_actor
      WHERE id = v_band.id AND active RETURNING * INTO v_band;
      IF NOT FOUND THEN RAISE EXCEPTION 'Patrol discount band is already inactive'; END IF;
    ELSIF p_action = 'reactivate' THEN
      UPDATE public.sla_discount_bands SET active = true, updated_at = now(), updated_by = v_actor
      WHERE id = v_band.id AND NOT active RETURNING * INTO v_band;
      IF NOT FOUND THEN RAISE EXCEPTION 'Patrol discount band is already active'; END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported patrol discount band action';
    END IF;
  END IF;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'patrol_sla_discount_band_managed', 'sla_discount_bands', v_band.id,
    jsonb_build_object('action', p_action, 'service_type', v_band.service_type,
      'over_by_minutes_min', v_band.over_by_minutes_min, 'over_by_minutes_max', v_band.over_by_minutes_max,
      'discount_pct', v_band.discount_pct));
  RETURN v_band;
END;
$$;

REVOKE ALL ON FUNCTION public.manage_patrol_sla_discount_band(uuid, text, uuid, timestamptz, text, integer, integer, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_patrol_sla_discount_band(uuid, text, uuid, timestamptz, text, integer, integer, numeric) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_patrol_stop_charge_line_internal(p_stop_id uuid)
RETURNS public.patrol_stop_charge_lines
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_stop public.shift_stops%ROWTYPE;
  v_shift public.shifts%ROWTYPE;
  v_existing public.patrol_stop_charge_lines%ROWTYPE;
  v_line public.patrol_stop_charge_lines%ROWTYPE;
  v_agreement_id uuid;
  v_client_id uuid;
  v_rate_id uuid;
  v_rate numeric;
  v_rule_type text;
  v_over_by integer := 0;
  v_discount numeric := 0;
  v_base numeric;
  v_total numeric;
  v_status text;
  v_description text;
BEGIN
  SELECT * INTO v_stop FROM public.shift_stops WHERE id = p_stop_id;
  IF NOT FOUND OR v_stop.status <> 'completed' OR v_stop.is_adhoc OR v_stop.dispatch_job_id IS NOT NULL THEN
    RAISE EXCEPTION 'A completed contracted patrol stop is required';
  END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = v_stop.shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patrol shift not found'; END IF;
  SELECT * INTO v_existing FROM public.patrol_stop_charge_lines WHERE shift_stop_id = p_stop_id FOR UPDATE;
  IF FOUND AND v_existing.invoice_line_item_id IS NOT NULL THEN RETURN v_existing; END IF;

  SELECT location.service_agreement_id, agreement.client_organization_id
    INTO v_agreement_id, v_client_id
  FROM public.service_agreement_locations location
  JOIN public.service_agreements agreement ON agreement.id = location.service_agreement_id
  WHERE location.id = v_shift.service_agreement_location_id
    AND location.status = 'active';

  IF v_agreement_id IS NULL THEN
    v_status := 'unresolved_agreement';
    v_description := 'Unresolved: patrol shift has no active client service agreement';
  ELSE
    SELECT rate_rule_id, amount, rate_type INTO v_rate_id, v_rate, v_rule_type
    FROM public.resolve_rate_rule(
      v_stop.organization_id, 'billing', coalesce(v_stop.actual_departed_at, now()),
      v_shift.service_type, NULL, v_stop.module_key, v_client_id, v_stop.site_id, v_stop.zone_id,
      NULL, NULL, NULL, 'per_visit'
    );
    IF v_rate_id IS NULL THEN
      v_status := 'unresolved_rate';
      v_description := 'Unresolved: no active customer per-visit rate matched this completed patrol stop';
    ELSE
      v_base := round(v_rate, 2);
      IF v_stop.actual_arrived_at > v_stop.sla_arrive_by THEN
        v_over_by := ceil(extract(epoch FROM (v_stop.actual_arrived_at - v_stop.sla_arrive_by)) / 60)::integer;
        SELECT band.discount_pct INTO v_discount
        FROM public.sla_discount_bands band
        WHERE band.organization_id = v_stop.organization_id AND band.module_key = 'patrol'
          AND band.active AND (band.service_type IS NULL OR band.service_type = v_shift.service_type)
          AND v_over_by >= band.over_by_minutes_min
          AND (band.over_by_minutes_max IS NULL OR v_over_by <= band.over_by_minutes_max)
        ORDER BY (band.service_type IS NOT NULL) DESC, band.over_by_minutes_min DESC
        LIMIT 1;
      END IF;
      v_discount := coalesce(v_discount, 0);
      v_total := round(v_base * (1 - v_discount), 2);
      v_status := CASE WHEN v_discount = 1 THEN 'waived_sla' ELSE 'ready' END;
      v_description := CASE WHEN v_discount > 0
        THEN format('Patrol visit · %s%% SLA discount', round(v_discount * 100, 2))
        ELSE 'Completed contracted patrol visit' END;
    END IF;
  END IF;

  INSERT INTO public.patrol_stop_charge_lines (
    organization_id, shift_stop_id, shift_id, service_agreement_id, client_organization_id,
    rate_rule_id, module_key, service_type, status, description, quantity, unit_rate,
    base_amount, discount_pct, discount_amount, line_total, sla_over_by_minutes,
    created_at, updated_at
  ) VALUES (
    v_stop.organization_id, v_stop.id, v_shift.id, v_agreement_id, v_client_id,
    v_rate_id, v_stop.module_key, v_shift.service_type, v_status, v_description, 1,
    v_rate, v_base, v_discount, CASE WHEN v_base IS NULL THEN 0 ELSE round(v_base * v_discount, 2) END,
    v_total, v_over_by, now(), now()
  )
  ON CONFLICT (shift_stop_id) DO UPDATE SET
    service_agreement_id = EXCLUDED.service_agreement_id,
    client_organization_id = EXCLUDED.client_organization_id,
    rate_rule_id = EXCLUDED.rate_rule_id,
    service_type = EXCLUDED.service_type,
    status = EXCLUDED.status,
    description = EXCLUDED.description,
    unit_rate = EXCLUDED.unit_rate,
    base_amount = EXCLUDED.base_amount,
    discount_pct = EXCLUDED.discount_pct,
    discount_amount = EXCLUDED.discount_amount,
    line_total = EXCLUDED.line_total,
    sla_over_by_minutes = EXCLUDED.sla_over_by_minutes,
    updated_at = now()
  WHERE public.patrol_stop_charge_lines.invoice_line_item_id IS NULL
  RETURNING * INTO v_line;
  IF NOT FOUND THEN
    SELECT * INTO v_line FROM public.patrol_stop_charge_lines WHERE shift_stop_id = p_stop_id;
  END IF;
  RETURN v_line;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_patrol_stop_charge_line_internal(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_patrol_stop_charge_line_internal(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.resolve_patrol_stop_charge_line(p_charge_line_id uuid, p_client_request_id uuid)
RETURNS public.patrol_stop_charge_lines
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_line public.patrol_stop_charge_lines%ROWTYPE;
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_line FROM public.patrol_stop_charge_lines WHERE id = p_charge_line_id;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_line.organization_id) THEN
    RAISE EXCEPTION 'Finance administrator access required';
  END IF;
  v_line := public.resolve_patrol_stop_charge_line_internal(v_line.shift_stop_id);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_line.organization_id, auth.uid(), 'patrol_stop_charge_rechecked', 'patrol_stop_charge_lines', v_line.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'status', v_line.status, 'line_total', v_line.line_total));
  RETURN v_line;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_patrol_stop_charge_line(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_patrol_stop_charge_line(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.manage_officer_patrol_stop(
  p_stop_id uuid, p_expected_status text, p_action text, p_request_id uuid,
  p_notes text DEFAULT NULL, p_gps_lat double precision DEFAULT NULL, p_gps_lng double precision DEFAULT NULL,
  p_gps_accuracy_metres double precision DEFAULT NULL, p_sla_delay_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_stop public.shift_stops%ROWTYPE;
  v_shift public.shifts%ROWTYPE;
  v_site public.client_sites%ROWTYPE;
  v_receipt jsonb;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_delay text := nullif(trim(coalesce(p_sla_delay_reason, '')), '');
  v_at timestamptz := now();
  v_action_id uuid := gen_random_uuid();
  v_verification text;
  v_distance numeric;
  v_point geometry;
  v_onsite_m numeric;
  v_approach_m numeric;
  v_dwell_minutes integer;
  v_dwell_short boolean := false;
  v_next public.shift_stops%ROWTYPE;
  v_charge public.patrol_stop_charge_lines%ROWTYPE;
  v_billing_failed boolean := false;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request id is required'; END IF;
  IF p_action NOT IN ('arrive', 'depart') THEN RAISE EXCEPTION 'Unsupported patrol stop action'; END IF;
  SELECT * INTO v_stop FROM public.shift_stops WHERE id = p_stop_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patrol stop not found'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = v_stop.shift_id;
  IF NOT FOUND OR v_shift.officer_user_id <> v_actor THEN RAISE EXCEPTION 'This stop is not on your shift'; END IF;
  IF v_shift.status <> 'in_progress' THEN RAISE EXCEPTION 'Start your shift before recording attendance at a stop'; END IF;
  IF v_stop.is_adhoc OR v_stop.dispatch_job_id IS NOT NULL THEN RAISE EXCEPTION 'Dispatch stops are recorded from the Dispatch page'; END IF;
  IF v_stop.module_key = 'static_guarding' THEN RAISE EXCEPTION 'Static posts are recorded from the Static guarding page'; END IF;

  SELECT a.receipt INTO v_receipt FROM public.shift_stop_actions a
  WHERE a.organization_id = v_shift.organization_id AND a.client_request_id = p_request_id;
  IF FOUND THEN RETURN v_receipt; END IF;
  IF v_stop.status <> p_expected_status THEN
    RAISE EXCEPTION 'This stop changed from % to % on another device. Refresh and try again', p_expected_status, v_stop.status;
  END IF;

  IF p_action = 'arrive' THEN
    IF v_stop.status NOT IN ('pending', 'en_route') THEN RAISE EXCEPTION 'Arrival cannot be recorded from status %', v_stop.status; END IF;
    IF p_gps_lat IS NULL OR p_gps_lng IS NULL THEN
      v_verification := 'no_gps';
    ELSE
      IF p_gps_lat NOT BETWEEN -90 AND 90 OR p_gps_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'GPS position is out of range'; END IF;
      v_point := st_setsrid(st_makepoint(p_gps_lng, p_gps_lat), 4326);
      IF v_stop.site_id IS NOT NULL THEN SELECT * INTO v_site FROM public.client_sites cs WHERE cs.id = v_stop.site_id; END IF;
      IF v_site.id IS NULL OR (v_site.boundary IS NULL AND v_site.center_point IS NULL) THEN
        v_verification := 'no_geofence';
      ELSE
        v_distance := round((CASE WHEN v_site.boundary IS NOT NULL THEN st_distance(v_site.boundary::geography, v_point::geography) ELSE st_distance(v_site.center_point::geography, v_point::geography) END)::numeric, 1);
        v_onsite_m := coalesce(v_site.onsite_radius_meters, 10);
        SELECT c.config_value::numeric INTO v_approach_m FROM public.org_geofence_config c WHERE c.organization_id = v_shift.organization_id AND c.config_key = 'approach_radius_m' AND c.zone_type IS NULL LIMIT 1;
        v_approach_m := coalesce(v_approach_m, v_site.prompt_radius_meters, 50);
        IF v_site.boundary_verification IS DISTINCT FROM 'verified' THEN v_verification := 'unverified_boundary';
        ELSIF v_distance <= v_onsite_m THEN v_verification := 'verified_on_site';
        ELSIF v_distance <= v_approach_m THEN v_verification := 'near_site';
        ELSE v_verification := 'off_site'; END IF;
      END IF;
    END IF;
    UPDATE public.shift_stops SET status = 'on_scene', actual_arrived_at = v_at,
      arrived_gps_lat = p_gps_lat, arrived_gps_lng = p_gps_lng, arrived_gps_accuracy = p_gps_accuracy_metres,
      arrival_verification = v_verification, arrival_distance_m = v_distance,
      sla_status = CASE WHEN v_at > sla_arrive_by THEN 'breached' ELSE 'on_track' END, updated_at = v_at
    WHERE id = v_stop.id RETURNING * INTO v_stop;
  ELSE
    IF v_stop.status <> 'on_scene' THEN RAISE EXCEPTION 'Record your arrival before leaving this stop'; END IF;
    v_dwell_minutes := greatest(0, floor(extract(epoch FROM (v_at - v_stop.actual_arrived_at)) / 60))::integer;
    v_dwell_short := v_dwell_minutes < v_stop.required_dwell_minutes;
    IF v_stop.sla_status = 'breached' AND v_delay IS NULL THEN RAISE EXCEPTION 'You arrived after the contracted window. Give a short reason for the delay before leaving'; END IF;
    IF v_dwell_short AND v_notes IS NULL THEN RAISE EXCEPTION 'You are leaving before the contracted % minutes on site. Say why in the notes', v_stop.required_dwell_minutes; END IF;
    UPDATE public.shift_stops SET status = 'completed', actual_departed_at = v_at,
      departed_gps_lat = p_gps_lat, departed_gps_lng = p_gps_lng,
      officer_notes = coalesce(v_notes, officer_notes),
      sla_status = CASE WHEN sla_status = 'breached' THEN 'breached' ELSE 'completed' END, updated_at = v_at
    WHERE id = v_stop.id RETURNING * INTO v_stop;
    UPDATE public.shifts SET completed_stops = completed_stops + 1 WHERE id = v_shift.id;
    BEGIN
      v_charge := public.resolve_patrol_stop_charge_line_internal(v_stop.id);
    EXCEPTION WHEN OTHERS THEN
      v_billing_failed := true;
      INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
      VALUES (v_shift.organization_id, v_actor, 'patrol_stop_financials_auto_resolution_failed', 'shift_stops', v_stop.id,
        jsonb_build_object('error', sqlerrm));
    END;
  END IF;

  SELECT * INTO v_next FROM public.shift_stops n
  WHERE n.shift_id = v_shift.id AND n.is_adhoc = false AND n.status IN ('pending', 'en_route')
  ORDER BY n.stop_order, n.visit_number LIMIT 1;
  v_receipt := jsonb_build_object(
    'reference', 'PS-' || upper(left(replace(v_action_id::text, '-', ''), 8)),
    'action', p_action, 'occurred_at', v_at, 'shift_id', v_shift.id, 'stop_id', v_stop.id, 'stop_status', v_stop.status,
    'sla_status', v_stop.sla_status, 'arrival_verification', v_stop.arrival_verification, 'arrival_distance_m', v_stop.arrival_distance_m,
    'dwell_minutes', v_dwell_minutes, 'dwell_short', v_dwell_short, 'delay_reason', v_delay, 'next_stop_id', v_next.id,
    'billing_review_required', v_billing_failed OR coalesce(v_charge.status IN ('unresolved_rate', 'unresolved_agreement'), false),
    'completed_stops', (SELECT completed_stops FROM public.shifts WHERE id = v_shift.id),
    'total_stops', (SELECT total_stops FROM public.shifts WHERE id = v_shift.id));
  INSERT INTO public.shift_stop_actions(id, organization_id, shift_stop_id, shift_id, action_type, outcome, notes, gps_lat, gps_lng, performed_at, client_request_id, gps_accuracy_metres, evidence_metadata, receipt)
  VALUES (v_action_id, v_shift.organization_id, v_stop.id, v_shift.id,
    CASE WHEN p_action = 'arrive' THEN 'patrol_stop_arrived' ELSE 'patrol_stop_departed' END,
    v_stop.status, coalesce(v_notes, v_delay), p_gps_lat, p_gps_lng, v_at, p_request_id, p_gps_accuracy_metres,
    jsonb_build_object('capture_method', 'browser_geolocation', 'geofence_result', v_stop.arrival_verification, 'distance_m', v_stop.arrival_distance_m, 'delay_reason', v_delay, 'dwell_short', v_dwell_short), v_receipt);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_shift.organization_id, v_actor, CASE WHEN p_action = 'arrive' THEN 'patrol_stop_arrived' ELSE 'patrol_stop_departed' END, 'shift_stops', v_stop.id, v_receipt);
  RETURN v_receipt;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_crm_invoice_from_completed_work(
  p_client_request_id uuid, p_organization_id uuid, p_client_organization_id uuid,
  p_service_agreement_id uuid DEFAULT NULL, p_period_start date DEFAULT NULL, p_period_end date DEFAULT NULL
) RETURNS public.invoices
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
  v_count integer := 0;
  v_unpriced integer := 0;
  v_row record;
  v_line_id uuid;
  v_start date := coalesce(p_period_start, date '1970-01-01');
  v_end date := coalesce(p_period_end, current_date);
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_organization_id IS NULL OR p_client_organization_id IS NULL THEN RAISE EXCEPTION 'Organisation and client are required'; END IF;
  IF NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Finance administrator access required'; END IF;
  IF v_end < v_start THEN RAISE EXCEPTION 'Period end cannot precede period start'; END IF;
  SELECT i.* INTO v_invoice FROM public.audit_log a JOIN public.invoices i ON i.id = a.target_id
   WHERE a.organization_id = p_organization_id AND a.action = 'crm_invoice_generated_from_completed_work'
     AND a.metadata->>'client_request_id' = p_client_request_id::text LIMIT 1;
  IF FOUND THEN RETURN v_invoice; END IF;

  SELECT count(*)::integer INTO v_unpriced FROM public.patrol_stop_charge_lines line
  WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
    AND line.status IN ('unresolved_rate', 'unresolved_agreement')
    AND line.created_at::date BETWEEN v_start AND v_end
    AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id);
  IF v_unpriced > 0 THEN RAISE EXCEPTION '% completed patrol visit(s) need a per-visit rate before this invoice can be created', v_unpriced; END IF;

  INSERT INTO public.invoices (organization_id, client_organization_id, service_agreement_id, invoice_number, invoice_date, due_date, status, service_period_start, service_period_end, created_by)
  VALUES (p_organization_id, p_client_organization_id, p_service_agreement_id,
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(gen_random_uuid()::text, 1, 4)),
    current_date, (current_date + interval '14 days')::date, 'draft', p_period_start, p_period_end, v_actor)
  RETURNING * INTO v_invoice;

  FOR v_row IN
    SELECT line.id AS line_id, wo.order_number, wo.title, line.description, line.quantity, line.unit_price, line.unit_cost, line.line_kind, line.item_id, line.unit_of_measure
    FROM public.workshop_work_order_lines line JOIN public.workshop_work_orders wo ON wo.id = line.work_order_id
    WHERE wo.organization_id = p_organization_id AND wo.client_organization_id = p_client_organization_id AND wo.status = 'completed'
      AND line.invoice_line_item_id IS NULL AND wo.completed_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR wo.service_agreement_id IS NULL OR wo.service_agreement_id = p_service_agreement_id)
    ORDER BY wo.completed_at, line.position
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, finance_item_catalog_id, item_type, unit_of_measure, internal_cost_amount, created_by)
    VALUES (v_invoice.id, v_count, v_row.order_number || ' · ' || v_row.title || ' — ' || v_row.description, v_row.quantity, v_row.unit_price, round(v_row.quantity * v_row.unit_price, 2),
      p_organization_id, v_row.item_id, v_row.line_kind, v_row.unit_of_measure, round(v_row.quantity * v_row.unit_cost, 2), v_actor)
    RETURNING id INTO v_line_id;
    UPDATE public.workshop_work_order_lines SET invoice_line_item_id = v_line_id WHERE id = v_row.line_id;
  END LOOP;

  FOR v_row IN
    SELECT line.id AS charge_id, line.source_dispatch_id, line.description, line.quantity, line.unit_rate, line.line_total, line.rate_type, line.created_at
    FROM public.dispatch_job_charge_lines line
    WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
      AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id)
    ORDER BY line.created_at
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, item_type, source_dispatch_id, created_by)
    VALUES (v_invoice.id, v_count, coalesce(v_row.description, 'Dispatch ' || v_row.rate_type), coalesce(v_row.quantity, 1), coalesce(v_row.unit_rate, v_row.line_total), v_row.line_total, p_organization_id, 'other', v_row.source_dispatch_id, v_actor)
    RETURNING id INTO v_line_id;
    UPDATE public.dispatch_job_charge_lines SET invoice_line_item_id = v_line_id WHERE id = v_row.charge_id;
  END LOOP;

  FOR v_row IN
    SELECT line.id AS charge_id, line.shift_id, line.description, line.quantity, line.unit_rate, line.line_total, line.created_at
    FROM public.patrol_stop_charge_lines line
    WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
      AND line.status = 'ready' AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id)
    ORDER BY line.created_at
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, item_type, shift_id, created_by)
    VALUES (v_invoice.id, v_count, v_row.description, v_row.quantity, v_row.line_total, v_row.line_total, p_organization_id, 'other', v_row.shift_id, v_actor)
    RETURNING id INTO v_line_id;
    UPDATE public.patrol_stop_charge_lines SET invoice_line_item_id = v_line_id, status = 'invoiced', updated_at = now() WHERE id = v_row.charge_id;
  END LOOP;

  IF v_count = 0 THEN
    DELETE FROM public.invoices WHERE id = v_invoice.id;
    RAISE EXCEPTION 'No completed, uninvoiced work for this client in the period';
  END IF;
  UPDATE public.invoices invoice SET subtotal = totals.subtotal, gst_amount = round(totals.subtotal * 0.15, 2), total_amount = round(totals.subtotal * 1.15, 2), updated_at = now()
  FROM (SELECT coalesce(sum(line_total), 0) AS subtotal FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) totals
  WHERE invoice.id = v_invoice.id RETURNING invoice.* INTO v_invoice;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'crm_invoice_generated_from_completed_work', 'invoices', v_invoice.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'client_organization_id', p_client_organization_id,
      'lines', v_count, 'total_amount', v_invoice.total_amount, 'period_start', p_period_start, 'period_end', p_period_end));
  RETURN v_invoice;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) TO authenticated;
