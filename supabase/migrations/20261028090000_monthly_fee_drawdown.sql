-- Monthly fee drawdown (owner ruling 2026-10-25).
--
-- A fixed monthly fee is the value of the contracted service. Every contracted job or action
-- charged to the client draws that fee down, so at the end of the month the balance should be 0.
--   * Work below the fee: the unused value is credited on the month's invoice (negative line).
--   * Work above the fee: the excess is Extra. It is billed only when it is justified on the
--     invoice, or when the agreement already pre-agrees it (OneFortyOne). Otherwise R&M absorbs it.
-- Applies to agreements billed fixed price plus Extra. Other models are unchanged.
--
-- Sources of contracted work for one calendar month (each shown separately, never merged):
--   imported patrol rows (file_import_finance_cost_rows, applied, classified Contract),
--   callout charge lines classified Contract, and patrol visit charge lines.
-- A month cannot be settled while it is unfinished or any of its work is undecided or unpriced.

-- A. What happens to work above the fee.
ALTER TABLE public.crm_commercial_settings
  ADD COLUMN IF NOT EXISTS fee_overrun_policy text;
ALTER TABLE public.crm_commercial_settings
  DROP CONSTRAINT IF EXISTS crm_commercial_settings_fee_overrun_policy_check;
ALTER TABLE public.crm_commercial_settings
  ADD CONSTRAINT crm_commercial_settings_fee_overrun_policy_check
  CHECK (fee_overrun_policy IS NULL OR fee_overrun_policy IN ('bill_as_extra', 'justify'));
COMMENT ON COLUMN public.crm_commercial_settings.fee_overrun_policy IS
  'Fixed price plus Extra only: what happens when contracted work in a month is worth more than the monthly fee. bill_as_extra = pre-agreed with the client, the excess is billed as Extra; justify (or NULL) = the excess is billed only with a written justification on the invoice, otherwise absorbed.';

-- B. One settlement per agreement per month, written with the invoice that settles it.
CREATE TABLE IF NOT EXISTS public.agreement_fee_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  client_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  service_agreement_id uuid NOT NULL REFERENCES public.service_agreements(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  fee_amount numeric(12,2) NOT NULL CHECK (fee_amount > 0),
  imported_contract_amount numeric(12,2) NOT NULL DEFAULT 0,
  callout_contract_amount numeric(12,2) NOT NULL DEFAULT 0,
  patrol_visit_amount numeric(12,2) NOT NULL DEFAULT 0,
  contract_work_amount numeric(12,2) NOT NULL,
  balance numeric(12,2) NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('credit', 'overrun_billed', 'overrun_absorbed', 'balanced')),
  adjustment_amount numeric(12,2) NOT NULL DEFAULT 0,
  overrun_policy text CHECK (overrun_policy IS NULL OR overrun_policy IN ('bill_as_extra', 'justify')),
  overrun_decision text CHECK (overrun_decision IS NULL OR overrun_decision IN ('bill_as_extra', 'absorb')),
  justification text CHECK (justification IS NULL OR char_length(justification) BETWEEN 10 AND 500),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agreement_fee_settlements_whole_month_check
    CHECK (period_start = date_trunc('month', period_start)::date
       AND period_end = (date_trunc('month', period_start) + interval '1 month - 1 day')::date),
  CONSTRAINT agreement_fee_settlements_balance_check CHECK (balance = fee_amount - contract_work_amount),
  CONSTRAINT agreement_fee_settlements_month_key UNIQUE (service_agreement_id, period_start)
);
CREATE INDEX IF NOT EXISTS agreement_fee_settlements_invoice_idx ON public.agreement_fee_settlements (invoice_id);
CREATE INDEX IF NOT EXISTS agreement_fee_settlements_org_idx ON public.agreement_fee_settlements (organization_id, period_start);
COMMENT ON TABLE public.agreement_fee_settlements IS
  'Monthly fee drawdown: one row per fixed price plus Extra agreement per calendar month, written by generate_crm_invoice_from_agreement with the invoice that settles it. balance = fee - contracted work; a positive balance is credited (adjustment negative), a negative balance is billed as Extra (adjustment positive) or absorbed. A void invoice frees the month to be settled again. Written only by the invoice generator.';

ALTER TABLE public.agreement_fee_settlements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agreement_fee_settlements_provider_admin_select ON public.agreement_fee_settlements;
CREATE POLICY agreement_fee_settlements_provider_admin_select ON public.agreement_fee_settlements
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id));
REVOKE ALL ON TABLE public.agreement_fee_settlements FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.agreement_fee_settlements TO authenticated;
GRANT ALL ON TABLE public.agreement_fee_settlements TO service_role;

