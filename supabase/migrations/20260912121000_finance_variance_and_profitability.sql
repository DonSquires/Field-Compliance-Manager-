CREATE TABLE IF NOT EXISTS public.finance_service_profitability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  client_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  service_type text,
  location_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  estimated_labour numeric(14,2) NOT NULL DEFAULT 0,
  actual_labour numeric(14,2) NOT NULL DEFAULT 0,
  labour_variance_pct numeric(5,2),
  estimated_vehicle numeric(14,2) NOT NULL DEFAULT 0,
  actual_vehicle numeric(14,2) NOT NULL DEFAULT 0,
  vehicle_variance_pct numeric(5,2),
  estimated_materials numeric(14,2) NOT NULL DEFAULT 0,
  actual_materials numeric(14,2) NOT NULL DEFAULT 0,
  materials_variance_pct numeric(5,2),
  estimated_overhead numeric(14,2) NOT NULL DEFAULT 0,
  actual_overhead numeric(14,2) NOT NULL DEFAULT 0,
  overhead_variance_pct numeric(5,2),
  estimated_total_cost numeric(14,2) NOT NULL DEFAULT 0,
  actual_total_cost numeric(14,2) NOT NULL DEFAULT 0,
  total_variance_pct numeric(5,2),
  estimated_margin_pct numeric(5,2),
  actual_margin_pct numeric(5,2),
  margin_impact_pct numeric(5,2),
  client_invoice_total numeric(14,2) NOT NULL DEFAULT 0,
  net_profit numeric(14,2),
  work_unit_count integer DEFAULT 0,
  invoice_count integer DEFAULT 0,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_cost_centre_rolls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  cost_centre_id uuid NOT NULL REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  cost_centre_code text NOT NULL,
  cost_centre_name text NOT NULL,
  total_labour numeric(14,2) NOT NULL DEFAULT 0,
  total_vehicle numeric(14,2) NOT NULL DEFAULT 0,
  total_materials numeric(14,2) NOT NULL DEFAULT 0,
  total_equipment numeric(14,2) NOT NULL DEFAULT 0,
  total_overhead numeric(14,2) NOT NULL DEFAULT 0,
  total_depreciation numeric(14,2) NOT NULL DEFAULT 0,
  total_cost numeric(14,2) NOT NULL DEFAULT 0,
  attribution_count integer DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_variance_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  profitability_id uuid REFERENCES public.finance_service_profitability(id) ON DELETE RESTRICT,
  exception_type text NOT NULL CHECK (exception_type IN ('unfavourable_variance','favourable_variance','missing_cost','missing_revenue','policy_violation')),
  variance_pct numeric(5,2),
  variance_amount numeric(14,2),
  affected_cost_type text,
  threshold_pct numeric(5,2),
  description text,
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  acknowledged_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_service_profitability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_cost_centre_rolls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_variance_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_service_profitability_select ON public.finance_service_profitability FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_cost_centre_rolls_select ON public.finance_cost_centre_rolls FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_variance_exceptions_select ON public.finance_variance_exceptions FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.finance_service_profitability, public.finance_cost_centre_rolls, public.finance_variance_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_service_profitability, public.finance_cost_centre_rolls, public.finance_variance_exceptions TO authenticated;
GRANT ALL ON TABLE public.finance_service_profitability, public.finance_cost_centre_rolls, public.finance_variance_exceptions TO service_role;

