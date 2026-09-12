CREATE OR REPLACE FUNCTION public.create_finance_pl_period(
  p_name text,
  p_period_start date,
  p_period_end date
)
RETURNS public.finance_pl_periods
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF nullif(trim(p_name), '') IS NULL OR p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN RAISE EXCEPTION 'Valid period name and dates are required'; END IF;
  INSERT INTO public.finance_pl_periods(organization_id, name, period_start, period_end, status, created_by)
  VALUES(v_org, trim(p_name), p_period_start, p_period_end, 'draft', v_actor)
  ON CONFLICT (organization_id, period_start, period_end) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
  RETURNING * INTO v_period;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_org, v_actor, 'finance_pl_period_created', 'finance_pl_periods', v_period.id, jsonb_build_object('name', v_period.name, 'period_start', v_period.period_start, 'period_end', v_period.period_end));
  RETURN v_period;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_finance_tax_period(
  p_period_start date,
  p_period_end date,
  p_filing_due_date date
)
RETURNS public.finance_tax_periods
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_tax_periods%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_filing_due_date IS NULL OR p_period_end < p_period_start OR p_filing_due_date < p_period_end THEN RAISE EXCEPTION 'Valid tax period and filing due dates are required'; END IF;
  INSERT INTO public.finance_tax_periods(organization_id, period_start, period_end, filing_due_date, status, created_by)
  VALUES(v_org, p_period_start, p_period_end, p_filing_due_date, 'open', v_actor)
  ON CONFLICT (organization_id, period_start, period_end) DO UPDATE SET filing_due_date = EXCLUDED.filing_due_date
  RETURNING * INTO v_period;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_org, v_actor, 'finance_tax_period_created', 'finance_tax_periods', v_period.id, jsonb_build_object('period_start', v_period.period_start, 'period_end', v_period.period_end, 'filing_due_date', v_period.filing_due_date));
  RETURN v_period;
END;
$$;

REVOKE ALL ON FUNCTION public.create_finance_pl_period(text,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_finance_pl_period(text,date,date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_finance_tax_period(date,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_finance_tax_period(date,date,date) TO authenticated, service_role;
