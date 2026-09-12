CREATE TABLE IF NOT EXISTS public.bob_nz_finance_readiness_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_key text NOT NULL REFERENCES public.bob_nz_finance_sources(source_key) ON DELETE RESTRICT,
  check_code text NOT NULL,
  check_title text NOT NULL,
  status text NOT NULL CHECK (status IN ('ready','partial','gap','not_assessed')),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  evidence text NOT NULL,
  bob_can_do text NOT NULL,
  human_or_provider_needed text NOT NULL,
  measured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, source_key)
);

ALTER TABLE public.bob_nz_finance_readiness_checks ENABLE ROW LEVEL SECURITY;
CREATE POLICY bob_nz_finance_readiness_checks_select ON public.bob_nz_finance_readiness_checks FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON TABLE public.bob_nz_finance_readiness_checks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.bob_nz_finance_readiness_checks TO authenticated;
GRANT ALL ON TABLE public.bob_nz_finance_readiness_checks TO service_role;

CREATE OR REPLACE FUNCTION public.assess_bob_nz_finance_readiness()
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_tax_periods integer;
  v_tax_transactions integer;
  v_timesheets integer;
  v_labour_postings integer;
  v_finance_costs integer;
  v_results jsonb;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT count(*)::integer INTO v_tax_periods FROM public.finance_tax_periods WHERE organization_id = v_org;
  SELECT count(*)::integer INTO v_tax_transactions FROM public.finance_tax_transactions WHERE organization_id = v_org;
  SELECT count(*)::integer INTO v_timesheets FROM public.timesheets WHERE organization_id = v_org;
  SELECT count(*)::integer INTO v_labour_postings FROM public.finance_labour_cost_postings WHERE organization_id = v_org;
  SELECT count(*)::integer INTO v_finance_costs FROM public.finance_service_costs WHERE organization_id = v_org;

  INSERT INTO public.bob_nz_finance_readiness_checks(organization_id, source_key, check_code, check_title, status, score, evidence, bob_can_do, human_or_provider_needed, measured_at)
  VALUES
    (v_org, 'ird-gst-overview', 'gst', 'GST calculation and period control', CASE WHEN v_tax_periods > 0 AND v_tax_transactions > 0 THEN 'partial' ELSE 'gap' END, CASE WHEN v_tax_periods > 0 AND v_tax_transactions > 0 THEN 60 ELSE 30 END, 'GST periods and tax transactions exist: ' || v_tax_periods || ' periods, ' || v_tax_transactions || ' transactions. Filing submission and payment integration are not present.', 'Prepare GST figures, explain output/input tax, identify missing transactions, and create a filing checklist.', 'A person or approved tax/accounting provider must confirm the return and submit/pay it to IRD.', now()),
    (v_org, 'ird-gst-records', 'gst_record_keeping', 'GST evidence and record keeping', CASE WHEN v_finance_costs > 0 THEN 'partial' ELSE 'gap' END, CASE WHEN v_finance_costs > 0 THEN 65 ELSE 25 END, 'Finance service costs provide source references and audit entries; source documents and full tax-invoice evidence are not automatically complete.', 'Collect provenance, flag missing receipts/invoices, and explain which records support each figure.', 'The owner and accountant must retain complete tax invoices and decide whether evidence supports a GST position.', now()),
    (v_org, 'ird-employers', 'employers', 'Employer cost and staff finance controls', CASE WHEN v_timesheets > 0 AND v_labour_postings > 0 THEN 'partial' ELSE 'gap' END, CASE WHEN v_timesheets > 0 AND v_labour_postings > 0 THEN 60 ELSE 30 END, 'Timesheets and actual labour-cost postings exist: ' || v_timesheets || ' timesheets, ' || v_labour_postings || ' labour postings. Employment compliance and PAYE calculations are not statutory payroll.', 'Check approved hours, rates, on-cost assumptions, missing pay rules, and management labour cost.', 'A payroll provider or payroll specialist must calculate and file PAYE and employment obligations.', now()),
    (v_org, 'ird-provisional-tax', 'provisional_tax', 'Provisional tax planning', 'gap', 15, 'No dedicated provisional-tax liability, estimate, payment schedule, or IRD submission workflow exists.', 'Explain that provisional tax may need planning and prepare questions for the accountant using management results.', 'An accountant or tax agent must calculate the liability, method, dates, and payment instruction.', now()),
    (v_org, 'ird-payroll', 'payday_filing', 'Payday filing integration', 'gap', 10, 'Timesheets and cost postings exist, but no IRD payday-file generation, submission, response, or correction workflow exists.', 'Prepare a clean hours/rates export and identify unresolved payroll inputs.', 'An approved payroll system/provider must generate and submit payday files to IRD.', now()),
    (v_org, 'xrb-nz-accounting-standards', 'accounting_standards', 'Accounting standards and statutory reporting', 'partial', 45, 'Management P&L, budgets, costs, invoices, tax records, and audit trails exist; general-ledger journals, statutory statements, and reporting-entity classification are not implemented.', 'Keep management measures separate, show assumptions, preserve evidence, and prepare an accountant handoff.', 'A qualified accountant must determine applicable standards, classifications, adjustments, and statutory statements.', now())
  ON CONFLICT (organization_id, source_key) DO UPDATE SET check_code = EXCLUDED.check_code, check_title = EXCLUDED.check_title, status = EXCLUDED.status, score = EXCLUDED.score, evidence = EXCLUDED.evidence, bob_can_do = EXCLUDED.bob_can_do, human_or_provider_needed = EXCLUDED.human_or_provider_needed, measured_at = EXCLUDED.measured_at;

  SELECT jsonb_build_object('measured_at', now(), 'overall_score', round(avg(score)), 'checks', jsonb_agg(jsonb_build_object('source_key', source_key, 'title', check_title, 'status', status, 'score', score, 'evidence', evidence, 'bob_can_do', bob_can_do, 'human_or_provider_needed', human_or_provider_needed) ORDER BY source_key)) INTO v_results
  FROM public.bob_nz_finance_readiness_checks WHERE organization_id = v_org;
  RETURN v_results;
END;
$$;

REVOKE ALL ON FUNCTION public.assess_bob_nz_finance_readiness() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assess_bob_nz_finance_readiness() TO authenticated, service_role;
