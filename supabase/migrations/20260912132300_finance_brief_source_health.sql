CREATE OR REPLACE FUNCTION public.get_finance_owner_brief()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_open_periods integer;
  v_over_budget integer;
  v_unmatched_payments integer;
  v_unresolved_labour integer;
  v_source_count integer;
  v_source_health_issues integer;
  v_tax_due numeric := 0;
  v_tax_due_date date;
  v_priorities jsonb := '[]'::jsonb;
  v_headline text;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT count(*)::integer INTO v_open_periods FROM public.finance_pl_periods WHERE organization_id = v_org AND status IN ('draft','locked');
  SELECT count(*)::integer INTO v_over_budget FROM public.finance_budget_variances WHERE organization_id = v_org AND status IN ('over_budget','no_budget');
  SELECT count(*)::integer INTO v_unmatched_payments FROM public.payment_receipts WHERE organization_id = v_org AND reconciliation_status <> 'matched';
  SELECT count(*)::integer INTO v_unresolved_labour FROM public.finance_labour_cost_postings WHERE organization_id = v_org AND rate_status = 'unresolved';
  SELECT count(*)::integer, count(*) FILTER (WHERE status <> 'active' OR last_verified_on IS NULL OR review_due_on < CURRENT_DATE)::integer INTO v_source_count, v_source_health_issues FROM public.bob_nz_finance_sources;
  SELECT net_tax_due, filing_due_date INTO v_tax_due, v_tax_due_date FROM public.finance_tax_periods WHERE organization_id = v_org AND status IN ('open','prepared') ORDER BY filing_due_date LIMIT 1;

  IF v_source_health_issues > 0 THEN v_priorities := v_priorities || jsonb_build_array(jsonb_build_object('kind', 'knowledge', 'title', v_source_health_issues || ' NZ finance source' || CASE WHEN v_source_health_issues = 1 THEN '' ELSE 's' END || ' need review', 'detail', 'Bob will not rely on guidance until the source register is refreshed.'));
  END IF;
  IF v_unresolved_labour > 0 THEN v_priorities := v_priorities || jsonb_build_array(jsonb_build_object('kind', 'labour', 'title', v_unresolved_labour || ' labour cost' || CASE WHEN v_unresolved_labour = 1 THEN '' ELSE 's' END || ' need a pay rate', 'detail', 'Bob can find the missing rate rule before this affects your results.')); END IF;
  IF v_over_budget > 0 THEN v_priorities := v_priorities || jsonb_build_array(jsonb_build_object('kind', 'budget', 'title', v_over_budget || ' budget item' || CASE WHEN v_over_budget = 1 THEN '' ELSE 's' END || ' need attention', 'detail', 'Bob can explain what is running over and what changed.')); END IF;
  IF v_unmatched_payments > 0 THEN v_priorities := v_priorities || jsonb_build_array(jsonb_build_object('kind', 'payments', 'title', v_unmatched_payments || ' payment' || CASE WHEN v_unmatched_payments = 1 THEN '' ELSE 's' END || ' need matching', 'detail', 'Bob can compare receipts with bank statement lines for your review.')); END IF;
  IF v_tax_due_date IS NOT NULL THEN v_priorities := v_priorities || jsonb_build_array(jsonb_build_object('kind', 'tax', 'title', 'Tax money is due by ' || to_char(v_tax_due_date, 'DD Mon YYYY'), 'detail', 'Bob can prepare the figures and checklist; you approve filing and payment.')); END IF;
  IF jsonb_array_length(v_priorities) = 0 THEN v_headline := 'Nothing urgent was found in the finance records Bob checked.'; ELSE v_headline := 'Bob found ' || jsonb_array_length(v_priorities)::text || ' item' || CASE WHEN jsonb_array_length(v_priorities) = 1 THEN '' ELSE 's' END || ' worth your attention.'; END IF;
  RETURN jsonb_build_object('headline', v_headline, 'priorities', v_priorities, 'facts', jsonb_build_object('open_periods', v_open_periods, 'over_budget', v_over_budget, 'unmatched_payments', v_unmatched_payments, 'unresolved_labour', v_unresolved_labour, 'finance_source_count', v_source_count, 'finance_source_health_issues', v_source_health_issues, 'tax_due', COALESCE(v_tax_due, 0), 'tax_due_date', v_tax_due_date), 'checked_at', now());
END;
$$;
