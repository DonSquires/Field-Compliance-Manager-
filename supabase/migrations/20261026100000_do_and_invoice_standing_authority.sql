-- Do and invoice is its own billing model, not pay as you go (owner ruling 2026-10-26, critique fix).
--
--   pay_as_you_go   all work at the agreed rates, invoiced each billing cycle.
--   do_and_invoice  standing authority: R&M does what is needed without asking first and
--                   invoices the actual time, travel and materials. Invoice lines say "Actuals".
--                   An optional per-job standing authority limit can be agreed: a job that costs
--                   more than it needs the client's approval reference before it is invoiced.
--                   No limit (NULL) = no cap; nothing is held back.
--
-- The approval reference reuses dispatch_jobs.client_order_reference (set only through the
-- audited set_dispatch_job_client_reference). No limit is seeded: none of the R&M finance
-- documents state one, so each client's limit is an owner decision.
--
-- Also fixed: a dispatch job with travel has two charge lines (attendance and travel), but invoice
-- lines were unique per job, so such a job could not be invoiced at all.

ALTER TABLE public.crm_commercial_settings ADD COLUMN IF NOT EXISTS standing_authority_limit numeric(12,2);
ALTER TABLE public.crm_commercial_settings DROP CONSTRAINT IF EXISTS crm_commercial_settings_standing_authority_limit_check;
ALTER TABLE public.crm_commercial_settings ADD CONSTRAINT crm_commercial_settings_standing_authority_limit_check
  CHECK (standing_authority_limit IS NULL OR (standing_authority_limit >= 0 AND commercial_model = 'do_and_invoice'));
COMMENT ON COLUMN public.crm_commercial_settings.standing_authority_limit IS 'Do and invoice only: the most one job may cost (charge lines, excl. GST) under the client''s standing authority. A job above it needs the client''s approval reference (dispatch_jobs.client_order_reference) before it is invoiced. NULL = no cap. Set only through set_agreement_commercial_terms (audited).';
COMMENT ON COLUMN public.crm_commercial_settings.commercial_model IS 'How work on this agreement is charged: fixed_price_with_extras (contract price + Extra), pay_as_you_go (all work at agreed rates each cycle), do_and_invoice (standing authority to do what is needed, invoice actuals; client approval needed only above standing_authority_limit), per_request (each job requested by the client, request/PO reference required). NULL = not set; every callout needs a Contract/Extra decision. Set only through set_agreement_commercial_terms (audited).';
COMMENT ON COLUMN public.dispatch_jobs.client_order_reference IS 'The client''s own reference for this job: the request or purchase-order reference (required before invoicing on per_request agreements) or the client''s approval (required on do_and_invoice agreements when the job costs more than the standing authority limit). Set only through set_dispatch_job_client_reference (audited).';
COMMENT ON FUNCTION public.set_dispatch_job_client_reference(uuid, text, text) IS 'Dispatcher (provider administrator) records the client''s request, approval or purchase-order reference on a dispatch job. Required before invoicing on per_request agreements, and on do_and_invoice agreements when the job is over the standing authority limit. Reason required to change an existing reference; refuses invoiced jobs; audited.';

-- Invoicing actuals bills each charge line of a job (attendance and travel are separate lines), so an
-- invoice may carry several lines for one dispatch job. The old one-line-per-job unique index made any
-- job with travel impossible to invoice. Double billing is prevented by the charge-line stamp
-- (dispatch_job_charge_lines.invoice_line_item_id) and the row lock in the invoice run.
DROP INDEX IF EXISTS public.idx_invoice_line_items_source_dispatch;
CREATE INDEX IF NOT EXISTS idx_invoice_line_items_source_dispatch ON public.invoice_line_items (organization_id, source_dispatch_id)
  WHERE source_dispatch_id IS NOT NULL;
CREATE OR REPLACE FUNCTION public.dispatch_job_over_standing_authority(p_job_id uuid, p_limit numeric)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT p_limit IS NOT NULL
    AND coalesce((SELECT sum(l.line_total) FROM public.dispatch_job_charge_lines l WHERE l.source_dispatch_id = p_job_id), 0) > p_limit;