-- C. The drawdown for one agreement and one calendar month (internal).
CREATE OR REPLACE FUNCTION public.agreement_fee_drawdown_month(p_service_agreement_id uuid, p_month date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agreement public.service_agreements%ROWTYPE;
  v_comm public.crm_commercial_settings%ROWTYPE;
  v_start date := date_trunc('month', p_month)::date;
  v_end date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
  v_today date := (now() AT TIME ZONE 'Pacific/Auckland')::date;
  v_label text := to_char(date_trunc('month', p_month), 'FMMonth YYYY');
  v_fee numeric(12,2);
  v_fee_source text;
  v_quote_lines integer;
  v_imported record;
  v_callout record;
  v_patrol record;
  v_work numeric(12,2);
  v_balance numeric(12,2);
  v_blockers jsonb := '[]'::jsonb;
  v_settlement jsonb;
BEGIN
  IF p_month IS NULL THEN RAISE EXCEPTION 'Choose a month'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  SELECT * INTO v_comm FROM public.crm_commercial_settings WHERE service_agreement_id = v_agreement.id;

  SELECT count(*)::integer, round(coalesce(sum(ql.quantity * ql.unit_charge), 0), 2)
    INTO v_quote_lines, v_fee
  FROM public.quotes q JOIN public.quote_lines ql ON ql.quote_id = q.id
  WHERE q.service_agreement_id = v_agreement.id AND q.status = 'accepted';
  IF v_quote_lines > 0 THEN
    v_fee_source := 'accepted_quote';
  ELSIF coalesce(v_comm.base_rate_per_hour, 0) > 0 THEN
    v_fee := v_comm.base_rate_per_hour; v_fee_source := 'agreement_rate';
  ELSE
    v_fee := NULL;
  END IF;

  SELECT count(*)::integer AS rows_total,
    round(coalesce(sum(r.amount) FILTER (WHERE c.basis = 'contract'), 0), 2) AS contract_amount,
    count(*) FILTER (WHERE c.basis = 'contract')::integer AS contract_rows,
    round(coalesce(sum(r.amount) FILTER (WHERE c.basis = 'extra'), 0), 2) AS extra_amount,
    count(*) FILTER (WHERE c.basis = 'unclassified')::integer AS unclassified_rows,
    round(coalesce(sum(r.amount) FILTER (WHERE c.basis = 'unclassified'), 0), 2) AS unclassified_amount
    INTO v_imported
  FROM public.file_import_finance_cost_rows r
  CROSS JOIN LATERAL public.classify_patrol_cost_row_billing_basis(v_agreement.provider_organization_id, r.source_values) c
  WHERE r.service_agreement_id = v_agreement.id AND r.status = 'applied' AND r.service_date BETWEEN v_start AND v_end;

  SELECT count(*)::integer AS lines_total,
    round(coalesce(sum(l.line_total) FILTER (WHERE l.billing_basis = 'contract'), 0), 2) AS contract_amount,
    count(*) FILTER (WHERE l.billing_basis = 'contract')::integer AS contract_lines,
    count(*) FILTER (WHERE l.billing_basis IS NULL)::integer AS undecided_lines,
    count(*) FILTER (WHERE l.rate_rule_id IS NULL AND coalesce(l.billing_basis, 'contract') = 'contract')::integer AS unpriced_lines
    INTO v_callout
  FROM public.dispatch_job_charge_lines l
  WHERE l.service_agreement_id = v_agreement.id
    AND (l.created_at AT TIME ZONE 'Pacific/Auckland')::date BETWEEN v_start AND v_end;

  SELECT count(*)::integer AS lines_total,
    round(coalesce(sum(l.line_total) FILTER (WHERE l.status IN ('ready', 'waived_sla', 'invoiced')), 0), 2) AS amount,
    count(*) FILTER (WHERE l.status IN ('ready', 'waived_sla', 'invoiced'))::integer AS visits,
    count(*) FILTER (WHERE l.status LIKE 'unresolved%')::integer AS unresolved_lines
    INTO v_patrol
  FROM public.patrol_stop_charge_lines l
  WHERE l.service_agreement_id = v_agreement.id
    AND (l.created_at AT TIME ZONE 'Pacific/Auckland')::date BETWEEN v_start AND v_end;

  v_work := v_imported.contract_amount + v_callout.contract_amount + v_patrol.amount;
  v_balance := CASE WHEN v_fee IS NOT NULL THEN v_fee - v_work END;

  IF v_fee IS NULL THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'no_fee', 'message',
      'No monthly fee is recorded for this agreement. Record it as an accepted quote line before settling a month.');
  END IF;
  IF v_end >= v_today THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'month_not_finished', 'message',
      format('%s has not finished. A month is settled once it is over.', v_label));
  END IF;
  IF v_imported.unclassified_rows > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'unclassified_imported_rows', 'message',
      format('%s imported patrol row(s) worth %s in %s are not marked Contract or Extra. Give their charge codes a billing basis first.',
        v_imported.unclassified_rows, to_char(v_imported.unclassified_amount, 'FM$999,999,990.00'), v_label));
  END IF;
  IF v_callout.undecided_lines > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'undecided_callouts', 'message',
      format('%s callout charge line(s) in %s have no Contract or Extra decision.', v_callout.undecided_lines, v_label));
  END IF;
  IF v_callout.unpriced_lines > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'unpriced_callouts', 'message',
      format('%s contracted callout charge line(s) in %s have no rate. Price them first.', v_callout.unpriced_lines, v_label));
  END IF;
  IF v_patrol.unresolved_lines > 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'unresolved_patrol_visits', 'message',
      format('%s patrol visit charge line(s) in %s have no rate or agreement.', v_patrol.unresolved_lines, v_label));
  END IF;
  IF v_imported.rows_total = 0 AND v_callout.lines_total = 0 AND v_patrol.lines_total = 0 THEN
    v_blockers := v_blockers || jsonb_build_object('code', 'no_work_recorded', 'message',
      format('No work is recorded for %s. Import or record the month''s work first, otherwise the whole fee would be credited.', v_label));
  END IF;

  SELECT jsonb_build_object('id', s.id, 'outcome', s.outcome, 'adjustment_amount', s.adjustment_amount,
      'overrun_decision', s.overrun_decision, 'justification', s.justification, 'invoice_id', i.id,
      'invoice_number', i.invoice_number, 'invoice_status', i.status, 'created_at', s.created_at)
    INTO v_settlement
  FROM public.agreement_fee_settlements s JOIN public.invoices i ON i.id = s.invoice_id
  WHERE s.service_agreement_id = v_agreement.id AND s.period_start = v_start AND i.status <> 'void';

  RETURN jsonb_build_object(
    'month', to_char(v_start, 'YYYY-MM'), 'label', v_label, 'period_start', v_start, 'period_end', v_end,
    'fee', v_fee, 'fee_source', v_fee_source,
    'contract_work', jsonb_build_object(
      'imported', jsonb_build_object('amount', v_imported.contract_amount, 'rows', v_imported.contract_rows,
        'extra_amount', v_imported.extra_amount, 'unclassified_rows', v_imported.unclassified_rows,
        'unclassified_amount', v_imported.unclassified_amount),
      'callouts', jsonb_build_object('amount', v_callout.contract_amount, 'lines', v_callout.contract_lines,
        'undecided_lines', v_callout.undecided_lines, 'unpriced_lines', v_callout.unpriced_lines),
      'patrol_visits', jsonb_build_object('amount', v_patrol.amount, 'lines', v_patrol.visits,
        'unresolved_lines', v_patrol.unresolved_lines),
      'total', v_work),
    'balance', v_balance,
    'outcome', CASE WHEN v_balance IS NULL THEN NULL WHEN v_balance > 0 THEN 'credit' WHEN v_balance < 0 THEN 'overrun' ELSE 'balanced' END,
    'overrun_policy', coalesce(v_comm.fee_overrun_policy, 'justify'),
    'blockers', v_blockers,
    'settlement', v_settlement);
END;
$function$;
COMMENT ON FUNCTION public.agreement_fee_drawdown_month(uuid, date) IS
  'Internal: the monthly fee drawdown for one agreement and calendar month: fee (accepted quote lines, else the agreement rate), contracted work by source (imported patrol rows classified Contract, Contract callout charge lines, patrol visit charge lines; NZ dates), balance = fee - work, the outcome it would produce, what blocks settling it, and the existing non-void settlement.';
