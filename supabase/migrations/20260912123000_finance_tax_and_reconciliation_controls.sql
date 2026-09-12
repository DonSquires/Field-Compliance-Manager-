ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS quote_id uuid REFERENCES public.quotes(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS service_cost_id uuid REFERENCES public.finance_service_costs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS finance_item_catalog_id uuid REFERENCES public.finance_item_catalog(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS item_type text,
  ADD COLUMN IF NOT EXISTS unit_of_measure text,
  ADD COLUMN IF NOT EXISTS tax_rate_pct numeric(5,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_line_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS internal_cost_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS gross_margin_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS gross_margin_pct numeric(5,2),
  ADD COLUMN IF NOT EXISTS line_order_index integer,
  ADD COLUMN IF NOT EXISTS work_unit_id uuid REFERENCES public.roster_work_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS dispatch_job_id uuid REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT;

UPDATE public.invoice_line_items
SET total_line_amount = COALESCE(total_line_amount, line_total),
    item_type = COALESCE(item_type, 'other')
WHERE total_line_amount IS NULL OR item_type IS NULL;

ALTER TABLE public.invoice_line_items
  ALTER COLUMN total_line_amount SET DEFAULT 0,
  ALTER COLUMN total_line_amount SET NOT NULL,
  ALTER COLUMN item_type SET DEFAULT 'other',
  ALTER COLUMN item_type SET NOT NULL;

CREATE TABLE IF NOT EXISTS public.finance_tax_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  filing_due_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','prepared','filed','paid','amended','closed')),
  output_tax numeric(14,2) NOT NULL DEFAULT 0,
  input_tax numeric(14,2) NOT NULL DEFAULT 0,
  adjustments numeric(14,2) NOT NULL DEFAULT 0,
  net_tax_due numeric(14,2) NOT NULL DEFAULT 0,
  filed_at timestamptz,
  filed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, period_start, period_end),
  CHECK (period_end >= period_start),
  CHECK (filing_due_date >= period_end)
);

CREATE TABLE IF NOT EXISTS public.finance_tax_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  tax_period_id uuid NOT NULL REFERENCES public.finance_tax_periods(id) ON DELETE RESTRICT,
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE RESTRICT,
  invoice_line_item_id uuid REFERENCES public.invoice_line_items(id) ON DELETE RESTRICT,
  transaction_date date NOT NULL,
  tax_direction text NOT NULL CHECK (tax_direction IN ('output','input','adjustment')),
  tax_code text NOT NULL,
  taxable_amount numeric(14,2) NOT NULL,
  tax_rate_pct numeric(5,2) NOT NULL DEFAULT 15,
  tax_amount numeric(14,2) NOT NULL,
  source_reference text NOT NULL,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finance_bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  statement_date date NOT NULL,
  statement_reference text NOT NULL,
  opening_balance numeric(14,2) NOT NULL,
  closing_balance numeric(14,2) NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  UNIQUE (organization_id, statement_reference)
);

CREATE TABLE IF NOT EXISTS public.finance_bank_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  bank_statement_id uuid NOT NULL REFERENCES public.finance_bank_statements(id) ON DELETE CASCADE,
  transaction_date date NOT NULL,
  description text NOT NULL,
  reference text,
  amount numeric(14,2) NOT NULL,
  transaction_type text NOT NULL CHECK (transaction_type IN ('credit','debit')),
  matched_payment_receipt_id uuid REFERENCES public.payment_receipts(id) ON DELETE SET NULL,
  reconciliation_status text NOT NULL DEFAULT 'unmatched' CHECK (reconciliation_status IN ('unmatched','matched','excluded','review')),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.finance_tax_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_tax_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_bank_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_bank_statement_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY finance_tax_periods_select ON public.finance_tax_periods FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_tax_transactions_select ON public.finance_tax_transactions FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_bank_statements_select ON public.finance_bank_statements FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