$function$;
COMMENT ON FUNCTION public.dispatch_job_over_standing_authority(uuid, numeric) IS 'Internal: true when all charge lines of the dispatch job (invoiced or not, so a job cannot be split under the limit) total more than the standing authority limit. False when the limit is NULL.';
REVOKE ALL ON FUNCTION public.dispatch_job_over_standing_authority(uuid, numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dispatch_job_over_standing_authority(uuid, numeric) TO postgres;

CREATE OR REPLACE FUNCTION public.set_agreement_commercial_terms(p_service_agreement_id uuid, p_commercial_model text, p_terms jsonb DEFAULT '{}'::jsonb, p_reason text DEFAULT NULL::text)
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
                  'standing_authority_limit')
  LIMIT 1;
  IF v_unknown IS NOT NULL THEN RAISE EXCEPTION 'Unknown billing term: %', v_unknown; END IF;
  IF v_terms ? 'billing_cycle' AND (v_terms->>'billing_cycle') NOT IN ('weekly', 'fortnightly', 'monthly', 'quarterly') THEN
    RAISE EXCEPTION 'Billing cycle must be weekly, fortnightly, monthly or quarterly';
  END IF;
  IF v_terms ? 'payment_terms_days' AND ((v_terms->>'payment_terms_days') !~ '^\d{1,3}$' OR (v_terms->>'payment_terms_days')::integer > 120) THEN
    RAISE EXCEPTION 'Payment terms must be a whole number of days from 0 to 120';
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
    updated_at = now();

  UPDATE public.crm_commercial_settings c SET
    billing_cycle = CASE WHEN v_terms ? 'billing_cycle' THEN v_terms->>'billing_cycle' ELSE c.billing_cycle END,
    payment_terms_days = CASE WHEN v_terms ? 'payment_terms_days' THEN (v_terms->>'payment_terms_days')::integer ELSE c.payment_terms_days END,
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
      WHEN v_terms ? 'standing_authority_limit' THEN (v_terms->>'standing_authority_limit')::numeric ELSE c.standing_authority_limit END
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
    'standing_authority_limit', v_after.standing_authority_limit);
