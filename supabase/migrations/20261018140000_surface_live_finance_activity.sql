CREATE OR REPLACE FUNCTION public.get_finance_pl_period_summary(p_pl_period_id uuid)
RETURNS TABLE(
  pl_period_id uuid,
  period_status text,
  total_labour numeric,
  total_vehicle numeric,
  total_materials numeric,
  total_equipment numeric,
  total_overhead numeric,
  total_depreciation numeric,
  total_cost numeric,
  cost_line_count integer,
  total_revenue numeric,
  invoice_count integer,
  gross_profit numeric,
  gross_margin_pct numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
  WITH cost_summary AS (
    SELECT
      coalesce(sum(fsc.total_cost) FILTER (WHERE fsc.cost_type = 'labour'), 0)::numeric AS total_labour,
      coalesce(sum(fsc.total_cost) FILTER (WHERE fsc.cost_type = 'vehicle'), 0)::numeric AS total_vehicle,
      coalesce(sum(fsc.total_cost) FILTER (WHERE fsc.cost_type = 'materials'), 0)::numeric AS total_materials,
      coalesce(sum(fsc.total_cost) FILTER (WHERE fsc.cost_type = 'equipment'), 0)::numeric AS total_equipment,
      coalesce(sum(fsc.total_cost) FILTER (WHERE fsc.cost_type = 'overhead'), 0)::numeric AS total_overhead,
      coalesce(sum(fsc.total_cost) FILTER (WHERE fsc.cost_type = 'depreciation'), 0)::numeric AS total_depreciation,
      coalesce(sum(fsc.total_cost), 0)::numeric AS total_cost,
      count(fsc.id)::integer AS cost_line_count
    FROM public.finance_service_costs fsc
    WHERE fsc.organization_id = v_org
      AND fsc.pl_period_id = p_pl_period_id
  ),
  revenue_summary AS (
    SELECT
      coalesce(sum(invoice.total_amount), 0)::numeric AS total_revenue,
      count(*)::integer AS invoice_count
    FROM public.invoices invoice
    WHERE invoice.organization_id = v_org
      AND invoice.invoice_date BETWEEN v_period.period_start AND v_period.period_end
  )
  SELECT
    v_period.id,
    v_period.status,
    costs.total_labour,
    costs.total_vehicle,
    costs.total_materials,
    costs.total_equipment,
    costs.total_overhead,
    costs.total_depreciation,
    costs.total_cost,
    costs.cost_line_count,
    revenue.total_revenue,
    revenue.invoice_count,
    round(revenue.total_revenue - costs.total_cost, 2),
    CASE
      WHEN revenue.total_revenue > 0
        THEN round(((revenue.total_revenue - costs.total_cost) / revenue.total_revenue) * 100, 2)
      ELSE NULL
    END
  FROM cost_summary costs
  CROSS JOIN revenue_summary revenue;
END;
$$;

REVOKE ALL ON FUNCTION public.get_finance_pl_period_summary(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_finance_pl_period_summary(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.close_finance_pl_period(p_pl_period_id uuid)
RETURNS public.finance_pl_periods
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
      COALESCE(SUM(total_cost), 0) AS total_cost,
      COUNT(*)::integer AS cost_count
    FROM public.finance_service_costs
    WHERE pl_period_id = p_pl_period_id
      AND organization_id = v_org
  ),
  revenue_summary AS (
    SELECT
      COALESCE(SUM(total_amount), 0)::numeric AS total_revenue,
      COUNT(*)::integer AS invoice_count
    FROM public.invoices
    WHERE organization_id = v_org
      AND invoice_date BETWEEN v_period.period_start AND v_period.period_end
  )
  INSERT INTO public.finance_pl_snapshots(
    organization_id,
    pl_period_id,
    total_labour,
    total_vehicle,
    total_materials,
    total_equipment,
    total_overhead,
    total_depreciation,
    total_cost,
    cost_line_count,
    total_revenue,
    invoice_count,
    gross_profit,
    gross_margin_pct
  )
  SELECT
    v_org,
    p_pl_period_id,
    costs.total_labour,
    costs.total_vehicle,
    costs.total_materials,
    costs.total_equipment,
    costs.total_overhead,
    costs.total_depreciation,
    costs.total_cost,
    costs.cost_count,
    revenue.total_revenue,
    revenue.invoice_count,
    round(revenue.total_revenue - costs.total_cost, 2),
    CASE
      WHEN revenue.total_revenue > 0
        THEN round(((revenue.total_revenue - costs.total_cost) / revenue.total_revenue) * 100, 2)
      ELSE NULL
    END
  FROM cost_summary costs
  CROSS JOIN revenue_summary revenue
  RETURNING * INTO v_snapshot;

  UPDATE public.finance_pl_periods SET status = 'closed', closed_at = now(), closed_by = v_actor, updated_at = now() WHERE id = p_pl_period_id RETURNING * INTO v_period;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_pl_period_closed', 'finance_pl_periods', v_period.id, jsonb_build_object('snapshot_id', v_snapshot.id, 'total_cost', v_snapshot.total_cost, 'total_revenue', v_snapshot.total_revenue));
  RETURN v_period;
END;
$$;

REVOKE ALL ON FUNCTION public.close_finance_pl_period(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.close_finance_pl_period(uuid) TO authenticated, service_role;

DROP FUNCTION public.get_consolidated_commercial_overview(uuid, date, date);

CREATE FUNCTION public.get_consolidated_commercial_overview(
  p_root_organization_id uuid,
  p_from date DEFAULT (current_date - 30),
  p_to date DEFAULT current_date
)
RETURNS TABLE(
  source_organization_id uuid,
  source_organization_name text,
  invoice_count integer,
  open_receivables numeric,
  overdue_receivables numeric,
  invoice_total numeric,
  quote_count integer,
  accepted_agreement_count integer,
  report_pack_count integer,
  service_cost_count integer,
  service_cost_total numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_root_organization_id IS NULL OR NOT public.is_admin_for_org(p_root_organization_id) THEN
    RAISE EXCEPTION 'Root organization administrator required';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Reporting period must be between one day and one year';
  END IF;

  RETURN QUERY
  WITH scoped_organizations AS (
    SELECT organization.id, organization.name
    FROM public.organizations organization
    WHERE organization.id = ANY(public.get_descendant_organizations(p_root_organization_id))
      AND (
        organization.id = p_root_organization_id
        OR organization.organization_type = 'branch'
      )
  ),
  invoice_totals AS (
    SELECT invoice.organization_id,
      count(*)::integer AS invoice_count,
      coalesce(sum(invoice.total_amount) FILTER (WHERE invoice.status IN ('sent', 'overdue')), 0)::numeric AS open_receivables,
      coalesce(sum(invoice.total_amount) FILTER (WHERE invoice.status = 'overdue'), 0)::numeric AS overdue_receivables,
      coalesce(sum(invoice.total_amount) FILTER (WHERE invoice.status <> 'void'), 0)::numeric AS invoice_total
    FROM public.invoices invoice
    WHERE invoice.organization_id IN (SELECT id FROM scoped_organizations)
      AND invoice.invoice_date BETWEEN p_from AND p_to
    GROUP BY invoice.organization_id
  ),
  quote_totals AS (
    SELECT quote.provider_org_id, count(*)::integer AS quote_count
    FROM public.quotes quote
    WHERE quote.provider_org_id IN (SELECT id FROM scoped_organizations)
      AND quote.created_at::date BETWEEN p_from AND p_to
    GROUP BY quote.provider_org_id
  ),
  agreement_totals AS (
    SELECT agreement.provider_organization_id, count(*)::integer AS accepted_agreement_count
    FROM public.service_agreements agreement
    WHERE agreement.provider_organization_id IN (SELECT id FROM scoped_organizations)
      AND agreement.agreement_type = 'operational'
      AND agreement.invitation_status = 'accepted'
    GROUP BY agreement.provider_organization_id
  ),
  report_totals AS (
    SELECT pack.organization_id, count(*)::integer AS report_pack_count
    FROM public.monthly_report_packs pack
    WHERE pack.organization_id IN (SELECT id FROM scoped_organizations)
      AND pack.period_start <= p_to
      AND pack.period_end >= p_from
    GROUP BY pack.organization_id
  ),
  cost_totals AS (
    SELECT cost.organization_id,
      count(*)::integer AS service_cost_count,
      coalesce(sum(cost.total_cost), 0)::numeric AS service_cost_total
    FROM public.finance_service_costs cost
    JOIN public.finance_pl_periods period
      ON period.id = cost.pl_period_id
      AND period.organization_id = cost.organization_id
    WHERE cost.organization_id IN (SELECT id FROM scoped_organizations)
      AND period.period_start <= p_to
      AND period.period_end >= p_from
    GROUP BY cost.organization_id
  )
  SELECT scoped.id,
    scoped.name,
    coalesce(invoices.invoice_count, 0),
    coalesce(invoices.open_receivables, 0),
    coalesce(invoices.overdue_receivables, 0),
    coalesce(invoices.invoice_total, 0),
    coalesce(quotes.quote_count, 0),
    coalesce(agreements.accepted_agreement_count, 0),
    coalesce(reports.report_pack_count, 0),
    coalesce(costs.service_cost_count, 0),
    coalesce(costs.service_cost_total, 0)
  FROM scoped_organizations scoped
  LEFT JOIN invoice_totals invoices ON invoices.organization_id = scoped.id
  LEFT JOIN quote_totals quotes ON quotes.provider_org_id = scoped.id
  LEFT JOIN agreement_totals agreements ON agreements.provider_organization_id = scoped.id
  LEFT JOIN report_totals reports ON reports.organization_id = scoped.id
  LEFT JOIN cost_totals costs ON costs.organization_id = scoped.id
  ORDER BY scoped.name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_consolidated_commercial_overview(uuid, date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_consolidated_commercial_overview(uuid, date, date) TO authenticated, service_role;