REVOKE ALL ON FUNCTION public.agreement_fee_drawdown_month(uuid, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agreement_fee_drawdown_month(uuid, date) TO postgres;

-- D. Read-only month list for the provider administrator.
CREATE OR REPLACE FUNCTION public.get_agreement_fee_drawdown(p_service_agreement_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agreement public.service_agreements%ROWTYPE;
  v_comm public.crm_commercial_settings%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'Pacific/Auckland')::date;
  v_to date := date_trunc('month', coalesce(p_to, v_today))::date;
  v_from date := date_trunc('month', coalesce(p_from, (coalesce(p_to, v_today) - interval '11 months')::date))::date;
  v_months jsonb := '[]'::jsonb;
  v_month date;
  v_first jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Finance administrator access required'; END IF;
  IF v_to < v_from THEN RAISE EXCEPTION 'Period end cannot precede period start'; END IF;
  IF v_from < (v_to - interval '35 months')::date THEN RAISE EXCEPTION 'Choose up to 36 months'; END IF;
  SELECT * INTO v_comm FROM public.crm_commercial_settings WHERE service_agreement_id = v_agreement.id;

  IF coalesce(v_comm.commercial_model, '') = 'fixed_price_with_extras' THEN
    v_month := v_to;
    WHILE v_month >= v_from LOOP
      v_months := v_months || public.agreement_fee_drawdown_month(v_agreement.id, v_month);
      v_month := (v_month - interval '1 month')::date;
    END LOOP;
  END IF;
  v_first := v_months->0;

  RETURN jsonb_build_object(
    'service_agreement_id', v_agreement.id,
    'commercial_model', v_comm.commercial_model,
    'applies', coalesce(v_comm.commercial_model, '') = 'fixed_price_with_extras',
    'fee', v_first->'fee', 'fee_source', v_first->'fee_source',
    'overrun_policy', CASE WHEN coalesce(v_comm.commercial_model, '') = 'fixed_price_with_extras' THEN coalesce(v_comm.fee_overrun_policy, 'justify') END,
    'period_from', v_from, 'period_to', (v_to + interval '1 month - 1 day')::date,
    'months', v_months);
END;
$function$;
COMMENT ON FUNCTION public.get_agreement_fee_drawdown(uuid, date, date) IS
  'Read-only, provider-admin only: for a fixed price plus Extra agreement, the monthly fee drawdown per calendar month (newest first, default the last 12, up to 36): fee, contracted work by source, balance, credit/overrun/balanced, blockers and the settling invoice. applies is false (no months) for other billing models.';
REVOKE ALL ON FUNCTION public.get_agreement_fee_drawdown(uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agreement_fee_drawdown(uuid, date, date) TO postgres, authenticated, service_role;

-- E. The agreement invoice settles the month for fixed price plus Extra agreements.
DROP FUNCTION IF EXISTS public.generate_crm_invoice_from_agreement(uuid, uuid, date, date);
CREATE OR REPLACE FUNCTION public.generate_crm_invoice_from_agreement(p_client_request_id uuid, p_service_agreement_id uuid, p_service_period_start date, p_service_period_end date, p_overrun_decision text DEFAULT NULL::text, p_overrun_justification text DEFAULT NULL::text)
 RETURNS TABLE(invoice_id uuid, invoice_number text, client_organization_id uuid, subtotal numeric, gst_amount numeric, total_amount numeric, line_item_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%ROWTYPE;
  v_invoice public.invoices%ROWTYPE;
  v_inv_number text;
  v_count integer := 0;
  v_qline record;
  v_comm public.crm_commercial_settings%ROWTYPE;
  v_drawdown jsonb;
  v_settlement public.agreement_fee_settlements%ROWTYPE;
  v_fee numeric(12,2);
  v_work numeric(12,2);
  v_balance numeric(12,2);
  v_policy text;
  v_decision text := nullif(btrim(coalesce(p_overrun_decision, '')), '');
  v_justification text := nullif(btrim(coalesce(p_overrun_justification, '')), '');
  v_outcome text;
  v_adjustment numeric(12,2) := 0;
  v_label text;
  v_money_fee text;
  v_money_work text;
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Not authorised to invoice for this agreement'; END IF;
  IF v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_finance_enabled THEN
    RAISE EXCEPTION 'Client approval or an active finance-share invite is required before invoicing this agreement';
  END IF;
  IF p_service_period_start IS NULL OR p_service_period_end IS NULL THEN RAISE EXCEPTION 'Choose the service period'; END IF;
  IF p_service_period_end < p_service_period_start THEN RAISE EXCEPTION 'Service period end cannot precede service period start'; END IF;
  IF v_decision IS NOT NULL AND v_decision NOT IN ('bill_as_extra', 'absorb') THEN
    RAISE EXCEPTION 'Work above the monthly fee is either billed as Extra or absorbed';
  END IF;
  SELECT * INTO v_comm FROM public.crm_commercial_settings WHERE service_agreement_id = v_agreement.id;

  IF coalesce(v_comm.commercial_model, '') = 'fixed_price_with_extras' THEN
    IF p_service_period_start <> date_trunc('month', p_service_period_start)::date
       OR p_service_period_end <> (date_trunc('month', p_service_period_start) + interval '1 month - 1 day')::date THEN
      RAISE EXCEPTION 'A fixed monthly fee is settled one whole calendar month at a time';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('agreement_fee_settlement:' || v_agreement.id::text || ':' || p_service_period_start::text, 0));

    -- Same request again: return the invoice it already made.
    SELECT s.* INTO v_settlement FROM public.agreement_fee_settlements s
    WHERE s.service_agreement_id = v_agreement.id AND s.period_start = p_service_period_start AND s.client_request_id = p_client_request_id;
    IF FOUND THEN
      RETURN QUERY SELECT i.id, i.invoice_number, i.client_organization_id, i.subtotal, i.gst_amount, i.total_amount,
        (SELECT count(*)::integer FROM public.invoice_line_items li WHERE li.invoice_id = i.id)
      FROM public.invoices i WHERE i.id = v_settlement.invoice_id;
      RETURN;
    END IF;

    v_drawdown := public.agreement_fee_drawdown_month(v_agreement.id, p_service_period_start);
    IF v_drawdown->'settlement' <> 'null'::jsonb THEN
      RAISE EXCEPTION '% is already settled on invoice % (%). Void that invoice to settle the month again.',
        v_drawdown->>'label', v_drawdown->'settlement'->>'invoice_number', v_drawdown->'settlement'->>'invoice_status';
    END IF;
    IF jsonb_array_length(v_drawdown->'blockers') > 0 THEN
      RAISE EXCEPTION '%', v_drawdown->'blockers'->0->>'message';
    END IF;
    -- A voided settlement frees the month.
    DELETE FROM public.agreement_fee_settlements s
    WHERE s.service_agreement_id = v_agreement.id AND s.period_start = p_service_period_start;

    v_fee := (v_drawdown->>'fee')::numeric;
    v_work := (v_drawdown->'contract_work'->>'total')::numeric;
    v_balance := v_fee - v_work;
    v_policy := v_drawdown->>'overrun_policy';
    v_label := v_drawdown->>'label';
    v_money_fee := to_char(v_fee, 'FM$999,999,990.00');
    v_money_work := to_char(v_work, 'FM$999,999,990.00');

    IF v_balance > 0 THEN
      v_outcome := 'credit'; v_adjustment := -v_balance; v_decision := NULL; v_justification := NULL;
    ELSIF v_balance = 0 THEN
      v_outcome := 'balanced'; v_decision := NULL; v_justification := NULL;
    ELSE
      v_decision := coalesce(v_decision, CASE WHEN v_policy = 'bill_as_extra' THEN 'bill_as_extra' END);
      IF v_decision IS NULL THEN
        RAISE EXCEPTION 'Contracted work in % (%) is % above the monthly fee (%). Bill the excess as Extra with a justification, or absorb it.',
          v_label, v_money_work, to_char(-v_balance, 'FM$999,999,990.00'), v_money_fee;
      END IF;
      IF v_decision = 'bill_as_extra' THEN
        IF v_policy <> 'bill_as_extra' AND char_length(coalesce(v_justification, '')) NOT BETWEEN 10 AND 500 THEN
          RAISE EXCEPTION 'Say why the client should pay for work above the monthly fee (10 to 500 characters)';
        END IF;
        v_outcome := 'overrun_billed'; v_adjustment := -v_balance;
      ELSE
        v_outcome := 'overrun_absorbed';
      END IF;
      IF v_justification IS NOT NULL AND char_length(v_justification) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'A justification is 10 to 500 characters';
      END IF;
    END IF;
  ELSIF v_decision IS NOT NULL OR v_justification IS NOT NULL THEN
    RAISE EXCEPTION 'Only a fixed price plus Extra agreement settles work against a monthly fee';
  END IF;

  SELECT 'INV-'||to_char(now(),'YYYYMMDD')||'-'||upper(substring(gen_random_uuid()::text,1,4)) INTO v_inv_number;
  INSERT INTO public.invoices(organization_id,client_organization_id,service_agreement_id,invoice_number,invoice_date,due_date,status,service_period_start,service_period_end,created_by)
  VALUES(v_agreement.provider_organization_id,v_agreement.client_organization_id,v_agreement.id,v_inv_number,current_date,public.invoice_due_date(current_date,p_service_period_end,v_comm.payment_terms_days,v_comm.payment_due_day_of_month),'draft',p_service_period_start,p_service_period_end,v_actor) RETURNING * INTO v_invoice;
  FOR v_qline IN SELECT line.description,line.quantity,line.unit_charge FROM public.quotes quote JOIN public.quote_lines line ON line.quote_id=quote.id WHERE quote.service_agreement_id=v_agreement.id AND quote.status='accepted' ORDER BY line.line_order, line.created_at LOOP
    v_count:=v_count+1; INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id) VALUES(v_invoice.id,v_count,v_qline.description,v_qline.quantity,v_qline.unit_charge,round(v_qline.quantity*v_qline.unit_charge,2),v_invoice.organization_id);
  END LOOP;
  IF v_count=0 THEN
    IF v_comm.id IS NOT NULL AND v_comm.base_rate_per_hour IS NOT NULL AND v_comm.base_rate_per_hour>0 THEN
      v_count:=1; INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id) VALUES(v_invoice.id,1,'Service Agreement Base Retainer',1,v_comm.base_rate_per_hour,v_comm.base_rate_per_hour,v_invoice.organization_id);
    ELSE RAISE EXCEPTION 'Commercial configuration incomplete: an accepted quote line or positive agreement rate is required before invoicing'; END IF;
  END IF;

  IF v_outcome IS NOT NULL THEN
    IF v_outcome = 'credit' THEN
      v_count := v_count + 1;
      INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id)
      VALUES (v_invoice.id, v_count,
        format('Credit — contracted work not used in %s (monthly fee %s, contracted work done %s)', v_label, v_money_fee, v_money_work),
        1, v_adjustment, v_adjustment, v_invoice.organization_id);
    ELSIF v_outcome = 'overrun_billed' THEN
      v_count := v_count + 1;
      INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id)
      VALUES (v_invoice.id, v_count,
        format('Extra — contracted work above the monthly fee in %s (monthly fee %s, contracted work done %s)', v_label, v_money_fee, v_money_work)
          || CASE WHEN v_justification IS NOT NULL THEN ' — ' || v_justification
                  WHEN v_policy = 'bill_as_extra' THEN ' — as agreed with the client' ELSE '' END,
        1, v_adjustment, v_adjustment, v_invoice.organization_id);
    END IF;
    INSERT INTO public.agreement_fee_settlements (organization_id, client_organization_id, service_agreement_id, period_start, period_end,
      fee_amount, imported_contract_amount, callout_contract_amount, patrol_visit_amount, contract_work_amount, balance, outcome,
      adjustment_amount, overrun_policy, overrun_decision, justification, invoice_id, client_request_id, created_by)
    VALUES (v_agreement.provider_organization_id, v_agreement.client_organization_id, v_agreement.id, p_service_period_start, p_service_period_end,
      v_fee, (v_drawdown->'contract_work'->'imported'->>'amount')::numeric, (v_drawdown->'contract_work'->'callouts'->>'amount')::numeric,
      (v_drawdown->'contract_work'->'patrol_visits'->>'amount')::numeric, v_work, v_balance, v_outcome,
      v_adjustment, v_policy, v_decision, v_justification, v_invoice.id, p_client_request_id, v_actor)
    RETURNING * INTO v_settlement;
  END IF;

  UPDATE public.invoices invoice SET subtotal=totals.subtotal,gst_amount=round(totals.subtotal*.15,2),total_amount=round(totals.subtotal*1.15,2),updated_at=now() FROM (SELECT coalesce(sum(line.line_total),0)::numeric(12,2) subtotal FROM public.invoice_line_items line WHERE line.invoice_id=v_invoice.id) totals WHERE invoice.id=v_invoice.id RETURNING invoice.* INTO v_invoice;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_invoice.organization_id,v_actor,'crm_invoice_generated_from_agreement','invoices',v_invoice.id,
    jsonb_strip_nulls(jsonb_build_object('service_agreement_id',v_agreement.id,'invoice_number',v_invoice.invoice_number,'subtotal',v_invoice.subtotal,'total_amount',v_invoice.total_amount,'line_item_count',v_count,'client_request_id',p_client_request_id,'due_date',v_invoice.due_date,
      'fee_drawdown', CASE WHEN v_outcome IS NOT NULL THEN jsonb_build_object('settlement_id', v_settlement.id, 'month', v_drawdown->>'month',
        'fee', v_fee, 'contract_work', v_drawdown->'contract_work', 'balance', v_balance, 'outcome', v_outcome,
        'adjustment_amount', v_adjustment, 'overrun_policy', v_policy, 'overrun_decision', v_decision, 'justification', v_justification) END)));
  RETURN QUERY SELECT v_invoice.id,v_invoice.invoice_number,v_invoice.client_organization_id,v_invoice.subtotal,v_invoice.gst_amount,v_invoice.total_amount,v_count;