CREATE POLICY finance_bank_statement_lines_select ON public.finance_bank_statement_lines FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.finance_tax_periods, public.finance_tax_transactions, public.finance_bank_statements, public.finance_bank_statement_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.finance_tax_periods, public.finance_tax_transactions, public.finance_bank_statements, public.finance_bank_statement_lines TO authenticated;
GRANT ALL ON TABLE public.finance_tax_periods, public.finance_tax_transactions, public.finance_bank_statements, public.finance_bank_statement_lines TO service_role;

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
  SELECT COALESCE(v_invoice.total_amount - SUM(payment_amount), v_invoice.total_amount) INTO v_remaining_balance
  FROM public.payment_receipts WHERE invoice_id = p_invoice_id;
  IF p_payment_amount > v_remaining_balance + 0.01 THEN RAISE EXCEPTION 'Payment amount (%) exceeds remaining balance (%)', p_payment_amount, v_remaining_balance; END IF;
  INSERT INTO public.payment_receipts(organization_id, invoice_id, payment_date, payment_amount, payment_method, bank_account_id, transaction_reference, created_by)
  VALUES (v_org, p_invoice_id, p_payment_date, p_payment_amount, p_payment_method, p_bank_account_id, p_transaction_reference, v_actor)
  RETURNING * INTO v_receipt;
  UPDATE public.invoices SET updated_at = now(), paid_at = CASE WHEN p_payment_amount >= v_remaining_balance - 0.01 THEN now() ELSE paid_at END,
    status = CASE WHEN p_payment_amount >= v_remaining_balance - 0.01 THEN 'paid' ELSE status END WHERE id = p_invoice_id;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'payment_receipt_recorded', 'payment_receipts', v_receipt.id, jsonb_build_object('invoice_id', p_invoice_id, 'payment_amount', p_payment_amount, 'transaction_reference', p_transaction_reference));
  RETURN v_receipt;
END;
$$;

CREATE OR REPLACE FUNCTION public.match_finance_bank_statement_line(p_statement_line_id uuid, p_payment_receipt_id uuid)
RETURNS public.finance_bank_statement_lines
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_line public.finance_bank_statement_lines%rowtype;
  v_payment public.payment_receipts%rowtype;
BEGIN
  SELECT organization_id INTO v_org FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN RAISE EXCEPTION 'Active finance administrator required'; END IF;
  SELECT * INTO v_line FROM public.finance_bank_statement_lines WHERE id = p_statement_line_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank statement line not found in organization'; END IF;
  SELECT * INTO v_payment FROM public.payment_receipts WHERE id = p_payment_receipt_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment receipt not found in organization'; END IF;
  IF abs(abs(v_line.amount) - v_payment.payment_amount) > 0.01 THEN RAISE EXCEPTION 'Statement amount does not match payment receipt'; END IF;
  UPDATE public.finance_bank_statement_lines SET matched_payment_receipt_id = p_payment_receipt_id, reconciliation_status = 'matched' WHERE id = p_statement_line_id RETURNING * INTO v_line;
  UPDATE public.payment_receipts SET reconciliation_status = 'matched', bank_statement_reference = v_line.reference, reconciled_by = v_actor, reconciled_at = now() WHERE id = p_payment_receipt_id;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_bank_statement_line_matched', 'finance_bank_statement_lines', v_line.id, jsonb_build_object('payment_receipt_id', p_payment_receipt_id));
  RETURN v_line;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_finance_tax_period(p_tax_period_id uuid)
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
  SELECT * INTO v_period FROM public.finance_tax_periods WHERE id = p_tax_period_id AND organization_id = v_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax period not found in organization'; END IF;
  IF v_period.status NOT IN ('open','prepared') THEN RAISE EXCEPTION 'Tax period cannot be prepared from its current status'; END IF;
  SELECT COALESCE(SUM(CASE WHEN tax_direction = 'output' THEN tax_amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN tax_direction = 'input' THEN tax_amount ELSE 0 END), 0),
         COALESCE(SUM(CASE WHEN tax_direction = 'adjustment' THEN tax_amount ELSE 0 END), 0)
  INTO v_period.output_tax, v_period.input_tax, v_period.adjustments
  FROM public.finance_tax_transactions WHERE tax_period_id = p_tax_period_id AND organization_id = v_org;
  v_period.net_tax_due := v_period.output_tax - v_period.input_tax + v_period.adjustments;
  v_period.status := 'prepared';
  UPDATE public.finance_tax_periods SET output_tax = v_period.output_tax, input_tax = v_period.input_tax, adjustments = v_period.adjustments, net_tax_due = v_period.net_tax_due, status = v_period.status WHERE id = p_tax_period_id RETURNING * INTO v_period;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_actor, 'finance_tax_period_prepared', 'finance_tax_periods', v_period.id, jsonb_build_object('output_tax', v_period.output_tax, 'input_tax', v_period.input_tax, 'adjustments', v_period.adjustments, 'net_tax_due', v_period.net_tax_due));
  RETURN v_period;
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_receipt(uuid,date,numeric,text,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_payment_receipt(uuid,date,numeric,text,uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_finance_bank_statement_line(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_finance_bank_statement_line(uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.prepare_finance_tax_period(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prepare_finance_tax_period(uuid) TO authenticated, service_role;
