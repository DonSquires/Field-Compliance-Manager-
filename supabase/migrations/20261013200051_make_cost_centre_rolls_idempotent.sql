ALTER TABLE public.finance_cost_centre_rolls
  ADD CONSTRAINT finance_cost_centre_rolls_org_period_centre_key
  UNIQUE (organization_id, pl_period_id, cost_centre_id);

CREATE OR REPLACE FUNCTION public.calculate_cost_centre_roll(p_pl_period_id uuid)
RETURNS SETOF public.finance_cost_centre_rolls
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
BEGIN
  SELECT organization_id
  INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor
    AND deactivated_at IS NULL;

  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN
    RAISE EXCEPTION 'Active finance administrator required';
  END IF;

  SELECT *
  INTO v_period
  FROM public.finance_pl_periods
  WHERE id = p_pl_period_id
    AND organization_id = v_org;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'P&L period not found in organization';
  END IF;

  RETURN QUERY
  INSERT INTO public.finance_cost_centre_rolls (
    organization_id,
    pl_period_id,
    cost_centre_id,
    cost_centre_code,
    cost_centre_name,
    total_labour,
    total_vehicle,
    total_materials,
    total_equipment,
    total_overhead,
    total_depreciation,
    total_cost,
    attribution_count
  )
  SELECT
    v_org,
    p_pl_period_id,
    cc.id,
    cc.code,
    cc.name,
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'labour' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'vehicle' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'materials' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'equipment' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'overhead' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'depreciation' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(fsc.total_cost), 0),
    COUNT(fsc.id)
  FROM public.cost_centres cc
  LEFT JOIN public.finance_service_costs fsc
    ON cc.id = fsc.cost_centre_id
   AND fsc.pl_period_id = p_pl_period_id
   AND fsc.organization_id = v_org
  WHERE cc.organization_id = v_org
  GROUP BY cc.id, cc.code, cc.name
  ON CONFLICT (organization_id, pl_period_id, cost_centre_id)
  DO UPDATE SET
    cost_centre_code = EXCLUDED.cost_centre_code,
    cost_centre_name = EXCLUDED.cost_centre_name,
    total_labour = EXCLUDED.total_labour,
    total_vehicle = EXCLUDED.total_vehicle,
    total_materials = EXCLUDED.total_materials,
    total_equipment = EXCLUDED.total_equipment,
    total_overhead = EXCLUDED.total_overhead,
    total_depreciation = EXCLUDED.total_depreciation,
    total_cost = EXCLUDED.total_cost,
    attribution_count = EXCLUDED.attribution_count
  RETURNING *;
END;
$function$;

REVOKE ALL ON FUNCTION public.calculate_cost_centre_roll(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calculate_cost_centre_roll(uuid) TO postgres, authenticated, service_role;

COMMENT ON CONSTRAINT finance_cost_centre_rolls_org_period_centre_key
  ON public.finance_cost_centre_rolls
  IS 'One replay-safe persisted cost-centre roll per organization, reporting period, and cost centre.';

COMMENT ON FUNCTION public.calculate_cost_centre_roll(uuid)
  IS 'Recalculates and atomically upserts organization-scoped cost-centre totals for one P&L period.';