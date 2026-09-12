CREATE TABLE IF NOT EXISTS public.finance_pl_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','locked','closed','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  closed_at timestamptz,
  closed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, period_start, period_end),
  CHECK (period_end >= period_start)
);

CREATE TABLE IF NOT EXISTS public.finance_service_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  client_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  cost_type text NOT NULL CHECK (cost_type IN ('labour','vehicle','materials','equipment','overhead','depreciation','other')),
  cost_centre_id uuid REFERENCES public.cost_centres(id) ON DELETE RESTRICT,
  work_unit_id uuid REFERENCES public.roster_work_units(id) ON DELETE RESTRICT,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE RESTRICT,
  dispatch_job_id uuid REFERENCES public.dispatch_jobs(id) ON DELETE RESTRICT,
  investigation_id uuid REFERENCES public.investigations(id) ON DELETE RESTRICT,
  asset_id uuid REFERENCES public.assets(id) ON DELETE RESTRICT,
  source_document_type text NOT NULL CHECK (source_document_type IN ('timesheet','asset_check','inventory_transaction','asset_maintenance','depreciation_schedule','estimate','manual')),
  source_reference text NOT NULL,
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit_of_measure text,
  unit_cost numeric(14,4) NOT NULL CHECK (unit_cost >= 0),
  total_cost numeric(14,2) NOT NULL CHECK (total_cost >= 0),
  allocation_driver text,
  invoice_line_item_id uuid REFERENCES public.invoice_line_items(id) ON DELETE RESTRICT,
  invoiced_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_pl_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pl_period_id uuid NOT NULL UNIQUE REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  total_labour numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_labour >= 0),
  total_vehicle numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_vehicle >= 0),
  total_materials numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_materials >= 0),
  total_equipment numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_equipment >= 0),
  total_overhead numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_overhead >= 0),
  total_depreciation numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_depreciation >= 0),
  total_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_cost >= 0),
  total_revenue numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_revenue >= 0),
  gross_profit numeric(14,2),
  gross_margin_pct numeric(5,2),
  cost_line_count integer NOT NULL DEFAULT 0 CHECK (cost_line_count >= 0),
  invoice_count integer NOT NULL DEFAULT 0 CHECK (invoice_count >= 0),
  variance_pct numeric(5,2),
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_cost_variance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pl_period_id uuid NOT NULL REFERENCES public.finance_pl_periods(id) ON DELETE RESTRICT,
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  estimated_cost numeric(14,2) NOT NULL CHECK (estimated_cost >= 0),
  actual_cost numeric(14,2) NOT NULL CHECK (actual_cost >= 0),
  variance_amount numeric(14,2) NOT NULL,
  variance_pct numeric(5,2),
  cost_type text NOT NULL,
  notes text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_pl_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_service_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_pl_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_cost_variance ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_pl_periods_select ON public.finance_pl_periods FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_service_costs_select ON public.finance_service_costs FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_pl_snapshots_select ON public.finance_pl_snapshots FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_cost_variance_select ON public.finance_cost_variance FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.finance_pl_periods, public.finance_service_costs, public.finance_pl_snapshots, public.finance_cost_variance FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_pl_periods, public.finance_service_costs, public.finance_pl_snapshots, public.finance_cost_variance TO authenticated;
GRANT ALL ON TABLE public.finance_pl_periods, public.finance_service_costs, public.finance_pl_snapshots, public.finance_cost_variance TO service_role;

