CREATE TABLE IF NOT EXISTS public.finance_payday_filing_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  payroll_export_batch_id uuid NOT NULL UNIQUE REFERENCES public.payroll_export_batches(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','exported','submitted','accepted','rejected')),
  provider_format text NOT NULL DEFAULT 'ird_payday_handoff',
  period_from date NOT NULL,
  period_to date NOT NULL,
  timesheet_count integer NOT NULL DEFAULT 0,
  total_hours numeric(10,2) NOT NULL DEFAULT 0,
  resolved_rate_count integer NOT NULL DEFAULT 0,
  unresolved_rate_count integer NOT NULL DEFAULT 0,
  package_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_provisional_tax_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pl_period_id uuid REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  source_key text NOT NULL DEFAULT 'ird-provisional-tax' REFERENCES public.bob_nz_finance_sources(source_key) ON DELETE RESTRICT,
  tax_year integer NOT NULL CHECK (tax_year BETWEEN 2000 AND 2200),
  method text NOT NULL CHECK (method IN ('scenario_only','standard_estimate','accountant_provided')),
  estimated_taxable_profit numeric(14,2) NOT NULL CHECK (estimated_taxable_profit >= 0),
  tax_rate_pct numeric(5,2) NOT NULL CHECK (tax_rate_pct >= 0 AND tax_rate_pct <= 100),
  estimated_income_tax numeric(14,2) NOT NULL CHECK (estimated_income_tax >= 0),
  estimated_provisional_amount numeric(14,2) NOT NULL CHECK (estimated_provisional_amount >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','awaiting_accountant','approved','superseded')),
  assumptions jsonb NOT NULL DEFAULT '{}'::jsonb,
  accountant_notes text,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_payday_filing_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_provisional_tax_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY finance_payday_filing_packages_select ON public.finance_payday_filing_packages FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_provisional_tax_plans_select ON public.finance_provisional_tax_plans FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.finance_payday_filing_packages, public.finance_provisional_tax_plans FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_payday_filing_packages, public.finance_provisional_tax_plans TO authenticated;
GRANT ALL ON TABLE public.finance_payday_filing_packages, public.finance_provisional_tax_plans TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_nz_payday_filing_package(p_payroll_export_batch_id uuid)
RETURNS public.finance_payday_filing_packages
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid(); v_org uuid; v_batch public.payroll_export_batches%rowtype; v_package public.finance_payday_filing_packages%rowtype; v_unresolved integer; v_resolved integer;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active payroll administrator required'; END IF;
  SELECT * INTO v_batch FROM public.payroll_export_batches WHERE id = p_payroll_export_batch_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll export batch not found in organization'; END IF;
  SELECT count(*) FILTER (WHERE rate_status = 'unresolved')::integer, count(*) FILTER (WHERE rate_status = 'resolved')::integer INTO v_unresolved, v_resolved FROM public.finance_labour_cost_postings WHERE organization_id = v_org AND timesheet_id IN (SELECT id FROM public.timesheets WHERE payroll_export_batch_id = p_payroll_export_batch_id);
  INSERT INTO public.finance_payday_filing_packages(organization_id, payroll_export_batch_id, period_from, period_to, timesheet_count, total_hours, resolved_rate_count, unresolved_rate_count, package_summary, created_by)
  VALUES (v_org, v_batch.id, v_batch.period_from, v_batch.period_to, v_batch.timesheet_count, v_batch.total_hours, v_resolved, v_unresolved, jsonb_build_object('handoff_only', true, 'submission_supported', false, 'payday_filing_source', 'approved timesheets', 'unresolved_rate_count', v_unresolved, 'provider_action', 'Import into an approved NZ payroll provider and review before IRD submission'), v_actor)
  ON CONFLICT (payroll_export_batch_id) DO UPDATE SET total_hours = EXCLUDED.total_hours, resolved_rate_count = EXCLUDED.resolved_rate_count, unresolved_rate_count = EXCLUDED.unresolved_rate_count, package_summary = EXCLUDED.package_summary
  RETURNING * INTO v_package;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_org, v_actor, 'nz_payday_filing_package_prepared', 'finance_payday_filing_packages', v_package.id, jsonb_build_object('payroll_export_batch_id', v_batch.id, 'handoff_only', true, 'submission_supported', false));
  RETURN v_package;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_provisional_tax_scenario(p_pl_period_id uuid, p_tax_year integer, p_estimated_taxable_profit numeric, p_tax_rate_pct numeric, p_method text DEFAULT 'scenario_only')
RETURNS public.finance_provisional_tax_plans
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid(); v_org uuid; v_period public.finance_pl_periods%rowtype; v_source public.bob_nz_finance_sources%rowtype; v_plan public.finance_provisional_tax_plans%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;
  SELECT * INTO v_source FROM public.bob_nz_finance_sources WHERE source_key = 'ird-provisional-tax' AND status = 'active' AND last_verified_on IS NOT NULL AND (review_due_on IS NULL OR review_due_on >= CURRENT_DATE);
  IF NOT FOUND THEN RAISE EXCEPTION 'Current provisional-tax source verification is required'; END IF;
  IF p_estimated_taxable_profit IS NULL OR p_estimated_taxable_profit < 0 OR p_tax_rate_pct IS NULL OR p_tax_rate_pct < 0 OR p_tax_rate_pct > 100 THEN RAISE EXCEPTION 'Tax scenario inputs are invalid'; END IF;
  IF p_method NOT IN ('scenario_only','standard_estimate','accountant_provided') THEN RAISE EXCEPTION 'Unsupported provisional-tax method'; END IF;
  INSERT INTO public.finance_provisional_tax_plans(organization_id, pl_period_id, tax_year, method, estimated_taxable_profit, tax_rate_pct, estimated_income_tax, estimated_provisional_amount, status, assumptions, created_by)
  VALUES (v_org, p_pl_period_id, p_tax_year, p_method, p_estimated_taxable_profit, p_tax_rate_pct, round(p_estimated_taxable_profit * p_tax_rate_pct / 100, 2), round(p_estimated_taxable_profit * p_tax_rate_pct / 100, 2), CASE WHEN p_method = 'accountant_provided' THEN 'awaiting_accountant' ELSE 'draft' END, jsonb_build_object('management_scenario_only', p_method = 'scenario_only', 'source_key', v_source.source_key, 'source_last_verified_on', v_source.last_verified_on, 'not_an_ird_calculation', true, 'not_a_payment_instruction', true), v_actor)
  RETURNING * INTO v_plan;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata) VALUES (v_org, v_actor, 'provisional_tax_scenario_prepared', 'finance_provisional_tax_plans', v_plan.id, jsonb_build_object('tax_year', p_tax_year, 'method', p_method, 'estimated_taxable_profit', p_estimated_taxable_profit, 'tax_rate_pct', p_tax_rate_pct));
  RETURN v_plan;
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_nz_payday_filing_package(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_nz_payday_filing_package(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_provisional_tax_scenario(uuid,integer,numeric,numeric,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_provisional_tax_scenario(uuid,integer,numeric,numeric,text) TO authenticated, service_role;