EXCEPTION WHEN OTHERS THEN
  IF v_invoice.id IS NOT NULL THEN DELETE FROM public.invoices WHERE id=v_invoice.id; END IF;
  RAISE;
END; $function$;
COMMENT ON FUNCTION public.generate_crm_invoice_from_agreement(uuid, uuid, date, date, text, text) IS
  'Provider administrator raises the agreement-price invoice (accepted quote lines, else the agreement rate as a base retainer), due by the agreement payment terms. For fixed price plus Extra the period is one whole calendar month and the invoice settles the monthly fee drawdown (agreement_fee_drawdown_month): unused contract value is credited as a negative line; contracted work above the fee is billed as an Extra line when the agreement pre-agrees it (fee_overrun_policy bill_as_extra) or with a 10-500 character justification, otherwise it must be explicitly absorbed. Refuses an unfinished, undecided, unpriced or already settled month. Writes agreement_fee_settlements; idempotent on client_request_id for a settled month; audited.';
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_agreement(uuid, uuid, date, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_agreement(uuid, uuid, date, date, text, text) TO postgres, authenticated, service_role;

-- F. Patched from the live definitions (supabase/schema.sql).
-- Terms: fee_overrun_policy is a fixed price plus Extra term, validated and audited like the others.
CREATE OR REPLACE FUNCTION "public"."set_agreement_commercial_terms"(p_service_agreement_id uuid, p_commercial_model text, p_terms jsonb DEFAULT '{}'::jsonb, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%ROWTYPE;
  v_before public.crm_commercial_settings%ROWTYPE;
  v_after public.crm_commercial_settings%ROWTYPE;
  v_terms jsonb := coalesce(p_terms, '{}'::jsonb);
  v_unknown text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_has_before boolean;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Only an administrator of the provider can set billing terms';
  END IF;
  IF p_commercial_model IS NULL OR p_commercial_model NOT IN ('fixed_price_with_extras', 'pay_as_you_go', 'do_and_invoice', 'per_request') THEN
    RAISE EXCEPTION 'Choose how this client is billed: fixed price plus Extra, pay as you go, do and invoice, or per request';
  END IF;
  IF jsonb_typeof(v_terms) <> 'object' THEN RAISE EXCEPTION 'Billing terms must be an object'; END IF;
  SELECT k INTO v_unknown FROM jsonb_object_keys(v_terms) k
  WHERE k NOT IN ('billing_cycle', 'payment_terms_days', 'invoice_email', 'purchase_order_number', 'notes',
                  'base_rate_per_hour', 'overtime_rate_per_hour', 'callout_rate_per_hour', 'callout_minimum_hours', 'travel_rate_per_km',
                  'standing_authority_limit', 'payment_due_day_of_month', 'fee_overrun_policy')
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Unknown billing term: %', v_unknown; END IF;
  IF v_terms ? 'billing_cycle' AND (v_terms->>'billing_cycle') NOT IN ('weekly', 'fortnightly', 'monthly', 'quarterly') THEN
    RAISE EXCEPTION 'Billing cycle must be weekly, fortnightly, monthly or quarterly';
  END IF;
  IF v_terms ? 'payment_terms_days' AND ((v_terms->>'payment_terms_days') !~ '^\d{1,3}$' OR (v_terms->>'payment_terms_days')::integer > 120) THEN
    RAISE EXCEPTION 'Payment terms must be a whole number of days from 0 to 120';
  END IF;
  IF v_terms ? 'payment_due_day_of_month' AND v_terms->>'payment_due_day_of_month' IS NOT NULL
     AND ((v_terms->>'payment_due_day_of_month') !~ '^\d{1,2}$' OR (v_terms->>'payment_due_day_of_month')::integer NOT BETWEEN 1 AND 28) THEN
    RAISE EXCEPTION 'The payment due day must be a day of the month from 1 to 28';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(v_terms) e
             WHERE e.key IN ('base_rate_per_hour', 'overtime_rate_per_hour', 'callout_rate_per_hour', 'callout_minimum_hours', 'travel_rate_per_km')
               AND e.value IS NOT NULL AND e.value !~ '^\d{1,7}(\.\d{1,4})?$') THEN
    RAISE EXCEPTION 'Rates and minimum hours must be zero or a positive number';
  END IF;
  IF v_terms ? 'invoice_email' AND nullif(btrim(v_terms->>'invoice_email'), '') IS NOT NULL
     AND btrim(v_terms->>'invoice_email') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'Invoice email is not a valid email address';
  END IF;
  IF v_terms ? 'standing_authority_limit' AND v_terms->>'standing_authority_limit' IS NOT NULL THEN
    IF p_commercial_model <> 'do_and_invoice' THEN
      RAISE EXCEPTION 'A standing authority limit only applies to do and invoice agreements';
    END IF;
    IF (v_terms->>'standing_authority_limit') !~ '^\d{1,10}(\.\d{1,2})?$' THEN
      RAISE EXCEPTION 'The standing authority limit must be zero or a positive amount (up to 2 decimals)';
    END IF;
  END IF;
  IF v_terms ? 'fee_overrun_policy' AND v_terms->>'fee_overrun_policy' IS NOT NULL THEN
    IF p_commercial_model <> 'fixed_price_with_extras' THEN
      RAISE EXCEPTION 'What happens to work above the monthly fee only applies to fixed price plus Extra agreements';
    END IF;
    IF (v_terms->>'fee_overrun_policy') NOT IN ('bill_as_extra', 'justify') THEN
      RAISE EXCEPTION 'Work above the monthly fee is either pre-agreed as Extra (bill_as_extra) or needs a justification (justify)';
    END IF;
  END IF;
  IF v_terms ? 'notes' AND char_length(coalesce(v_terms->>'notes', '')) > 2000 THEN RAISE EXCEPTION 'Notes are limited to 2000 characters'; END IF;
  IF v_terms ? 'purchase_order_number' AND char_length(coalesce(v_terms->>'purchase_order_number', '')) > 120 THEN RAISE EXCEPTION 'Purchase order number is limited to 120 characters'; END IF;

  SELECT * INTO v_before FROM public.crm_commercial_settings WHERE service_agreement_id = v_agreement.id FOR UPDATE;
  v_has_before := FOUND;
  IF v_has_before AND v_before.commercial_model IS NOT NULL AND v_before.commercial_model <> p_commercial_model
     AND char_length(coalesce(v_reason, '')) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Say why the billing model is changing (3 to 500 characters)';
  END IF;

  INSERT INTO public.crm_commercial_settings AS c (service_agreement_id, commercial_model, updated_at)
  VALUES (v_agreement.id, p_commercial_model, now())
  ON CONFLICT (service_agreement_id) DO UPDATE SET commercial_model = EXCLUDED.commercial_model,
    standing_authority_limit = CASE WHEN EXCLUDED.commercial_model = 'do_and_invoice' THEN c.standing_authority_limit END,
    fee_overrun_policy = CASE WHEN EXCLUDED.commercial_model = 'fixed_price_with_extras' THEN c.fee_overrun_policy END,
    updated_at = now();

  UPDATE public.crm_commercial_settings c SET
    billing_cycle = CASE WHEN v_terms ? 'billing_cycle' THEN v_terms->>'billing_cycle' ELSE c.billing_cycle END,
    payment_terms_days = CASE WHEN v_terms ? 'payment_terms_days' THEN (v_terms->>'payment_terms_days')::integer ELSE c.payment_terms_days END,
    payment_due_day_of_month = CASE WHEN v_terms ? 'payment_due_day_of_month' THEN (v_terms->>'payment_due_day_of_month')::smallint ELSE c.payment_due_day_of_month END,
    invoice_email = CASE WHEN v_terms ? 'invoice_email' THEN nullif(btrim(v_terms->>'invoice_email'), '') ELSE c.invoice_email END,
    purchase_order_number = CASE WHEN v_terms ? 'purchase_order_number' THEN nullif(btrim(v_terms->>'purchase_order_number'), '') ELSE c.purchase_order_number END,
    notes = CASE WHEN v_terms ? 'notes' THEN nullif(btrim(v_terms->>'notes'), '') ELSE c.notes END,
    base_rate_per_hour = CASE WHEN v_terms ? 'base_rate_per_hour' THEN (v_terms->>'base_rate_per_hour')::numeric ELSE c.base_rate_per_hour END,
    overtime_rate_per_hour = CASE WHEN v_terms ? 'overtime_rate_per_hour' THEN (v_terms->>'overtime_rate_per_hour')::numeric ELSE c.overtime_rate_per_hour END,
    callout_rate_per_hour = CASE WHEN v_terms ? 'callout_rate_per_hour' THEN (v_terms->>'callout_rate_per_hour')::numeric ELSE c.callout_rate_per_hour END,
    callout_minimum_hours = CASE WHEN v_terms ? 'callout_minimum_hours' THEN (v_terms->>'callout_minimum_hours')::numeric ELSE c.callout_minimum_hours END,
    travel_rate_per_km = CASE WHEN v_terms ? 'travel_rate_per_km' THEN (v_terms->>'travel_rate_per_km')::numeric ELSE c.travel_rate_per_km END,
    -- Only do and invoice carries standing authority; any other model clears it.
    standing_authority_limit = CASE WHEN p_commercial_model <> 'do_and_invoice' THEN NULL
      WHEN v_terms ? 'standing_authority_limit' THEN (v_terms->>'standing_authority_limit')::numeric ELSE c.standing_authority_limit END,
    -- Only fixed price plus Extra has a monthly fee to run over; any other model clears it.
    fee_overrun_policy = CASE WHEN p_commercial_model <> 'fixed_price_with_extras' THEN NULL
      WHEN v_terms ? 'fee_overrun_policy' THEN v_terms->>'fee_overrun_policy' ELSE c.fee_overrun_policy END
  WHERE c.service_agreement_id = v_agreement.id
  RETURNING * INTO v_after;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_agreement.provider_organization_id, v_actor, 'agreement_commercial_terms_set', 'crm_commercial_settings', v_after.id,
    jsonb_strip_nulls(jsonb_build_object(
      'service_agreement_id', v_agreement.id,
      'reason', v_reason,
      'before', CASE WHEN v_has_before THEN to_jsonb(v_before) - 'id' - 'service_agreement_id' - 'created_at' - 'updated_at' END,
      'after', to_jsonb(v_after) - 'id' - 'service_agreement_id' - 'created_at' - 'updated_at')));

  RETURN jsonb_build_object('service_agreement_id', v_agreement.id, 'commercial_model', v_after.commercial_model,
    'uses_contract_extra', v_after.commercial_model = 'fixed_price_with_extras',
    'billing_cycle', v_after.billing_cycle, 'payment_terms_days', v_after.payment_terms_days,
    'payment_due_day_of_month', v_after.payment_due_day_of_month,
    'standing_authority_limit', v_after.standing_authority_limit,
    'fee_overrun_policy', v_after.fee_overrun_policy);
