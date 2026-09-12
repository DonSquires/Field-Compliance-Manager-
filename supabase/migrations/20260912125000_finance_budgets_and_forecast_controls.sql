CREATE TABLE IF NOT EXISTS public.finance_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  fiscal_year integer NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2200),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','locked','superseded')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_id uuid REFERENCES public.finance_budgets(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, fiscal_year, version)
);

CREATE TABLE IF NOT EXISTS public.finance_budget_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES public.finance_budgets(id) ON DELETE CASCADE,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  cost_centre_id uuid REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  cost_type text NOT NULL CHECK (cost_type IN ('labour','vehicle','materials','equipment','overhead','depreciation','other')),
  budget_amount numeric(14,2) NOT NULL CHECK (budget_amount >= 0),
  notes text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type)
);

CREATE TABLE IF NOT EXISTS public.finance_budget_variances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  budget_id uuid NOT NULL REFERENCES public.finance_budgets(id) ON DELETE RESTRICT,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  cost_centre_id uuid REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  cost_type text NOT NULL,
  budget_amount numeric(14,2) NOT NULL DEFAULT 0,
  actual_amount numeric(14,2) NOT NULL DEFAULT 0,
  variance_amount numeric(14,2) NOT NULL DEFAULT 0,
  variance_pct numeric(5,2),
  status text NOT NULL CHECK (status IN ('on_track','watch','over_budget','no_budget')),
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type)
);

ALTER TABLE public.finance_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_budget_variances ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_budgets_select ON public.finance_budgets FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_budget_lines_select ON public.finance_budget_lines FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_budget_variances_select ON public.finance_budget_variances FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.finance_budgets, public.finance_budget_lines, public.finance_budget_variances FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_budgets, public.finance_budget_lines, public.finance_budget_variances TO authenticated;
GRANT ALL ON TABLE public.finance_budgets, public.finance_budget_lines, public.finance_budget_variances TO service_role;

CREATE OR REPLACE FUNCTION public.create_finance_budget(
  p_name text,
  p_fiscal_year integer
)
RETURNS public.finance_budgets
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_budget public.finance_budgets%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF nullif(trim(p_name), '') IS NULL OR p_fiscal_year NOT BETWEEN 2000 AND 2200 THEN RAISE EXCEPTION 'Budget name and fiscal year are required'; END IF;
  INSERT INTO public.finance_budgets(organization_id, name, fiscal_year, created_by)
  VALUES (v_org, trim(p_name), p_fiscal_year, v_actor)
  RETURNING * INTO v_budget;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_budget_created', 'finance_budgets', v_budget.id, jsonb_build_object('fiscal_year', p_fiscal_year));
  RETURN v_budget;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_finance_budget_line(
  p_budget_id uuid,
  p_pl_period_id uuid,
  p_cost_type text,
  p_budget_amount numeric,
  p_cost_centre_id uuid DEFAULT NULL,
  p_service_agreement_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.finance_budget_lines
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_budget public.finance_budgets%rowtype;
  v_period public.finance_pl_periods%rowtype;
  v_line public.finance_budget_lines%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_budget FROM public.finance_budgets WHERE id = p_budget_id AND organization_id = v_org;
  IF NOT FOUND OR v_budget.status <> 'draft' THEN RAISE EXCEPTION 'Only draft budgets can be changed'; END IF;
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND OR v_period.status IN ('closed','archived') THEN RAISE EXCEPTION 'Budget period is unavailable'; END IF;
  IF p_budget_amount IS NULL OR p_budget_amount < 0 THEN RAISE EXCEPTION 'Budget amount cannot be negative'; END IF;
  INSERT INTO public.finance_budget_lines(organization_id, budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type, budget_amount, notes, created_by)
  VALUES (v_org, p_budget_id, p_pl_period_id, p_cost_centre_id, p_service_agreement_id, p_cost_type, p_budget_amount, p_notes, v_actor)
  ON CONFLICT (budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type)
  DO UPDATE SET budget_amount = EXCLUDED.budget_amount, notes = EXCLUDED.notes
  RETURNING * INTO v_line;
  RETURN v_line;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_finance_budget(p_budget_id uuid)
RETURNS public.finance_budgets
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_budget public.finance_budgets%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_budget FROM public.finance_budgets WHERE id = p_budget_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND OR v_budget.status <> 'draft' THEN RAISE EXCEPTION 'Only draft budgets can be approved'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_budget_lines WHERE budget_id = p_budget_id) THEN RAISE EXCEPTION 'Budget requires at least one line'; END IF;
  UPDATE public.finance_budgets SET status = 'approved', approved_by = v_actor, approved_at = now(), updated_at = now() WHERE id = p_budget_id RETURNING * INTO v_budget;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_budget_approved', 'finance_budgets', v_budget.id, jsonb_build_object('version', v_budget.version));
  RETURN v_budget;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_finance_budget_variance(p_budget_id uuid, p_pl_period_id uuid)
