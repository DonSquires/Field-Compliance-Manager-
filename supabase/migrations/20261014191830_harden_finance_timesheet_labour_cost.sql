CREATE OR REPLACE FUNCTION public.post_finance_timesheet_labour_cost(
  p_timesheet_id uuid,
  p_pl_period_id uuid,
  p_service_agreement_id uuid,
  p_service_type text DEFAULT NULL,
  p_cost_centre_id uuid DEFAULT NULL,
  p_work_unit_id uuid DEFAULT NULL
)
RETURNS public.finance_labour_cost_postings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_sheet public.timesheets%rowtype;
  v_period public.finance_pl_periods%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_shift public.shifts%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_posting public.finance_labour_cost_postings%rowtype;
  v_cost public.finance_service_costs%rowtype;
  v_rate record;
  v_location_agreement_id uuid;
  v_location_status text;
  v_module_agreement_id uuid;
  v_module_enabled boolean;
  v_derived_agreement_id uuid;
  v_hours numeric(8,2);
  v_requested_service_type text;
BEGIN
  SELECT organization_id INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN
    RAISE EXCEPTION 'Active finance administrator required';
  END IF;
  IF p_timesheet_id IS NULL OR p_pl_period_id IS NULL OR p_service_agreement_id IS NULL THEN
    RAISE EXCEPTION 'Timesheet, P&L period, and service agreement are required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('finance-timesheet-cost:' || p_timesheet_id::text, 0));

  SELECT * INTO v_sheet
  FROM public.timesheets
  WHERE id = p_timesheet_id AND organization_id = v_org
  FOR UPDATE;

  IF NOT FOUND OR v_sheet.status NOT IN ('approved', 'paid') THEN
    RAISE EXCEPTION 'Only approved or paid timesheets can be posted';
  END IF;
  IF v_sheet.shift_id IS NULL THEN
    RAISE EXCEPTION 'Timesheet must identify one governed shift before labour cost can be posted';
  END IF;

  SELECT * INTO v_staff
  FROM public.staff_profiles
  WHERE id = v_sheet.staff_id AND organization_id = v_org;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff profile not found in organization';
  END IF;

  SELECT * INTO v_shift
  FROM public.shifts
  WHERE id = v_sheet.shift_id
    AND organization_id = v_org
    AND (officer_user_id = v_staff.id OR officer_user_id = v_staff.user_id);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Timesheet shift is not available for this staff member';
  END IF;

  IF v_shift.service_agreement_location_id IS NOT NULL THEN
    SELECT service_agreement_id, status
    INTO v_location_agreement_id, v_location_status
    FROM public.service_agreement_locations
    WHERE id = v_shift.service_agreement_location_id;

    IF v_location_agreement_id IS NULL OR v_location_status <> 'active' THEN
      RAISE EXCEPTION 'Shift agreement location is not active';
    END IF;
  END IF;

  IF v_shift.service_agreement_module_id IS NOT NULL THEN
    SELECT service_agreement_id, enabled
    INTO v_module_agreement_id, v_module_enabled
    FROM public.service_agreement_modules
    WHERE id = v_shift.service_agreement_module_id;

    IF v_module_agreement_id IS NULL OR NOT v_module_enabled THEN
      RAISE EXCEPTION 'Shift agreement module is not enabled';
    END IF;
  END IF;

  IF v_location_agreement_id IS NOT NULL
    AND v_module_agreement_id IS NOT NULL
    AND v_location_agreement_id <> v_module_agreement_id
  THEN
    RAISE EXCEPTION 'Shift agreement links do not identify the same agreement';
  END IF;

  v_derived_agreement_id := COALESCE(v_location_agreement_id, v_module_agreement_id);
  IF v_derived_agreement_id IS NULL THEN
    RAISE EXCEPTION 'Shift is not linked to a service agreement';
  END IF;
  IF p_service_agreement_id <> v_derived_agreement_id THEN
    RAISE EXCEPTION 'Service agreement does not match the timesheet shift';
  END IF;

  SELECT * INTO v_agreement
  FROM public.service_agreements
  WHERE id = v_derived_agreement_id
    AND provider_organization_id = v_org
    AND agreement_type = 'operational'
    AND invitation_status = 'accepted'
    AND (starts_on IS NULL OR starts_on <= v_sheet.period_start)
    AND (ends_on IS NULL OR ends_on >= v_sheet.period_end);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Timesheet shift agreement is not active for the work period';
  END IF;

  SELECT * INTO v_period
  FROM public.finance_pl_periods
  WHERE id = p_pl_period_id
    AND organization_id = v_org
    AND status IN ('draft', 'locked')
    AND period_start <= v_sheet.period_start
    AND period_end >= v_sheet.period_end;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'P&L period must be open and contain the timesheet work period';
  END IF;

  IF p_work_unit_id IS NOT NULL AND p_work_unit_id IS DISTINCT FROM v_shift.work_unit_id THEN
    RAISE EXCEPTION 'Work unit does not match the timesheet shift';
  END IF;
  IF p_cost_centre_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.cost_centres
    WHERE id = p_cost_centre_id
      AND organization_id = v_org
      AND active
  ) THEN
    RAISE EXCEPTION 'Cost centre is not active in organization';
  END IF;

  v_requested_service_type := NULLIF(trim(COALESCE(p_service_type, '')), '');
  IF v_requested_service_type IS NOT NULL
    AND v_requested_service_type <> v_shift.service_type
  THEN
    RAISE EXCEPTION 'Service type does not match the timesheet shift';
  END IF;

  SELECT * INTO v_posting
  FROM public.finance_labour_cost_postings
  WHERE timesheet_id = p_timesheet_id;

  IF FOUND THEN
    IF v_posting.pl_period_id <> p_pl_period_id
      OR v_posting.service_agreement_id <> v_derived_agreement_id
    THEN
      RAISE EXCEPTION 'Timesheet labour cost was already posted with different accounting attribution';
    END IF;
    RETURN v_posting;
  END IF;

  v_hours := COALESCE(v_sheet.actual_hours, v_sheet.work_derived_hours, 0);
  IF v_hours <= 0 THEN
    RAISE EXCEPTION 'Timesheet has no positive actual hours';
  END IF;

  SELECT r.id AS rate_rule_id, r.amount
  INTO v_rate
  FROM public.rate_rules r
  WHERE r.organization_id = v_org
    AND r.rule_kind = 'pay'
    AND r.rate_type = 'hourly'
    AND r.active
    AND (r.role_code IS NULL OR r.role_code = v_staff.role_code)
    AND (r.service_type IS NULL OR r.service_type = v_shift.service_type)
    AND (r.effective_from IS NULL OR r.effective_from <= v_sheet.period_start)
    AND (r.effective_to IS NULL OR r.effective_to >= v_sheet.period_start)
  ORDER BY
    (r.role_code IS NOT NULL)::integer DESC,
    (r.service_type IS NOT NULL)::integer DESC,
    r.priority DESC,
    r.effective_from DESC NULLS LAST
  LIMIT 1;

  INSERT INTO public.finance_service_costs(
    organization_id, pl_period_id, service_agreement_id, client_organization_id, cost_type,
    cost_centre_id, work_unit_id, shift_id, source_document_type, source_reference,
    quantity, unit_of_measure, unit_cost, total_cost, created_by
  ) VALUES (
    v_org, p_pl_period_id, v_derived_agreement_id, v_agreement.client_organization_id, 'labour',
    p_cost_centre_id, v_shift.work_unit_id, v_sheet.shift_id, 'timesheet', 'timesheet:' || v_sheet.id::text,
    v_hours, 'hours', COALESCE(v_rate.amount, 0), round(v_hours * COALESCE(v_rate.amount, 0), 2), v_actor
  ) RETURNING * INTO v_cost;

  INSERT INTO public.finance_labour_cost_postings(
    organization_id, timesheet_id, finance_service_cost_id, service_agreement_id, pl_period_id,
    staff_id, rate_rule_id, hours, hourly_rate, rate_status, source_snapshot, posted_by
  ) VALUES (
    v_org, v_sheet.id, v_cost.id, v_derived_agreement_id, p_pl_period_id, v_sheet.staff_id,
    v_rate.rate_rule_id, v_hours, COALESCE(v_rate.amount, 0),
    CASE WHEN v_rate.rate_rule_id IS NULL THEN 'unresolved' ELSE 'resolved' END,
    jsonb_build_object(
      'timesheet_status', v_sheet.status,
      'period_start', v_sheet.period_start,
      'period_end', v_sheet.period_end,
      'actual_hours', v_sheet.actual_hours,
      'work_derived_hours', v_sheet.work_derived_hours,
      'role_code', v_staff.role_code,
      'shift_id', v_shift.id,
      'work_unit_id', v_shift.work_unit_id,
      'service_agreement_id', v_derived_agreement_id,
      'service_type', v_shift.service_type,
      'rate_rule_id', v_rate.rate_rule_id,
      'hourly_rate', COALESCE(v_rate.amount, 0)
    ),
    v_actor
  ) RETURNING * INTO v_posting;

  INSERT INTO public.audit_log(
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_org, v_actor, 'finance_timesheet_labour_cost_posted',
    'finance_labour_cost_postings', v_posting.id,
    jsonb_build_object(
      'timesheet_id', v_sheet.id,
      'shift_id', v_shift.id,
      'service_agreement_id', v_derived_agreement_id,
      'pl_period_id', p_pl_period_id,
      'finance_service_cost_id', v_cost.id,
      'hours', v_hours,
      'hourly_rate', COALESCE(v_rate.amount, 0),
      'rate_status', v_posting.rate_status
    )
  );

  RETURN v_posting;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_finance_timesheet_labour_cost(uuid, uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.post_finance_timesheet_labour_cost(uuid, uuid, uuid, text, uuid, uuid)
  TO authenticated, service_role;