END;
$function$;
COMMENT ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) IS 'Provider administrator sets how an agreement is billed (commercial_model) and optional terms (billing cycle, payment days, invoice email, PO, notes, rates, and for do and invoice the standing authority limit per job). Only listed keys are accepted; omitted keys are unchanged. Changing an existing model needs a reason. Audited with before/after.';
REVOKE ALL ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) TO postgres, authenticated;

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
    'commercial', (SELECT jsonb_build_object(
        'commercial_model', c.commercial_model,
        'uses_contract_extra', public.agreement_uses_contract_extra(v_agreement.id),
        'billing_cycle', c.billing_cycle, 'payment_terms_days', c.payment_terms_days, 'currency', c.currency,
        'base_rate_per_hour', c.base_rate_per_hour, 'overtime_rate_per_hour', c.overtime_rate_per_hour,
        'callout_rate_per_hour', c.callout_rate_per_hour, 'callout_minimum_hours', c.callout_minimum_hours,
        'travel_rate_per_km', c.travel_rate_per_km, 'invoice_email', c.invoice_email,
        'purchase_order_number', c.purchase_order_number, 'notes', c.notes, 'updated_at', c.updated_at,
        'standing_authority_limit', c.standing_authority_limit,
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
COMMENT ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) IS 'Read-only, provider-admin only: the agreement commercial model and terms (including the do-and-invoice standing authority limit and jobs over it still awaiting client approval), contracted vs Extra vs unclassified per month for one service agreement (imported patrol cost rows classified by classify_patrol_cost_row_billing_basis), dispatch charge lines by billing basis, Extra works orders, and the accepted-quote agreement price (null when not recorded).';
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
  ), mapped AS (
    -- Agreements not billed as fixed price plus Extra bill all their work: pay as you go at agreed
    -- rates, do and invoice at actuals under standing authority, per request against the client's request.
    SELECT s.service_agreement_id,
      CASE WHEN m.uses_ce THEN s.contract_cost ELSE 0 END AS contract_cost,
      CASE WHEN m.uses_ce THEN s.extra_cost ELSE 0 END AS extra_cost,
      CASE WHEN m.uses_ce THEN s.unclassified_cost ELSE 0 END AS unclassified_cost,
      CASE WHEN m.uses_ce THEN 0 ELSE s.contract_cost + s.extra_cost + s.unclassified_cost END AS billable_cost,
      CASE WHEN m.model = 'pay_as_you_go' THEN s.contract_cost + s.extra_cost + s.unclassified_cost ELSE 0 END AS rates_cost,
      CASE WHEN m.model = 'do_and_invoice' THEN s.contract_cost + s.extra_cost + s.unclassified_cost ELSE 0 END AS actuals_cost,
      CASE WHEN m.model = 'per_request' THEN s.contract_cost + s.extra_cost + s.unclassified_cost ELSE 0 END AS request_cost,
      s.other_cost, s.unlinked_cost, s.total_cost,
      CASE WHEN m.uses_ce THEN s.unclassified_rows ELSE 0 END AS unclassified_rows,
      CASE WHEN m.uses_ce THEN s.conflict_rows ELSE 0 END AS conflict_rows
    FROM split s
    CROSS JOIN LATERAL (SELECT public.agreement_uses_contract_extra(s.service_agreement_id) AS uses_ce,
      public.agreement_commercial_model(s.service_agreement_id) AS model) m
  ), by_agreement AS (
    SELECT s.service_agreement_id,
      round(sum(s.contract_cost), 2) AS contract_cost, round(sum(s.extra_cost), 2) AS extra_cost,
      round(sum(s.unclassified_cost), 2) AS unclassified_cost, round(sum(s.billable_cost), 2) AS billable_cost,
      round(sum(s.rates_cost), 2) AS rates_cost, round(sum(s.actuals_cost), 2) AS actuals_cost, round(sum(s.request_cost), 2) AS request_cost,
      round(sum(s.other_cost), 2) AS other_cost,
      round(sum(s.total_cost), 2) AS total_cost,
      sum(s.unclassified_rows)::integer AS unclassified_rows, sum(s.conflict_rows)::integer AS conflict_rows
    FROM mapped s GROUP BY s.service_agreement_id
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
        'billable_cost', round(coalesce(sum(billable_cost), 0), 2),
        'billable_by_model', jsonb_build_object(
          'pay_as_you_go', round(coalesce(sum(rates_cost), 0), 2),
          'do_and_invoice', round(coalesce(sum(actuals_cost), 0), 2),
          'per_request', round(coalesce(sum(request_cost), 0), 2)),
        'other_cost', round(coalesce(sum(other_cost), 0), 2),
        'unlinked_cost', round(coalesce(sum(unlinked_cost), 0), 2),
        'total_cost', round(coalesce(sum(total_cost), 0), 2),
        'unclassified_rows', coalesce(sum(unclassified_rows), 0)::integer,
        'conflict_rows', coalesce(sum(conflict_rows), 0)::integer) FROM mapped),
    'by_agreement', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'service_agreement_id', b.service_agreement_id,
        'agreement_name', sa.name,
        'client_name', client.name,
        'contract_cost', b.contract_cost, 'extra_cost', b.extra_cost,
        'unclassified_cost', b.unclassified_cost, 'billable_cost', b.billable_cost, 'other_cost', b.other_cost,
        'rates_cost', b.rates_cost, 'actuals_cost', b.actuals_cost, 'request_cost', b.request_cost,
        'total_cost', b.total_cost,
        'unclassified_rows', b.unclassified_rows, 'conflict_rows', b.conflict_rows,
        'agreement_price', p.total,
        'commercial_model', public.agreement_commercial_model(b.service_agreement_id)
      ) ORDER BY b.total_cost DESC, sa.name)
      FROM by_agreement b
      JOIN public.service_agreements sa ON sa.id = b.service_agreement_id
      LEFT JOIN public.organizations client ON client.id = sa.client_organization_id
      LEFT JOIN price p ON p.service_agreement_id = b.service_agreement_id), '[]'::jsonb),
    'basis_rule', 'Imported patrol cost is split by its linked workbook rows (TYPE column first, then the charge-code catalog basis). Dispatch cost follows the job billing choice. Agreements billed pay as you go, do and invoice or per request have no Contract/Extra split: all their work is billable — pay as you go at the agreed rates, do and invoice at actuals under the client''s standing authority, per request against each client request. Timesheet, overhead and manual cost is shown as other. Amounts are recorded service cost, not invoiced revenue.'
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
COMMENT ON FUNCTION public.get_finance_pl_period_billing_basis(uuid) IS 'Read-only, active finance administrator of the period organization only: splits the P&L period service cost into Contract, Extra, unclassified, billable (agreements not billed fixed price plus Extra; broken down into pay as you go at agreed rates, do and invoice at actuals, and per request) and other, per agreement with its commercial model. Totals reconcile to get_finance_pl_period_summary.total_cost. Does not modify finance_service_costs.';
REVOKE ALL ON FUNCTION public.get_finance_pl_period_billing_basis(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_finance_pl_period_billing_basis(uuid) TO postgres, authenticated, service_role;

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
  v_missing_reference integer := 0;
  v_missing_approval integer := 0;
  v_actuals_callouts integer := 0;
  v_billable_callouts integer := 0;
  v_terms_days integer := 14;
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
    SELECT coalesce(c.payment_terms_days, 14) INTO v_terms_days FROM public.crm_commercial_settings c WHERE c.service_agreement_id = p_service_agreement_id;
    v_terms_days := coalesce(v_terms_days, 14);
  END IF;

  INSERT INTO public.invoices (organization_id, client_organization_id, service_agreement_id, invoice_number, invoice_date, due_date, status, service_period_start, service_period_end, created_by)
  VALUES (p_organization_id, p_client_organization_id, p_service_agreement_id,
    'INV-' || to_char(now(), 'YYYYMMDD') || '-' || upper(substring(gen_random_uuid()::text, 1, 4)),
    current_date, current_date + v_terms_days, 'draft', p_period_start, p_period_end, v_actor)
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
      'payment_terms_days', v_terms_days));
  RETURN v_invoice;
END;
$function$;
COMMENT ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) IS 'Sweep completed, uninvoiced workshop lines, billable dispatch charge lines and ready patrol visit lines for one client into a single draft invoice (GST 15%). Callouts follow the agreement commercial model: fixed price plus Extra (or not set) bills Extra only, skips Contract and blocks while any callout has no decision; pay as you go bills every callout at agreed rates; do and invoice bills the actuals under standing authority (lines prefixed Actuals) and blocks a job that costs more than the agreement standing authority limit until it has the client''s approval reference; per request bills every callout and blocks until each job has the client reference. Due date uses the agreement payment terms when one agreement is invoiced (default 14 days). Stamps invoice_line_item_id on the source lines so nothing is billed twice. Idempotent on client_request_id; audited.';
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) TO postgres, authenticated;
