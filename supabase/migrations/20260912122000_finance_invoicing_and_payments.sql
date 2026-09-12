CREATE TABLE IF NOT EXISTS public.invoice_line_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  quote_id uuid REFERENCES public.quotes(id) ON DELETE RESTRICT,
  quote_cost_item_id uuid REFERENCES public.quote_cost_items(id) ON DELETE SET NULL,
  service_cost_id uuid REFERENCES public.finance_service_costs(id) ON DELETE SET NULL,
  finance_item_catalog_id uuid REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  description text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('labour','vehicle','materials','equipment','overhead','depreciation','other','credit','discount','tax')),
  quantity numeric(14,3) NOT NULL DEFAULT 1,
  unit_of_measure text,
  unit_price numeric(14,4) NOT NULL DEFAULT 0,
  line_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (line_amount >= 0),
  tax_rate_pct numeric(5,2) DEFAULT 0,
  tax_amount numeric(14,2) DEFAULT 0 CHECK (tax_amount >= 0),
  total_line_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_line_amount >= 0),
  internal_cost_amount numeric(14,2),
  gross_margin_amount numeric(14,2),
  gross_margin_pct numeric(5,2),
  line_order_index integer,
  work_unit_id uuid REFERENCES public.roster_work_units(id) ON DELETE SET NULL,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  dispatch_job_id uuid REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  adjustment_type text NOT NULL CHECK (adjustment_type IN ('credit','refund','discount','writeoff','rounding')),
  description text NOT NULL,
  adjustment_amount numeric(14,2) NOT NULL CHECK (adjustment_amount >= 0),
  reason text,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.payment_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  payment_date date NOT NULL,
  payment_amount numeric(14,2) NOT NULL CHECK (payment_amount > 0),
  payment_method text NOT NULL CHECK (payment_method IN ('bank_transfer','credit_card','direct_debit','cheque','cash','other')),
  transaction_reference text,
  bank_account_id uuid REFERENCES public.bank_accounts(id) ON DELETE SET NULL,
  reconciliation_status text NOT NULL DEFAULT 'pending' CHECK (reconciliation_status IN ('pending','matched','unmatched','disputed')),
  bank_statement_reference text,
  reconciled_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reconciled_at timestamptz,
  notes text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_name text NOT NULL,
  account_number text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('business','operating','investment','loan')),
  bank_name text,
  currency_code text NOT NULL DEFAULT 'NZD' CHECK (length(currency_code) = 3),
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, account_number)
);

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY invoice_line_items_select ON public.invoice_line_items FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY invoice_adjustments_select ON public.invoice_adjustments FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY payment_receipts_select ON public.payment_receipts FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY bank_accounts_select ON public.bank_accounts FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.invoice_line_items, public.invoice_adjustments, public.payment_receipts, public.bank_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.invoice_line_items, public.invoice_adjustments, public.payment_receipts, public.bank_accounts TO authenticated;
GRANT ALL ON TABLE public.invoice_line_items, public.invoice_adjustments, public.payment_receipts, public.bank_accounts TO service_role;