END;
$function$;
COMMENT ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) IS 'Provider administrator sets how an agreement is billed (commercial_model) and optional terms (billing cycle, payment days or due day of the following month, invoice email, PO, notes, rates, for do and invoice the standing authority limit per job, and for fixed price plus Extra what happens to work above the monthly fee: fee_overrun_policy bill_as_extra (pre-agreed) or justify). Only listed keys are accepted; omitted keys are unchanged. Changing an existing model needs a reason. Audited with before/after.';

-- Completed work: patrol visits on a fixed price plus Extra agreement draw down the fee, never billed again.
CREATE OR REPLACE FUNCTION "public"."generate_crm_invoice_from_completed_work"(p_client_request_id uuid, p_organization_id uuid, p_client_organization_id uuid, p_service_agreement_id uuid DEFAULT NULL::uuid, p_period_start date DEFAULT NULL::date, p_period_end date DEFAULT NULL::date)
 RETURNS invoices
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_invoice public.invoices%ROWTYPE;
  v_count integer := 0;
  v_unpriced integer := 0;
  v_unclassified integer := 0;
  v_contract_skipped integer := 0;
  v_missing_reference integer := 0;
  v_missing_approval integer := 0;
  v_actuals_callouts integer := 0;
  v_billable_callouts integer := 0;
  v_terms_days integer := 14;
  v_due_day integer;
  v_row record;
  v_line_id uuid;
  v_start date := coalesce(p_period_start, date '1970-01-01');
  v_end date := coalesce(p_period_end, current_date);
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_organization_id IS NULL OR p_client_organization_id IS NULL THEN RAISE EXCEPTION 'Organisation and client are required'; END IF;
  IF NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Finance administrator access required'; END IF;
  IF v_end < v_start THEN RAISE EXCEPTION 'Period end cannot precede period start'; END IF;
  SELECT i.* INTO v_invoice FROM public.audit_log a JOIN public.invoices i ON i.id = a.target_id
   WHERE a.organization_id = p_organization_id AND a.action = 'crm_invoice_generated_from_completed_work'
     AND a.metadata->>'client_request_id' = p_client_request_id::text LIMIT 1;
  IF FOUND THEN RETURN v_invoice; END IF;

  SELECT count(*)::integer INTO v_unpriced FROM public.patrol_stop_charge_lines line
  WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
    AND line.status IN ('unresolved_rate', 'unresolved_agreement')
    AND line.created_at::date BETWEEN v_start AND v_end
    AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id);
  IF v_unpriced > 0 THEN RAISE EXCEPTION '% completed patrol visit(s) need a per-visit rate before this invoice can be created', v_unpriced; END IF;

  -- The agreement's commercial model decides how each callout is billed.
  SELECT
    count(*) FILTER (WHERE x.uses_ce AND x.billing_basis IS NULL)::integer,
    count(*) FILTER (WHERE x.uses_ce AND x.billing_basis = 'contract')::integer,
    count(*) FILTER (WHERE x.model = 'per_request' AND x.client_order_reference IS NULL)::integer,
    count(*) FILTER (WHERE NOT x.uses_ce)::integer,
    count(DISTINCT x.source_dispatch_id) FILTER (WHERE x.model = 'do_and_invoice' AND x.client_order_reference IS NULL
      AND x.authority_limit IS NOT NULL AND public.dispatch_job_over_standing_authority(x.source_dispatch_id, x.authority_limit))::integer,
    count(*) FILTER (WHERE x.model = 'do_and_invoice')::integer
    INTO v_unclassified, v_contract_skipped, v_missing_reference, v_billable_callouts, v_missing_approval, v_actuals_callouts
  FROM (
    SELECT line.billing_basis, line.source_dispatch_id, job.client_order_reference,
      public.agreement_uses_contract_extra(line.service_agreement_id) AS uses_ce,
      public.agreement_commercial_model(line.service_agreement_id) AS model,
      settings.standing_authority_limit AS authority_limit
    FROM public.dispatch_job_charge_lines line
    LEFT JOIN public.dispatch_jobs job ON job.id = line.source_dispatch_id
    LEFT JOIN public.crm_commercial_settings settings ON settings.service_agreement_id = line.service_agreement_id
    WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
      AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id)
  ) x;
  IF v_unclassified > 0 THEN
    RAISE EXCEPTION '% callout charge line(s) need billing set (Contracted work or Extra) in Dispatch before this invoice can be created', v_unclassified;
  END IF;
  IF v_missing_reference > 0 THEN
    RAISE EXCEPTION '% callout(s) on a per-request agreement need the client''s request or PO reference in Dispatch before this invoice can be created', v_missing_reference;
  END IF;
  IF v_missing_approval > 0 THEN
    RAISE EXCEPTION '% do-and-invoice job(s) cost more than the client''s standing authority limit and need the client''s approval reference in Dispatch before this invoice can be created', v_missing_approval;
  END IF;

  IF p_service_agreement_id IS NOT NULL THEN
    SELECT coalesce(c.payment_terms_days, 14), c.payment_due_day_of_month INTO v_terms_days, v_due_day FROM public.crm_commercial_settings c WHERE c.service_agreement_id = p_service_agreement_id;
    v_terms_days := coalesce(v_terms_days, 14);
  END IF;

  INSERT INTO public.invoices (organization_id, client_organization_id, service_agreement_id, invoice_number, invoice_date, due_date, status, service_period_start, service_period_end, created_by)
  VALUES (p_organization_id, p_client_organization_id, p_service_agreement_id,
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(gen_random_uuid()::text, 1, 4)),
    current_date, public.invoice_due_date(current_date, v_end, v_terms_days, v_due_day), 'draft', p_period_start, p_period_end, v_actor)
  RETURNING * INTO v_invoice;

  FOR v_row IN
    SELECT line.id AS line_id, wo.order_number, wo.title, line.description, line.quantity, line.unit_price, line.unit_cost, line.line_kind, line.item_id, line.unit_of_measure
    FROM public.workshop_work_order_lines line JOIN public.workshop_work_orders wo ON wo.id = line.work_order_id
    WHERE wo.organization_id = p_organization_id AND wo.client_organization_id = p_client_organization_id AND wo.status = 'completed'
      AND line.invoice_line_item_id IS NULL AND wo.completed_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR wo.service_agreement_id IS NULL OR wo.service_agreement_id = p_service_agreement_id)
    ORDER BY wo.completed_at, line.position
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, finance_item_catalog_id, item_type, unit_of_measure, internal_cost_amount, created_by)
    VALUES (v_invoice.id, v_count, v_row.order_number || ' · ' || v_row.title || ' — ' || v_row.description, v_row.quantity, v_row.unit_price, round(v_row.quantity * v_row.unit_price, 2),
      p_organization_id, v_row.item_id, v_row.line_kind, v_row.unit_of_measure, round(v_row.quantity * v_row.unit_cost, 2), v_actor)
    RETURNING id INTO v_line_id;
    UPDATE public.workshop_work_order_lines SET invoice_line_item_id = v_line_id WHERE id = v_row.line_id;
  END LOOP;

  FOR v_row IN
    SELECT line.id AS charge_id, line.source_dispatch_id, line.description, line.quantity, line.unit_rate, line.line_total, line.rate_type, line.created_at,
      ewo.reference AS extra_reference, job.client_order_reference, x.uses_ce, x.model
    FROM public.dispatch_job_charge_lines line
    LEFT JOIN public.agreement_extra_work_orders ewo ON ewo.id = line.extra_work_order_id
    LEFT JOIN public.dispatch_jobs job ON job.id = line.source_dispatch_id
    CROSS JOIN LATERAL (SELECT public.agreement_uses_contract_extra(line.service_agreement_id) AS uses_ce,
      public.agreement_commercial_model(line.service_agreement_id) AS model) x
    WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
      AND (line.billing_basis = 'extra' OR NOT x.uses_ce)
      AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id)
    ORDER BY line.created_at
    -- Locked so a concurrent run waits, then skips lines this run has stamped.
    FOR UPDATE OF line
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, item_type, source_dispatch_id, created_by)
    VALUES (v_invoice.id, v_count,
      CASE WHEN v_row.uses_ce THEN 'Extra' || coalesce(' ' || v_row.extra_reference, '') || ' — '
        WHEN v_row.model = 'do_and_invoice' THEN 'Actuals — ' ELSE '' END
        || CASE WHEN v_row.model = 'do_and_invoice' THEN coalesce('Client approval ' || v_row.client_order_reference || ' — ', '')
           ELSE coalesce('Client ref ' || v_row.client_order_reference || ' — ', '') END
        || coalesce(v_row.description, 'Dispatch ' || v_row.rate_type),
      coalesce(v_row.quantity, 1), coalesce(v_row.unit_rate, v_row.line_total), v_row.line_total, p_organization_id, 'other', v_row.source_dispatch_id, v_actor)
    RETURNING id INTO v_line_id;
    UPDATE public.dispatch_job_charge_lines SET invoice_line_item_id = v_line_id WHERE id = v_row.charge_id;
  END LOOP;

  FOR v_row IN
    SELECT line.id AS charge_id, line.shift_id, line.description, line.quantity, line.unit_rate, line.line_total, line.created_at
    FROM public.patrol_stop_charge_lines line
    WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
      AND line.status = 'ready' AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id)
      -- A fixed monthly fee already pays for contracted visits; they draw the fee down instead.
      AND coalesce(public.agreement_commercial_model(line.service_agreement_id), '') <> 'fixed_price_with_extras'
    ORDER BY line.created_at
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, item_type, shift_id, created_by)
    VALUES (v_invoice.id, v_count, v_row.description, v_row.quantity, v_row.line_total, v_row.line_total, p_organization_id, 'other', v_row.shift_id, v_actor)
    RETURNING id INTO v_line_id;
    UPDATE public.patrol_stop_charge_lines SET invoice_line_item_id = v_line_id, status = 'invoiced', updated_at = now() WHERE id = v_row.charge_id;
  END LOOP;

  IF v_count = 0 THEN
    DELETE FROM public.invoices WHERE id = v_invoice.id;
    IF v_contract_skipped > 0 THEN
      RAISE EXCEPTION 'Nothing to invoice: % callout charge line(s) in the period are contracted work, covered by the agreement price', v_contract_skipped;
    END IF;
    RAISE EXCEPTION 'No completed, uninvoiced work for this client in the period';
  END IF;
  UPDATE public.invoices invoice SET subtotal = totals.subtotal, gst_amount = round(totals.subtotal * 0.15, 2), total_amount = round(totals.subtotal * 1.15, 2), updated_at = now()
  FROM (SELECT coalesce(sum(line_total), 0) AS subtotal FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) totals
  WHERE invoice.id = v_invoice.id RETURNING invoice.* INTO v_invoice;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'crm_invoice_generated_from_completed_work', 'invoices', v_invoice.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'client_organization_id', p_client_organization_id,
      'lines', v_count, 'total_amount', v_invoice.total_amount, 'period_start', p_period_start, 'period_end', p_period_end,
      'contract_callout_lines_not_billed', v_contract_skipped, 'callout_lines_billed_by_commercial_model', v_billable_callouts,
      'do_and_invoice_actuals_lines', v_actuals_callouts,
      'payment_terms_days', v_terms_days, 'payment_due_day_of_month', v_due_day, 'due_date', v_invoice.due_date));
  RETURN v_invoice;
