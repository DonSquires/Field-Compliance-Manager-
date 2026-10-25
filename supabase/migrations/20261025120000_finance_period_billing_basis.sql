-- Contract vs Extra split for the monthly finance (P&L) period.
--
-- Imported patrol cost lines in finance_service_costs are reconciled, one per
-- agreement + month + component. They are not split or rewritten here; the split
-- is derived from the applied source rows linked through
-- file_import_finance_cost_rows.finance_service_cost_id, using one shared
-- classification rule so the agreement tab and the finance period always agree.

CREATE OR REPLACE FUNCTION public.classify_patrol_cost_row_billing_basis(p_provider_organization_id uuid, p_source_values jsonb)
 RETURNS TABLE(basis text, sheet_basis text, code_basis text, conflict boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH s AS (
    SELECT
      CASE lower(btrim(p_source_values->>'activity_type')) WHEN 'contract' THEN 'contract' WHEN 'extra' THEN 'extra' END AS sheet_basis,
      (SELECT CASE lower(rc.external_refs->>'billing_basis') WHEN 'contract' THEN 'contract' WHEN 'extra' THEN 'extra' END
       FROM public.reference_codes rc
       WHERE rc.organization_id = p_provider_organization_id
         AND rc.code_type = 'charge_code'
         AND rc.code = nullif(btrim(p_source_values->>'charge_code'), '')) AS code_basis
  )
  SELECT coalesce(s.sheet_basis, s.code_basis, 'unclassified'), s.sheet_basis, s.code_basis,
    (s.sheet_basis IS NOT NULL AND s.code_basis IS NOT NULL AND s.sheet_basis <> s.code_basis)
  FROM s;
$function$;
COMMENT ON FUNCTION public.classify_patrol_cost_row_billing_basis(uuid, jsonb) IS 'Internal rule: an imported patrol cost row is Contract or Extra by the workbook TYPE column first, otherwise by the provider charge-code catalog billing_basis, otherwise unclassified; conflict is true when both are present and disagree.';
REVOKE ALL ON FUNCTION public.classify_patrol_cost_row_billing_basis(uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.classify_patrol_cost_row_billing_basis(uuid, jsonb) TO postgres;

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
COMMENT ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) IS 'Read-only, provider-admin only: contracted vs Extra vs unclassified per month for one service agreement (imported patrol cost rows classified by classify_patrol_cost_row_billing_basis), dispatch charge lines by billing basis, Extra works orders, and the accepted-quote agreement price (null when not recorded).';
REVOKE ALL ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) TO postgres, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_finance_pl_period_billing_basis(p_pl_period_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_period public.finance_pl_periods%ROWTYPE;
  v_result jsonb;
BEGIN
  SELECT organization_id INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL;

  IF v_org IS NULL OR NOT public.is_admin_for_org(v_org) THEN
    RAISE EXCEPTION 'Active finance administrator required';
  END IF;

  SELECT * INTO v_period
  FROM public.finance_pl_periods
  WHERE id = p_pl_period_id AND organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'P&L period not found in organization'; END IF;

  WITH lines AS (
    SELECT f.id, f.service_agreement_id, f.source_document_type, f.dispatch_job_id, f.total_cost
    FROM public.finance_service_costs f
    WHERE f.organization_id = v_org AND f.pl_period_id = v_period.id
  ), patrol_rows AS (
    SELECT l.id AS line_id, r.amount, c.basis, c.conflict
    FROM lines l
    JOIN public.file_import_finance_cost_rows r ON r.finance_service_cost_id = l.id AND r.status = 'applied'
    CROSS JOIN LATERAL public.classify_patrol_cost_row_billing_basis(v_org, r.source_values) c
    WHERE l.source_document_type = 'patrol_log'
  ), patrol_lines AS (
    SELECT l.id, l.service_agreement_id, l.total_cost,
      coalesce(sum(p.amount) FILTER (WHERE p.basis = 'contract'), 0) AS contract_cost,
      coalesce(sum(p.amount) FILTER (WHERE p.basis = 'extra'), 0) AS extra_cost,
      coalesce(sum(p.amount) FILTER (WHERE p.basis = 'unclassified'), 0) AS unclassified_linked,
      coalesce(sum(p.amount), 0) AS linked_cost,
      count(p.line_id) FILTER (WHERE p.basis = 'unclassified')::integer AS unclassified_rows,
      count(p.line_id) FILTER (WHERE p.conflict)::integer AS conflict_rows
    FROM lines l LEFT JOIN patrol_rows p ON p.line_id = l.id
    WHERE l.source_document_type = 'patrol_log'
    GROUP BY l.id, l.service_agreement_id, l.total_cost
  ), split AS (
    SELECT service_agreement_id, contract_cost, extra_cost,
      unclassified_linked + (total_cost - linked_cost) AS unclassified_cost,
      0::numeric AS other_cost, total_cost - linked_cost AS unlinked_cost, total_cost,
      unclassified_rows, conflict_rows
    FROM patrol_lines
    UNION ALL
    SELECT l.service_agreement_id,
      CASE WHEN dj.billing_basis = 'contract' THEN l.total_cost ELSE 0 END,
      CASE WHEN dj.billing_basis = 'extra' THEN l.total_cost ELSE 0 END,
      CASE WHEN dj.billing_basis IS NULL THEN l.total_cost ELSE 0 END,
      0, 0, l.total_cost, 0, 0
    FROM lines l LEFT JOIN public.dispatch_jobs dj ON dj.id = l.dispatch_job_id
    WHERE l.source_document_type IS DISTINCT FROM 'patrol_log' AND l.dispatch_job_id IS NOT NULL
    UNION ALL
    SELECT l.service_agreement_id, 0, 0, 0, l.total_cost, 0, l.total_cost, 0, 0
    FROM lines l
    WHERE l.source_document_type IS DISTINCT FROM 'patrol_log' AND l.dispatch_job_id IS NULL
  ), by_agreement AS (
    SELECT s.service_agreement_id,
      round(sum(s.contract_cost), 2) AS contract_cost, round(sum(s.extra_cost), 2) AS extra_cost,
      round(sum(s.unclassified_cost), 2) AS unclassified_cost, round(sum(s.other_cost), 2) AS other_cost,
      round(sum(s.total_cost), 2) AS total_cost,
      sum(s.unclassified_rows)::integer AS unclassified_rows, sum(s.conflict_rows)::integer AS conflict_rows
    FROM split s GROUP BY s.service_agreement_id
  ), price AS (
    SELECT q.service_agreement_id, round(sum(ql.quantity * ql.unit_charge), 2) AS total
    FROM public.quotes q JOIN public.quote_lines ql ON ql.quote_id = q.id
    WHERE q.status = 'accepted' AND q.service_agreement_id IN (SELECT service_agreement_id FROM by_agreement)
    GROUP BY q.service_agreement_id
  )
  SELECT jsonb_build_object(
    'pl_period_id', v_period.id,
    'period_name', v_period.name,
    'period_start', v_period.period_start,
    'period_end', v_period.period_end,
    'period_status', v_period.status,
    'totals', (SELECT jsonb_build_object(
        'contract_cost', round(coalesce(sum(contract_cost), 0), 2),
        'extra_cost', round(coalesce(sum(extra_cost), 0), 2),
        'unclassified_cost', round(coalesce(sum(unclassified_cost), 0), 2),
        'other_cost', round(coalesce(sum(other_cost), 0), 2),
        'unlinked_cost', round(coalesce(sum(unlinked_cost), 0), 2),
        'total_cost', round(coalesce(sum(total_cost), 0), 2),
        'unclassified_rows', coalesce(sum(unclassified_rows), 0)::integer,
        'conflict_rows', coalesce(sum(conflict_rows), 0)::integer) FROM split),
    'by_agreement', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'service_agreement_id', b.service_agreement_id,
        'agreement_name', sa.name,
        'client_name', client.name,
        'contract_cost', b.contract_cost, 'extra_cost', b.extra_cost,
        'unclassified_cost', b.unclassified_cost, 'other_cost', b.other_cost,
        'total_cost', b.total_cost,
        'unclassified_rows', b.unclassified_rows, 'conflict_rows', b.conflict_rows,
        'agreement_price', p.total
      ) ORDER BY b.total_cost DESC, sa.name)
      FROM by_agreement b
      JOIN public.service_agreements sa ON sa.id = b.service_agreement_id
      LEFT JOIN public.organizations client ON client.id = sa.client_organization_id
      LEFT JOIN price p ON p.service_agreement_id = b.service_agreement_id), '[]'::jsonb),
    'basis_rule', 'Imported patrol cost is split by its linked workbook rows (TYPE column first, then the charge-code catalog basis). Dispatch cost follows the job billing choice. Timesheet, overhead and manual cost is shown as other. Amounts are recorded service cost, not invoiced revenue.'
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
COMMENT ON FUNCTION public.get_finance_pl_period_billing_basis(uuid) IS 'Read-only, active finance administrator of the period organization only: splits the P&L period service cost into Contract, Extra, unclassified and other, per agreement. Totals reconcile to get_finance_pl_period_summary.total_cost. Does not modify finance_service_costs.';
REVOKE ALL ON FUNCTION public.get_finance_pl_period_billing_basis(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_finance_pl_period_billing_basis(uuid) TO postgres, authenticated, service_role;
