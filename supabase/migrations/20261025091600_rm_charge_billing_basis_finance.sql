-- Owner ruling 2026-10-25: charge codes derived from the R&M group catalog
-- (origin 'derived') default to Extra. OneFortyOne-origin codes keep the basis
-- OneFortyOne's own List sheet gives them; 40000 stays N/A.
-- Completed-work invoicing becomes billing-basis aware: contracted callouts are
-- covered by the agreement price and are not billed again; unclassified
-- callouts block the invoice until someone decides.
-- A read-only summary shows contract vs extra per month for one agreement.

UPDATE public.reference_codes
SET external_refs = external_refs || jsonb_build_object('billing_basis', 'Extra', 'basis_source', 'owner_default_2026-10-25')
WHERE code_type = 'charge_code'
  AND external_refs->>'scheme' = 'rm_group_charge_code'
  AND external_refs->>'origin' = 'derived'
  AND nullif(external_refs->>'billing_basis', '') IS NULL;

CREATE OR REPLACE FUNCTION public.generate_crm_invoice_from_completed_work(p_client_request_id uuid, p_organization_id uuid, p_client_organization_id uuid, p_service_agreement_id uuid DEFAULT NULL::uuid, p_period_start date DEFAULT NULL::date, p_period_end date DEFAULT NULL::date)
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

  SELECT count(*) FILTER (WHERE line.billing_basis IS NULL)::integer,
         count(*) FILTER (WHERE line.billing_basis = 'contract')::integer
    INTO v_unclassified, v_contract_skipped
  FROM public.dispatch_job_charge_lines line
  WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
    AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
    AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id);
  IF v_unclassified > 0 THEN
    RAISE EXCEPTION '% callout charge line(s) need billing set (Contracted work or Extra) in Dispatch before this invoice can be created', v_unclassified;
  END IF;

  INSERT INTO public.invoices (organization_id, client_organization_id, service_agreement_id, invoice_number, invoice_date, due_date, status, service_period_start, service_period_end, created_by)
  VALUES (p_organization_id, p_client_organization_id, p_service_agreement_id,
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(gen_random_uuid()::text, 1, 4)),
    current_date, (current_date + interval '14 days')::date, 'draft', p_period_start, p_period_end, v_actor)
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
    SELECT line.id AS charge_id, line.source_dispatch_id, line.description, line.quantity, line.unit_rate, line.line_total, line.rate_type, line.created_at, ewo.reference AS extra_reference
    FROM public.dispatch_job_charge_lines line
    LEFT JOIN public.agreement_extra_work_orders ewo ON ewo.id = line.extra_work_order_id
    WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
      AND line.billing_basis = 'extra'
      AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id)
    ORDER BY line.created_at
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, item_type, source_dispatch_id, created_by)
    VALUES (v_invoice.id, v_count,
      'Extra' || coalesce(' ' || v_row.extra_reference, '') || ' — ' || coalesce(v_row.description, 'Dispatch ' || v_row.rate_type),
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
      'contract_callout_lines_not_billed', v_contract_skipped));
  RETURN v_invoice;
END;
$function$;
COMMENT ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) IS 'Sweep completed, uninvoiced workshop lines, Extra dispatch charge lines and ready patrol visit lines for one client into a single draft invoice (GST 15%). Contracted callouts are covered by the agreement price and are not billed; callouts with no billing decision block the invoice. Stamps invoice_line_item_id on the source lines so nothing is billed twice. Idempotent on client_request_id; audited.';
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) TO postgres, authenticated;

CREATE OR REPLACE FUNCTION public.get_agreement_billing_basis_summary(p_service_agreement_id uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
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

  WITH imported AS (
    SELECT to_char(r.service_date, 'YYYY-MM') AS month, r.amount,
      CASE lower(r.source_values->>'activity_type') WHEN 'contract' THEN 'contract' WHEN 'extra' THEN 'extra' END AS sheet_basis,
      CASE lower(code.basis) WHEN 'contract' THEN 'contract' WHEN 'extra' THEN 'extra' END AS code_basis
    FROM public.file_import_finance_cost_rows r
    LEFT JOIN LATERAL (
      SELECT rc.external_refs->>'billing_basis' AS basis FROM public.reference_codes rc
      WHERE rc.organization_id = v_agreement.provider_organization_id AND rc.code_type = 'charge_code'
        AND rc.code = nullif(btrim(r.source_values->>'charge_code'), '')
      LIMIT 1) code ON true
    WHERE r.service_agreement_id = v_agreement.id AND r.status = 'applied'
      AND r.service_date BETWEEN v_from AND v_to
  ), classified AS (
    SELECT month, amount, coalesce(sheet_basis, code_basis, 'unclassified') AS basis,
      (sheet_basis IS NOT NULL AND code_basis IS NOT NULL AND sheet_basis <> code_basis) AS conflict
    FROM imported
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
COMMENT ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) IS 'Read-only, provider-admin only: contracted vs Extra vs unclassified per month for one service agreement (imported patrol cost rows classified by workbook TYPE then charge-code basis), dispatch charge lines by billing basis, Extra works orders, and the accepted-quote agreement price (null when not recorded).';
REVOKE ALL ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) TO postgres, authenticated, service_role;