RETURNS SETOF public.finance_budget_variances
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.finance_budgets WHERE id = p_budget_id AND organization_id = v_org AND status IN ('approved','locked')) THEN RAISE EXCEPTION 'Approved budget not found in organization'; END IF;
  RETURN QUERY
  INSERT INTO public.finance_budget_variances(organization_id, budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type, budget_amount, actual_amount, variance_amount, variance_pct, status)
  SELECT v_org, p_budget_id, p_pl_period_id, x.cost_centre_id, x.service_agreement_id, x.cost_type, x.budget_amount, x.actual_amount,
    x.actual_amount - x.budget_amount,
    CASE WHEN x.budget_amount > 0 THEN ROUND(((x.actual_amount - x.budget_amount) / x.budget_amount) * 100, 2) ELSE NULL END,
    CASE WHEN x.budget_amount = 0 AND x.actual_amount > 0 THEN 'no_budget' WHEN x.actual_amount <= x.budget_amount THEN 'on_track' WHEN x.actual_amount <= x.budget_amount * 1.10 THEN 'watch' ELSE 'over_budget' END
  FROM (
    SELECT COALESCE(bl.cost_centre_id, ac.cost_centre_id) AS cost_centre_id,
      COALESCE(bl.service_agreement_id, ac.service_agreement_id) AS service_agreement_id,
      COALESCE(bl.cost_type, ac.cost_type) AS cost_type,
      COALESCE(bl.budget_amount, 0) AS budget_amount,
      COALESCE(ac.actual_amount, 0) AS actual_amount
    FROM (SELECT cost_centre_id, service_agreement_id, cost_type, SUM(budget_amount) budget_amount FROM public.finance_budget_lines WHERE budget_id = p_budget_id AND pl_period_id = p_pl_period_id GROUP BY cost_centre_id, service_agreement_id, cost_type) bl
    FULL JOIN (SELECT cost_centre_id, service_agreement_id, cost_type, SUM(total_cost) actual_amount FROM public.finance_service_costs WHERE organization_id = v_org AND pl_period_id = p_pl_period_id GROUP BY cost_centre_id, service_agreement_id, cost_type) ac
      ON bl.cost_centre_id IS NOT DISTINCT FROM ac.cost_centre_id AND bl.service_agreement_id IS NOT DISTINCT FROM ac.service_agreement_id AND bl.cost_type = ac.cost_type
  ) x
  ON CONFLICT (budget_id, pl_period_id, cost_centre_id, service_agreement_id, cost_type)
  DO UPDATE SET budget_amount = EXCLUDED.budget_amount, actual_amount = EXCLUDED.actual_amount, variance_amount = EXCLUDED.variance_amount, variance_pct = EXCLUDED.variance_pct, status = EXCLUDED.status, calculated_at = now()
  RETURNING *;
END;
$$;

REVOKE ALL ON FUNCTION public.create_finance_budget(text,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_finance_budget(text,integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.add_finance_budget_line(uuid,uuid,text,numeric,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_finance_budget_line(uuid,uuid,text,numeric,uuid,uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_finance_budget(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_finance_budget(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.calculate_finance_budget_variance(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_finance_budget_variance(uuid,uuid) TO authenticated, service_role;
