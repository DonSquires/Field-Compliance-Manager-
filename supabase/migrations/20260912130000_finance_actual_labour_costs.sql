CREATE TABLE IF NOT EXISTS public.finance_labour_cost_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  timesheet_id uuid NOT NULL UNIQUE REFERENCES public.timesheets(id) ON DELETE RESTRICT,
  finance_service_cost_id uuid NOT NULL UNIQUE REFERENCES public.finance_service_costs(id) ON DELETE RESTRICT,
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  staff_id uuid NOT NULL REFERENCES public.staff_profiles(id) ON DELETE RESTRICT,
  rate_rule_id uuid REFERENCES public.rate_rules(id) ON DELETE SET NULL,
  hours numeric(8,2) NOT NULL CHECK (hours > 0),
  hourly_rate numeric(14,4) NOT NULL CHECK (hourly_rate >= 0),
  rate_status text NOT NULL CHECK (rate_status IN ('resolved','unresolved')),
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  posted_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  posted_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_labour_cost_postings ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_labour_cost_postings_select ON public.finance_labour_cost_postings FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_labour_cost_postings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_labour_cost_postings TO authenticated;
GRANT ALL ON TABLE public.finance_labour_cost_postings TO service_role;

CREATE OR REPLACE FUNCTION public.post_finance_timesheet_labour_cost(
  p_timesheet_id uuid,
  p_pl_period_id uuid,
  p_service_agreement_id uuid,
  p_service_type text DEFAULT NULL,
  p_cost_centre_id uuid DEFAULT NULL,
  p_work_unit_id uuid DEFAULT NULL
)
RETURNS public.finance_labour_cost_postings
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_sheet public.timesheets%rowtype;
  v_period public.finance_pl_periods%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_posting public.finance_labour_cost_postings%rowtype;
  v_cost public.finance_service_costs%rowtype;
  v_rate record;
  v_hours numeric(8,2);
  v_service_type text;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_sheet FROM public.timesheets WHERE id = p_timesheet_id AND organization_id = v_org;
  IF NOT FOUND OR v_sheet.status NOT IN ('approved','paid') THEN RAISE EXCEPTION 'Only approved or paid timesheets can be posted'; END IF;
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND OR v_period.status IN ('closed','archived') THEN RAISE EXCEPTION 'P&L period is unavailable'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id AND provider_organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found in organization'; END IF;
  SELECT * INTO v_staff FROM public.staff_profiles WHERE id = v_sheet.staff_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff profile not found in organization'; END IF;
  
  SELECT * INTO v_posting FROM public.finance_labour_cost_postings WHERE timesheet_id = p_timesheet_id;
  IF FOUND THEN RETURN v_posting; END IF;
  v_hours := COALESCE(v_sheet.actual_hours, v_sheet.work_derived_hours, 0);
  IF v_hours <= 0 THEN RAISE EXCEPTION 'Timesheet has no positive actual hours'; END IF;
  v_service_type := nullif(trim(p_service_type), '');
  IF v_service_type IS NULL AND v_sheet.shift_id IS NOT NULL THEN SELECT service_type INTO v_service_type FROM public.shifts WHERE id = v_sheet.shift_id; END IF;
  v_service_type := COALESCE(v_service_type, 'shift');

  SELECT r.id AS rate_rule_id, r.amount
  INTO v_rate
  FROM public.rate_rules r
  WHERE r.organization_id = v_org AND r.rule_kind = 'pay' AND r.rate_type = 'hourly' AND r.active
    AND (r.role_code IS NULL OR r.role_code = v_staff.role_code)
    AND (r.service_type IS NULL OR r.service_type = v_service_type)
    AND (r.effective_from IS NULL OR r.effective_from <= v_sheet.period_start)
    AND (r.effective_to IS NULL OR r.effective_to >= v_sheet.period_start)
  ORDER BY (r.role_code IS NOT NULL)::integer DESC, (r.service_type IS NOT NULL)::integer DESC, r.priority DESC, r.effective_from DESC NULLS LAST
  LIMIT 1;

  INSERT INTO public.finance_service_costs(
    organization_id, pl_period_id, service_agreement_id, client_organization_id, cost_type,
    cost_centre_id, work_unit_id, shift_id, source_document_type, source_reference,
    quantity, unit_of_measure, unit_cost, total_cost, created_by
  ) VALUES (
    v_org, p_pl_period_id, p_service_agreement_id, v_agreement.client_organization_id, 'labour',
    p_cost_centre_id, p_work_unit_id, v_sheet.shift_id, 'timesheet', 'timesheet:' || v_sheet.id::text,
    v_hours, 'hours', COALESCE(v_rate.amount, 0), round(v_hours * COALESCE(v_rate.amount, 0), 2), v_actor
  ) RETURNING * INTO v_cost;

  INSERT INTO public.finance_labour_cost_postings(
    organization_id, timesheet_id, finance_service_cost_id, service_agreement_id, pl_period_id,
    staff_id, rate_rule_id, hours, hourly_rate, rate_status, source_snapshot, posted_by
  ) VALUES (
    v_org, v_sheet.id, v_cost.id, p_service_agreement_id, p_pl_period_id, v_sheet.staff_id,
    v_rate.rate_rule_id, v_hours, COALESCE(v_rate.amount, 0), CASE WHEN v_rate.rate_rule_id IS NULL THEN 'unresolved' ELSE 'resolved' END,
    jsonb_build_object('timesheet_status', v_sheet.status, 'period_start', v_sheet.period_start, 'period_end', v_sheet.period_end, 'actual_hours', v_sheet.actual_hours, 'work_derived_hours', v_sheet.work_derived_hours, 'role_code', v_staff.role_code, 'service_type', v_service_type, 'rate_rule_id', v_rate.rate_rule_id, 'hourly_rate', COALESCE(v_rate.amount, 0)), v_actor
  ) RETURNING * INTO v_posting;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_timesheet_labour_cost_posted', 'finance_labour_cost_postings', v_posting.id, jsonb_build_object('timesheet_id', v_sheet.id, 'finance_service_cost_id', v_cost.id, 'hours', v_hours, 'hourly_rate', COALESCE(v_rate.amount, 0), 'rate_status', v_posting.rate_status));
  RETURN v_posting;
END;
$$;

REVOKE ALL ON FUNCTION public.post_finance_timesheet_labour_cost(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_finance_timesheet_labour_cost(uuid,uuid,uuid,text,uuid,uuid) TO authenticated, service_role;