CREATE OR REPLACE FUNCTION public.calculate_service_profitability_snapshot(p_pl_period_id uuid)
RETURNS SETOF public.finance_service_profitability
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
  v_row public.finance_service_profitability%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;

  RETURN QUERY
  WITH quote_estimates AS (
    SELECT
      sa.id as service_agreement_id,
      sa.client_organization_id,
      'quote' as service_type,
      NULL::uuid as location_id,
      COALESCE(SUM(CASE WHEN ct.category_name = 'labour' THEN qci.cost_amount ELSE 0 END), 0) as est_labour,
      COALESCE(SUM(CASE WHEN ct.category_name = 'vehicle' THEN qci.cost_amount ELSE 0 END), 0) as est_vehicle,
      COALESCE(SUM(CASE WHEN ct.category_name = 'materials' THEN qci.cost_amount ELSE 0 END), 0) as est_materials,
      COALESCE(SUM(CASE WHEN ct.category_name = 'overhead' THEN qci.cost_amount ELSE 0 END), 0) as est_overhead,
      COALESCE(SUM(qci.cost_amount), 0) as est_total,
      COALESCE(SUM(qci.invoice_amount), 0) as quoted_charge
    FROM public.service_agreements sa
    LEFT JOIN public.quotes q ON sa.id = q.service_agreement_id AND q.status IN ('approved','accepted','invoiced')
    LEFT JOIN public.quote_cost_items qci ON q.id = qci.quote_id
    LEFT JOIN public.finance_cost_categories ct ON qci.cost_category_id = ct.id
    WHERE sa.provider_organization_id = v_org
    GROUP BY sa.id, sa.client_organization_id
  ),
  actual_costs AS (
    SELECT
      fsc.service_agreement_id,
      fsc.client_organization_id,
      fsc.site_id as location_id,
      COALESCE(SUM(CASE WHEN fsc.cost_type = 'labour' THEN fsc.total_cost ELSE 0 END), 0) as act_labour,
      COALESCE(SUM(CASE WHEN fsc.cost_type = 'vehicle' THEN fsc.total_cost ELSE 0 END), 0) as act_vehicle,
      COALESCE(SUM(CASE WHEN fsc.cost_type = 'materials' THEN fsc.total_cost ELSE 0 END), 0) as act_materials,
      COALESCE(SUM(CASE WHEN fsc.cost_type = 'overhead' THEN fsc.total_cost ELSE 0 END), 0) as act_overhead,
      COALESCE(SUM(fsc.total_cost), 0) as act_total,
      COUNT(*) as cost_lines
    FROM public.finance_service_costs fsc
    WHERE fsc.organization_id = v_org AND fsc.pl_period_id = p_pl_period_id
    GROUP BY fsc.service_agreement_id, fsc.client_organization_id, fsc.site_id
  ),
  combined AS (
    SELECT
      COALESCE(qe.service_agreement_id, ac.service_agreement_id) as sa_id,
      COALESCE(qe.client_organization_id, ac.client_organization_id) as client_org,
      qe.service_type,
      COALESCE(ac.location_id, qe.location_id) as loc_id,
      qe.est_labour, ac.act_labour,
      qe.est_vehicle, ac.act_vehicle,
      qe.est_materials, ac.act_materials,
      qe.est_overhead, ac.act_overhead,
      qe.est_total, ac.act_total,
      qe.quoted_charge
    FROM quote_estimates qe
    FULL JOIN actual_costs ac ON qe.service_agreement_id = ac.service_agreement_id AND qe.location_id IS NOT DISTINCT FROM ac.location_id
  )
  INSERT INTO public.finance_service_profitability(
    organization_id, pl_period_id, service_agreement_id, client_organization_id, service_type, location_id,
    estimated_labour, actual_labour, labour_variance_pct,
    estimated_vehicle, actual_vehicle, vehicle_variance_pct,
    estimated_materials, actual_materials, materials_variance_pct,
    estimated_overhead, actual_overhead, overhead_variance_pct,
    estimated_total_cost, actual_total_cost, total_variance_pct,
    estimated_margin_pct, actual_margin_pct, margin_impact_pct,
    client_invoice_total, net_profit, work_unit_count, invoice_count, created_by
  )
  SELECT
    v_org, p_pl_period_id, c.sa_id, c.client_org, c.service_type, c.loc_id,
    c.est_labour, c.act_labour, 
    CASE WHEN c.est_labour > 0 THEN ROUND(((c.act_labour - c.est_labour) / c.est_labour) * 100, 2) ELSE NULL END,
    c.est_vehicle, c.act_vehicle,
    CASE WHEN c.est_vehicle > 0 THEN ROUND(((c.act_vehicle - c.est_vehicle) / c.est_vehicle) * 100, 2) ELSE NULL END,
    c.est_materials, c.act_materials,
    CASE WHEN c.est_materials > 0 THEN ROUND(((c.act_materials - c.est_materials) / c.est_materials) * 100, 2) ELSE NULL END,
    c.est_overhead, c.act_overhead,
    CASE WHEN c.est_overhead > 0 THEN ROUND(((c.act_overhead - c.est_overhead) / c.est_overhead) * 100, 2) ELSE NULL END,
    c.est_total, c.act_total,
    CASE WHEN c.est_total > 0 THEN ROUND(((c.act_total - c.est_total) / c.est_total) * 100, 2) ELSE NULL END,
    CASE WHEN c.quoted_charge > 0 THEN ROUND(((c.quoted_charge - c.est_total) / c.quoted_charge) * 100, 2) ELSE NULL END,
    CASE WHEN c.quoted_charge > 0 THEN ROUND(((c.quoted_charge - c.act_total) / c.quoted_charge) * 100, 2) ELSE NULL END,
    CASE WHEN c.quoted_charge > 0 THEN ROUND(((c.quoted_charge - c.act_total) / c.quoted_charge) * 100, 2) ELSE NULL END,
    c.quoted_charge, c.quoted_charge - c.act_total,
    NULL::integer, NULL::integer, v_actor
  FROM combined c;
END;
$$;

CREATE OR REPLACE FUNCTION public.calculate_cost_centre_roll(p_pl_period_id uuid)
RETURNS SETOF public.finance_cost_centre_rolls
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;

  RETURN QUERY
  INSERT INTO public.finance_cost_centre_rolls(
    organization_id, pl_period_id, cost_centre_id, cost_centre_code, cost_centre_name,
    total_labour, total_vehicle, total_materials, total_equipment, total_overhead, total_depreciation, total_cost, attribution_count
  )
  SELECT
    v_org, p_pl_period_id, cc.id, cc.cost_centre_code, cc.cost_centre_name,
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'labour' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'vehicle' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'materials' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'equipment' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'overhead' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'depreciation' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(fsc.total_cost), 0),
    COUNT(*)
  FROM public.cost_centres cc
  LEFT JOIN public.finance_service_costs fsc ON cc.id = fsc.cost_centre_id AND fsc.pl_period_id = p_pl_period_id
  WHERE cc.organization_id = v_org
  GROUP BY cc.id, cc.cost_centre_code, cc.cost_centre_name;
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_service_profitability_snapshot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_service_profitability_snapshot(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.calculate_cost_centre_roll(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.calculate_cost_centre_roll(uuid) TO authenticated, service_role;