CREATE OR REPLACE FUNCTION public.record_finance_service_cost(
  p_pl_period_id uuid,
  p_service_agreement_id uuid,
  p_cost_type text,
  p_quantity numeric,
  p_unit_cost numeric,
  p_source_document_type text,
  p_source_reference text,
  p_work_unit_id uuid DEFAULT NULL,
  p_shift_id uuid DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_investigation_id uuid DEFAULT NULL,
  p_asset_id uuid DEFAULT NULL
)
RETURNS public.finance_service_costs
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
  v_agreement public.service_agreements%rowtype;
  v_cost public.finance_service_costs%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_unit_cost IS NULL OR p_unit_cost < 0 THEN RAISE EXCEPTION 'Quantity and unit cost must be valid positive values'; END IF;
  
  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;
  IF v_period.status = 'closed' THEN RAISE EXCEPTION 'Cannot record costs in a closed P&L period'; END IF;
  
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id AND provider_organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found in organization'; END IF;
  
  INSERT INTO public.finance_service_costs(
    organization_id, pl_period_id, service_agreement_id, client_organization_id, cost_type, 
    work_unit_id, shift_id, dispatch_job_id, investigation_id, asset_id,
    source_document_type, source_reference, quantity, unit_cost, total_cost, created_by
  )
  VALUES (
    v_org, p_pl_period_id, p_service_agreement_id, v_agreement.client_organization_id, p_cost_type,
    p_work_unit_id, p_shift_id, p_dispatch_job_id, p_investigation_id, p_asset_id,
    p_source_document_type, trim(p_source_reference), p_quantity, p_unit_cost, round(p_quantity * p_unit_cost, 2), v_actor
  )
  RETURNING * INTO v_cost;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_service_cost_recorded', 'finance_service_costs', v_cost.id, 
    jsonb_build_object('pl_period_id', p_pl_period_id, 'service_agreement_id', p_service_agreement_id, 
      'cost_type', p_cost_type, 'quantity', p_quantity, 'unit_cost', p_unit_cost, 'source_reference', trim(p_source_reference)));
  
  RETURN v_cost;
END;
$$;

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
    SELECT
      COALESCE(SUM(CASE WHEN cost_type = 'labour' THEN total_cost ELSE 0 END), 0) as total_labour,
      COALESCE(SUM(CASE WHEN cost_type = 'vehicle' THEN total_cost ELSE 0 END), 0) as total_vehicle,
      COALESCE(SUM(CASE WHEN cost_type = 'materials' THEN total_cost ELSE 0 END), 0) as total_materials,
      COALESCE(SUM(CASE WHEN cost_type = 'equipment' THEN total_cost ELSE 0 END), 0) as total_equipment,
      COALESCE(SUM(CASE WHEN cost_type = 'overhead' THEN total_cost ELSE 0 END), 0) as total_overhead,
      COALESCE(SUM(CASE WHEN cost_type = 'depreciation' THEN total_cost ELSE 0 END), 0) as total_depreciation,
      COALESCE(SUM(total_cost), 0) as total_cost,
      COUNT(*) as cost_count
    FROM public.finance_service_costs WHERE pl_period_id = p_pl_period_id AND organization_id = v_org
  ),
  revenue_summary AS (
    SELECT COALESCE(SUM(invoice_amount), 0) as total_revenue
    FROM public.invoices WHERE organization_id = v_org 
      AND invoice_date >= v_period.period_start AND invoice_date <= v_period.period_end
  )
  INSERT INTO public.finance_pl_snapshots(
    organization_id, pl_period_id, total_labour, total_vehicle, total_materials, total_equipment, 
    total_overhead, total_depreciation, total_cost, cost_line_count
  )
  SELECT v_org, p_pl_period_id, cs.total_labour, cs.total_vehicle, cs.total_materials, 
    cs.total_equipment, cs.total_overhead, cs.total_depreciation, cs.total_cost, cs.cost_count
  FROM cost_summary cs
  RETURNING * INTO v_snapshot;

  UPDATE public.finance_pl_periods SET status = 'closed', closed_at = now(), closed_by = v_actor, updated_at = now()
  WHERE id = p_pl_period_id RETURNING * INTO v_period;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_pl_period_closed', 'finance_pl_periods', v_period.id,
    jsonb_build_object('snapshot_id', v_snapshot.id, 'total_cost', v_snapshot.total_cost, 'cost_lines', v_snapshot.cost_line_count));

  RETURN v_period;
END;
$$;

REVOKE ALL ON FUNCTION public.record_finance_service_cost(uuid,uuid,text,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_finance_service_cost(uuid,uuid,text,numeric,numeric,text,text,uuid,uuid,uuid,uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.close_finance_pl_period(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.close_finance_pl_period(uuid) TO authenticated, service_role;