CREATE OR REPLACE FUNCTION public.record_payment_receipt(
  p_invoice_id uuid,
  p_payment_date date,
  p_payment_amount numeric,
  p_payment_method text,
  p_bank_account_id uuid DEFAULT NULL,
  p_transaction_reference text DEFAULT NULL
)
RETURNS public.payment_receipts
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_invoice public.invoices%rowtype;
  v_receipt public.payment_receipts%rowtype;
  v_remaining_balance numeric(14,2);
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  
  IF p_payment_amount IS NULL OR p_payment_amount <= 0 THEN RAISE EXCEPTION 'Payment amount must be positive'; END IF;

  SELECT * INTO v_invoice FROM public.invoices WHERE id = p_invoice_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found in organization'; END IF;
  
  SELECT COALESCE(v_invoice.invoice_amount - SUM(payment_amount), v_invoice.invoice_amount) INTO v_remaining_balance
  FROM public.payment_receipts WHERE invoice_id = p_invoice_id;

  IF p_payment_amount > v_remaining_balance + 0.01 THEN 
    RAISE EXCEPTION 'Payment amount (%) exceeds remaining balance (%)', p_payment_amount, v_remaining_balance;
  END IF;

  INSERT INTO public.payment_receipts(
    organization_id, invoice_id, payment_date, payment_amount, payment_method, 
    bank_account_id, transaction_reference, created_by
  )
  VALUES (v_org, p_invoice_id, p_payment_date, p_payment_amount, p_payment_method, p_bank_account_id, p_transaction_reference, v_actor)
  RETURNING * INTO v_receipt;

  UPDATE public.invoices SET updated_at = now() WHERE id = p_invoice_id;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'payment_receipt_recorded', 'payment_receipts', v_receipt.id,
    jsonb_build_object('invoice_id', p_invoice_id, 'payment_amount', p_payment_amount, 'payment_method', p_payment_method, 'transaction_reference', p_transaction_reference));

  RETURN v_receipt;
END;
$$;

CREATE OR REPLACE FUNCTION public.generate_pl_financial_statement(p_pl_period_id uuid)
RETURNS TABLE(
  report_name text,
  period_start date,
  period_end date,
  total_revenue numeric,
  total_labour_cost numeric,
  total_vehicle_cost numeric,
  total_materials_cost numeric,
  total_equipment_cost numeric,
  total_overhead_cost numeric,
  total_depreciation_cost numeric,
  total_operating_cost numeric,
  gross_profit numeric,
  gross_margin_pct numeric,
  cost_breakdown jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%rowtype;
  v_snapshot public.finance_pl_snapshots%rowtype;
  v_report_name text;
  v_revenue numeric;
  v_labour numeric;
  v_vehicle numeric;
  v_materials numeric;
  v_equipment numeric;
  v_overhead numeric;
  v_depreciation numeric;
  v_total_cost numeric;
  v_gross_profit numeric;
  v_margin_pct numeric;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;

  SELECT * INTO v_period FROM public.finance_pl_periods WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;

  SELECT * INTO v_snapshot FROM public.finance_pl_snapshots WHERE pl_period_id = p_pl_period_id;
  IF NOT FOUND THEN 
    SELECT 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0 INTO 
      v_labour, v_vehicle, v_materials, v_equipment, v_overhead, v_depreciation, v_total_cost, 0;
  ELSE
    v_labour := v_snapshot.total_labour;
    v_vehicle := v_snapshot.total_vehicle;
    v_materials := v_snapshot.total_materials;
    v_equipment := v_snapshot.total_equipment;
    v_overhead := v_snapshot.total_overhead;
    v_depreciation := v_snapshot.total_depreciation;
    v_total_cost := v_snapshot.total_cost;
  END IF;

  SELECT COALESCE(SUM(invoice_amount), 0) INTO v_revenue
  FROM public.invoices WHERE organization_id = v_org 
    AND invoice_date >= v_period.period_start AND invoice_date <= v_period.period_end;

  v_gross_profit := v_revenue - v_total_cost;
  v_margin_pct := CASE WHEN v_revenue > 0 THEN ROUND((v_gross_profit / v_revenue) * 100, 2) ELSE 0 END;
  v_report_name := 'P&L Statement ' || v_period.period_start::text || ' to ' || v_period.period_end::text;

  RETURN QUERY
  SELECT 
    v_report_name, v_period.period_start, v_period.period_end,
    v_revenue, v_labour, v_vehicle, v_materials, v_equipment, v_overhead, v_depreciation, v_total_cost,
    v_gross_profit, v_margin_pct,
    jsonb_build_object(
      'labour', v_labour,
      'vehicle', v_vehicle,
      'materials', v_materials,
      'equipment', v_equipment,
      'overhead', v_overhead,
      'depreciation', v_depreciation,
      'total_cost', v_total_cost
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_receipt(uuid,date,numeric,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment_receipt(uuid,date,numeric,text,uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.generate_pl_financial_statement(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_pl_financial_statement(uuid) TO authenticated, service_role;