END;
$function$;
COMMENT ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) IS 'Sweep completed, uninvoiced workshop lines, billable dispatch charge lines and ready patrol visit lines (except on fixed price plus Extra agreements, where contracted visits draw down the monthly fee) for one client into a single draft invoice (GST 15%). Callouts follow the agreement commercial model: fixed price plus Extra (or not set) bills Extra only, skips Contract and blocks while any callout has no decision; pay as you go bills every callout at agreed rates; do and invoice bills the actuals under standing authority (lines prefixed Actuals) and blocks a job that costs more than the agreement standing authority limit until it has the client''s approval reference; per request bills every callout and blocks until each job has the client reference. Due date follows the agreement payment terms when one agreement is invoiced: the due day of the month after the invoiced period when set (never before the invoice date), otherwise payment_terms_days after the invoice date (default 14). Stamps invoice_line_item_id on the source lines so nothing is billed twice. Idempotent on client_request_id; audited.';

-- Billing summary: shows the overrun policy with the other terms.
CREATE OR REPLACE FUNCTION "public"."get_agreement_billing_basis_summary"(p_service_agreement_id uuid, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agreement public.service_agreements%ROWTYPE;
  v_from date := coalesce(p_from, date '1970-01-01');
  v_to date := coalesce(p_to, current_date);
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in required'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Finance administrator access required'; END IF;
  IF v_to < v_from THEN RAISE EXCEPTION 'Period end cannot precede period start'; END IF;

  WITH classified AS (
    SELECT to_char(r.service_date, 'YYYY-MM') AS month, r.amount, c.basis, c.conflict
    FROM public.file_import_finance_cost_rows r
    CROSS JOIN LATERAL public.classify_patrol_cost_row_billing_basis(v_agreement.provider_organization_id, r.source_values) c
    WHERE r.service_agreement_id = v_agreement.id AND r.status = 'applied'
      AND r.service_date BETWEEN v_from AND v_to
  ), months AS (
    SELECT month,
      round(coalesce(sum(amount) FILTER (WHERE basis = 'contract'), 0), 2) AS contract_cost,
      round(coalesce(sum(amount) FILTER (WHERE basis = 'extra'), 0), 2) AS extra_cost,
      round(coalesce(sum(amount) FILTER (WHERE basis = 'unclassified'), 0), 2) AS unclassified_cost,
      count(*) FILTER (WHERE basis = 'unclassified')::integer AS unclassified_rows,
      count(*) FILTER (WHERE conflict)::integer AS conflict_rows
    FROM classified WHERE month IS NOT NULL GROUP BY month
  ), dispatch AS (
    SELECT coalesce(line.billing_basis, 'unclassified') AS basis, count(*)::integer AS lines,
      round(coalesce(sum(line.line_total), 0), 2) AS total,
      round(coalesce(sum(line.line_total) FILTER (WHERE line.invoice_line_item_id IS NULL), 0), 2) AS uninvoiced_total
    FROM public.dispatch_job_charge_lines line
    WHERE line.service_agreement_id = v_agreement.id AND line.created_at::date BETWEEN v_from AND v_to
    GROUP BY 1
  ), orders AS (
    SELECT o.id, o.reference, o.title, o.starts_on, o.ends_on,
      count(line.id)::integer AS charge_lines, round(coalesce(sum(line.line_total), 0), 2) AS charge_total
    FROM public.agreement_extra_work_orders o
    LEFT JOIN public.dispatch_job_charge_lines line ON line.extra_work_order_id = o.id AND line.created_at::date BETWEEN v_from AND v_to
    WHERE o.service_agreement_id = v_agreement.id
    GROUP BY o.id
  ), price AS (
    SELECT count(*)::integer AS lines, round(sum(ql.quantity * ql.unit_charge), 2) AS total
    FROM public.quotes q JOIN public.quote_lines ql ON ql.quote_id = q.id
    WHERE q.service_agreement_id = v_agreement.id AND q.status = 'accepted'
  )
  SELECT jsonb_build_object(
    'service_agreement_id', v_agreement.id,
    'period_from', p_from, 'period_to', p_to,
    'commercial', (SELECT jsonb_build_object(
        'commercial_model', c.commercial_model,
        'uses_contract_extra', public.agreement_uses_contract_extra(v_agreement.id),
        'billing_cycle', c.billing_cycle, 'payment_terms_days', c.payment_terms_days, 'currency', c.currency,
        'base_rate_per_hour', c.base_rate_per_hour, 'overtime_rate_per_hour', c.overtime_rate_per_hour,
        'callout_rate_per_hour', c.callout_rate_per_hour, 'callout_minimum_hours', c.callout_minimum_hours,
        'travel_rate_per_km', c.travel_rate_per_km, 'invoice_email', c.invoice_email,
        'purchase_order_number', c.purchase_order_number, 'notes', c.notes, 'updated_at', c.updated_at,
        'standing_authority_limit', c.standing_authority_limit,
        'fee_overrun_policy', c.fee_overrun_policy,
        'jobs_over_standing_authority_without_approval', CASE WHEN c.commercial_model = 'do_and_invoice' AND c.standing_authority_limit IS NOT NULL THEN
          (SELECT count(*)::integer FROM public.dispatch_jobs job
            WHERE job.service_agreement_id = v_agreement.id AND job.client_order_reference IS NULL
              AND public.dispatch_job_over_standing_authority(job.id, c.standing_authority_limit)
              AND EXISTS (SELECT 1 FROM public.dispatch_job_charge_lines l WHERE l.source_dispatch_id = job.id AND l.invoice_line_item_id IS NULL)) END)
      FROM (SELECT 1) one LEFT JOIN public.crm_commercial_settings c ON c.service_agreement_id = v_agreement.id),
    'agreement_price', (SELECT CASE WHEN lines = 0 THEN NULL ELSE jsonb_build_object('source', 'accepted_quote_lines', 'lines', lines, 'total', total) END FROM price),
    'imported_cost_months', coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.month) FROM months m), '[]'::jsonb),
    'imported_cost_totals', (SELECT jsonb_build_object(
        'contract_cost', coalesce(sum(contract_cost), 0), 'extra_cost', coalesce(sum(extra_cost), 0),
        'unclassified_cost', coalesce(sum(unclassified_cost), 0), 'unclassified_rows', coalesce(sum(unclassified_rows), 0),
        'conflict_rows', coalesce(sum(conflict_rows), 0)) FROM months),
    'dispatch_charge_lines', coalesce((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.basis) FROM dispatch d), '[]'::jsonb),
    'extra_work_orders', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'reference', o.reference, 'title', o.title,
        'starts_on', o.starts_on, 'ends_on', o.ends_on, 'charge_lines', o.charge_lines, 'charge_total', o.charge_total) ORDER BY o.reference) FROM orders o), '[]'::jsonb),
    'basis_rule', 'Imported rows use the workbook TYPE column when present, otherwise the provider charge-code catalog basis; amounts are recorded service cost (job + travel), not invoiced revenue.'
  ) INTO v_result;
  RETURN v_result;
END;
$function$;

-- G. OneFortyOne pre-agrees work above the fee as Extra (owner ruling 2026-10-25).
WITH changed AS (
  UPDATE public.crm_commercial_settings c SET fee_overrun_policy = 'bill_as_extra', updated_at = now()
  WHERE c.service_agreement_id = 'c36761e5-1634-419d-9ae5-234d3ec934ec'
    AND c.commercial_model = 'fixed_price_with_extras'
    AND c.fee_overrun_policy IS DISTINCT FROM 'bill_as_extra'
  RETURNING c.id, c.service_agreement_id
)
INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT a.provider_organization_id, NULL, 'agreement_commercial_terms_set', 'crm_commercial_settings', changed.id,
  jsonb_build_object('service_agreement_id', changed.service_agreement_id,
    'reason', 'Owner ruling 2026-10-25: OneFortyOne already agrees that contracted work above the monthly fee is billed as Extra.',
    'before', jsonb_build_object('fee_overrun_policy', NULL), 'after', jsonb_build_object('fee_overrun_policy', 'bill_as_extra'),
    'source', 'migration 20261028090000_monthly_fee_drawdown')
FROM changed JOIN public.service_agreements a ON a.id = changed.service_agreement_id;
