CREATE OR REPLACE FUNCTION public.close_finance_pl_period(p_pl_period_id uuid)
RETURNS public.finance_pl_periods
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
  v_snapshot public.finance_pl_snapshots%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;
  IF v_period.status IN ('closed','archived') THEN RAISE EXCEPTION 'Period is already closed or archived'; END IF;
  WITH cost_summary AS (
    SELECT COALESCE(SUM(CASE WHEN cost_type = 'labour' THEN total_cost ELSE 0 END), 0) AS total_labour,
      COALESCE(SUM(CASE WHEN cost_type = 'vehicle' THEN total_cost ELSE 0 END), 0) AS total_vehicle,
      COALESCE(SUM(CASE WHEN cost_type = 'materials' THEN total_cost ELSE 0 END), 0) AS total_materials,
      COALESCE(SUM(CASE WHEN cost_type = 'equipment' THEN total_cost ELSE 0 END), 0) AS total_equipment,
      COALESCE(SUM(CASE WHEN cost_type = 'overhead' THEN total_cost ELSE 0 END), 0) AS total_overhead,
      COALESCE(SUM(CASE WHEN cost_type = 'depreciation' THEN total_cost ELSE 0 END), 0) AS total_depreciation,
      COALESCE(SUM(total_cost), 0) AS total_cost, COUNT(*) AS cost_count
    FROM public.finance_service_costs WHERE pl_period_id = p_pl_period_id AND organization_id = v_org
  )
  INSERT INTO public.finance_pl_snapshots(organization_id, pl_period_id, total_labour, total_vehicle, total_materials, total_equipment, total_overhead, total_depreciation, total_cost, cost_line_count, total_revenue)
  SELECT v_org, p_pl_period_id, total_labour, total_vehicle, total_materials, total_equipment, total_overhead, total_depreciation, total_cost, cost_count,
    COALESCE((SELECT SUM(total_amount) FROM public.invoices WHERE organization_id = v_org AND invoice_date BETWEEN v_period.period_start AND v_period.period_end), 0)
  FROM cost_summary RETURNING * INTO v_snapshot;
  UPDATE public.finance_pl_periods SET status = 'closed', closed_at = now(), closed_by = v_actor, updated_at = now() WHERE id = p_pl_period_id RETURNING * INTO v_period;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_pl_period_closed', 'finance_pl_periods', v_period.id, jsonb_build_object('snapshot_id', v_snapshot.id, 'total_cost', v_snapshot.total_cost, 'total_revenue', v_snapshot.total_revenue));
  RETURN v_period;
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
  INSERT INTO public.finance_cost_centre_rolls(organization_id, pl_period_id, cost_centre_id, cost_centre_code, cost_centre_name, total_labour, total_vehicle, total_materials, total_equipment, total_overhead, total_depreciation, total_cost, attribution_count)
  SELECT v_org, p_pl_period_id, cc.id, cc.code, cc.name,
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'labour' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'vehicle' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'materials' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'equipment' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'overhead' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN fsc.cost_type = 'depreciation' THEN fsc.total_cost ELSE 0 END), 0),
    COALESCE(SUM(fsc.total_cost), 0), COUNT(fsc.id)
  FROM public.cost_centres cc LEFT JOIN public.finance_service_costs fsc ON cc.id = fsc.cost_centre_id AND fsc.pl_period_id = p_pl_period_id AND fsc.organization_id = v_org
  WHERE cc.organization_id = v_org GROUP BY cc.id, cc.code, cc.name;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_pl_financial_statement(p_pl_period_id uuid)
RETURNS TABLE(report_name text, period_start date, period_end date, total_revenue numeric, total_labour_cost numeric, total_vehicle_cost numeric, total_materials_cost numeric, total_equipment_cost numeric, total_overhead_cost numeric, total_depreciation_cost numeric, total_operating_cost numeric, gross_profit numeric, gross_margin_pct numeric, cost_breakdown jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid(); v_org uuid; v_period public.finance_pl_periods%rowtype; v_snapshot public.finance_pl_snapshots%rowtype;
  v_revenue numeric := 0; v_labour numeric := 0; v_vehicle numeric := 0; v_materials numeric := 0; v_equipment numeric := 0; v_overhead numeric := 0; v_depreciation numeric := 0; v_total_cost numeric := 0; v_gross_profit numeric := 0; v_margin_pct numeric := 0;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;
  SELECT * INTO v_snapshot FROM public.finance_pl_snapshots WHERE pl_period_id = p_pl_period_id;
  IF FOUND THEN v_labour := v_snapshot.total_labour; v_vehicle := v_snapshot.total_vehicle; v_materials := v_snapshot.total_materials; v_equipment := v_snapshot.total_equipment; v_overhead := v_snapshot.total_overhead; v_depreciation := v_snapshot.total_depreciation; v_total_cost := v_snapshot.total_cost; v_revenue := v_snapshot.total_revenue;
  ELSE SELECT COALESCE(SUM(total_amount), 0) INTO v_revenue FROM public.invoices WHERE organization_id = v_org AND invoice_date BETWEEN v_period.period_start AND v_period.period_end; END IF;
  v_gross_profit := v_revenue - v_total_cost; v_margin_pct := CASE WHEN v_revenue > 0 THEN ROUND((v_gross_profit / v_revenue) * 100, 2) ELSE 0 END;
  RETURN QUERY SELECT 'P&L Statement ' || v_period.period_start::text || ' to ' || v_period.period_end::text, v_period.period_start, v_period.period_end, v_revenue, v_labour, v_vehicle, v_materials, v_equipment, v_overhead, v_depreciation, v_total_cost, v_gross_profit, v_margin_pct, jsonb_build_object('labour', v_labour, 'vehicle', v_vehicle, 'materials', v_materials, 'equipment', v_equipment, 'overhead', v_overhead, 'depreciation', v_depreciation, 'total_cost', v_total_cost);
END;
$$;
