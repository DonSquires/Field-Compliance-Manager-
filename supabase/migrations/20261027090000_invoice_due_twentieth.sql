-- Owner ruling 2026-10-25: R&M bills monthly. Work for a month is invoiced in the
-- first week of the next month and is due on the 20th of that month (October
-- work, invoiced early November, due 20 November). All agreed rates and prices
-- are before GST; GST is added at invoice. No standing authority limit applies
-- unless one is entered.
--
-- Payment terms were only "N days after the invoice date" (default 14), and the
-- agreement-price invoice ignored the agreement terms entirely (always 14 days).
-- This adds a due day of the following month per agreement, used by both invoice
-- generators, and sets every R&M agreement to monthly billing due on the 20th.

ALTER TABLE public.crm_commercial_settings ADD COLUMN IF NOT EXISTS payment_due_day_of_month smallint;
ALTER TABLE public.crm_commercial_settings DROP CONSTRAINT IF EXISTS crm_commercial_settings_payment_due_day_check;
ALTER TABLE public.crm_commercial_settings ADD CONSTRAINT crm_commercial_settings_payment_due_day_check
  CHECK (payment_due_day_of_month IS NULL OR payment_due_day_of_month BETWEEN 1 AND 28);
COMMENT ON COLUMN public.crm_commercial_settings.payment_due_day_of_month IS 'When set, an invoice is due on this day of the month after the invoiced work period (20 = 20th of the following month), and never before the invoice date. Overrides payment_terms_days. NULL = payment_terms_days after the invoice date. Set only through set_agreement_commercial_terms (audited).';
COMMENT ON COLUMN public.crm_commercial_settings.payment_terms_days IS 'Days after the invoice date that payment is due, used only when payment_due_day_of_month is not set.';
COMMENT ON COLUMN public.crm_commercial_settings.base_rate_per_hour IS 'Agreed hourly rate, before GST.';
COMMENT ON COLUMN public.crm_commercial_settings.overtime_rate_per_hour IS 'Agreed overtime hourly rate, before GST.';
COMMENT ON COLUMN public.crm_commercial_settings.callout_rate_per_hour IS 'Agreed callout hourly rate, before GST.';
COMMENT ON COLUMN public.crm_commercial_settings.travel_rate_per_km IS 'Agreed travel rate per km, before GST.';

CREATE OR REPLACE FUNCTION public.invoice_due_date(p_invoice_date date, p_period_end date, p_terms_days integer, p_due_day integer)
 RETURNS date
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN p_due_day IS NULL THEN p_invoice_date + coalesce(p_terms_days, 14)
    -- The due day of the month after the work, rolled to the next one if the invoice is raised after it.
    ELSE greatest(
      (date_trunc('month', coalesce(p_period_end, p_invoice_date)) + interval '1 month')::date + (p_due_day - 1),
      (date_trunc('month', p_invoice_date) + CASE WHEN extract(day FROM p_invoice_date) > p_due_day THEN interval '1 month' ELSE interval '0 days' END)::date + (p_due_day - 1))
  END
$function$;
COMMENT ON FUNCTION public.invoice_due_date(date, date, integer, integer) IS 'Invoice due date: with a due day, that day of the month after the period end (invoice date when no period), never before the invoice date; otherwise the invoice date plus the payment terms days (default 14).';
REVOKE ALL ON FUNCTION public.invoice_due_date(date, date, integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_due_date(date, date, integer, integer) TO postgres, authenticated, service_role;

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
                  'standing_authority_limit', 'payment_due_day_of_month')
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
    'payment_due_day_of_month', v_after.payment_due_day_of_month,
    'standing_authority_limit', v_after.standing_authority_limit);
END;
$function$;
COMMENT ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) IS 'Provider administrator sets how an agreement is billed (commercial_model) and optional terms (billing cycle, payment days or due day of the following month, invoice email, PO, notes, rates, and for do and invoice the standing authority limit per job). Only listed keys are accepted; omitted keys are unchanged. Changing an existing model needs a reason. Audited with before/after.';
REVOKE ALL ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) TO postgres, authenticated;

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
COMMENT ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) IS 'Sweep completed, uninvoiced workshop lines, billable dispatch charge lines and ready patrol visit lines for one client into a single draft invoice (GST 15%). Callouts follow the agreement commercial model: fixed price plus Extra (or not set) bills Extra only, skips Contract and blocks while any callout has no decision; pay as you go bills every callout at agreed rates; do and invoice bills the actuals under standing authority (lines prefixed Actuals) and blocks a job that costs more than the agreement standing authority limit until it has the client''s approval reference; per request bills every callout and blocks until each job has the client reference. Due date follows the agreement payment terms when one agreement is invoiced: the due day of the month after the invoiced period when set (never before the invoice date), otherwise payment_terms_days after the invoice date (default 14). Stamps invoice_line_item_id on the source lines so nothing is billed twice. Idempotent on client_request_id; audited.';
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) TO postgres, authenticated;

CREATE OR REPLACE FUNCTION public.generate_crm_invoice_from_agreement(p_client_request_id uuid, p_service_agreement_id uuid, p_service_period_start date, p_service_period_end date)
 RETURNS TABLE(invoice_id uuid, invoice_number text, client_organization_id uuid, subtotal numeric, gst_amount numeric, total_amount numeric, line_item_count integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_agreement public.service_agreements%rowtype; v_invoice public.invoices%rowtype; v_inv_number text; v_count integer:=0; v_qline record; v_comm public.crm_commercial_settings%rowtype;
BEGIN
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id=p_service_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Not authorised to invoice for this agreement'; END IF;
  IF v_agreement.invitation_status <> 'accepted' AND NOT v_agreement.client_portal_finance_enabled THEN
    RAISE EXCEPTION 'Client approval or an active finance-share invite is required before invoicing this agreement';
  END IF;
  IF p_service_period_end < p_service_period_start THEN RAISE EXCEPTION 'Service period end cannot precede service period start'; END IF;
  SELECT * INTO v_comm FROM public.crm_commercial_settings WHERE service_agreement_id=v_agreement.id;
  SELECT 'INV-'||to_char(now(),'YYYYMMDD')||'-'||upper(substring(gen_random_uuid()::text,1,4)) INTO v_inv_number;
  INSERT INTO public.invoices(organization_id,client_organization_id,service_agreement_id,invoice_number,invoice_date,due_date,status,service_period_start,service_period_end,created_by)
  VALUES(v_agreement.provider_organization_id,v_agreement.client_organization_id,v_agreement.id,v_inv_number,current_date,public.invoice_due_date(current_date,p_service_period_end,v_comm.payment_terms_days,v_comm.payment_due_day_of_month),'draft',p_service_period_start,p_service_period_end,v_actor) RETURNING * INTO v_invoice;
  FOR v_qline IN SELECT line.description,line.quantity,line.unit_charge FROM public.quotes quote JOIN public.quote_lines line ON line.quote_id=quote.id WHERE quote.service_agreement_id=v_agreement.id AND quote.status='accepted' LOOP
    v_count:=v_count+1; INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id) VALUES(v_invoice.id,v_count,v_qline.description,v_qline.quantity,v_qline.unit_charge,round(v_qline.quantity*v_qline.unit_charge,2),v_invoice.organization_id);
  END LOOP;
  IF v_count=0 THEN
    SELECT * INTO v_comm FROM public.crm_commercial_settings WHERE service_agreement_id=v_agreement.id;
    IF FOUND AND v_comm.base_rate_per_hour IS NOT NULL AND v_comm.base_rate_per_hour>0 THEN
      v_count:=1; INSERT INTO public.invoice_line_items(invoice_id,line_number,description,quantity,unit_price,line_total,organization_id) VALUES(v_invoice.id,1,'Service Agreement Base Retainer',1,v_comm.base_rate_per_hour,v_comm.base_rate_per_hour,v_invoice.organization_id);
    ELSE RAISE EXCEPTION 'Commercial configuration incomplete: an accepted quote line or positive agreement rate is required before invoicing'; END IF;
  END IF;
  UPDATE public.invoices invoice SET subtotal=totals.subtotal,gst_amount=round(totals.subtotal*.15,2),total_amount=round(totals.subtotal*1.15,2),updated_at=now() FROM (SELECT coalesce(sum(line.line_total),0)::numeric(12,2) subtotal FROM public.invoice_line_items line WHERE line.invoice_id=v_invoice.id) totals WHERE invoice.id=v_invoice.id RETURNING invoice.* INTO v_invoice;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_invoice.organization_id,v_actor,'crm_invoice_generated_from_agreement','invoices',v_invoice.id,jsonb_build_object('service_agreement_id',v_agreement.id,'invoice_number',v_invoice.invoice_number,'subtotal',v_invoice.subtotal,'total_amount',v_invoice.total_amount,'line_item_count',v_count,'client_request_id',p_client_request_id,'due_date',v_invoice.due_date));
  RETURN QUERY SELECT v_invoice.id,v_invoice.invoice_number,v_invoice.client_organization_id,v_invoice.subtotal,v_invoice.gst_amount,v_invoice.total_amount,v_count;
EXCEPTION WHEN OTHERS THEN
  IF v_invoice.id IS NOT NULL THEN DELETE FROM public.invoices WHERE id=v_invoice.id; END IF;
  RAISE;
END; $function$;
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_agreement(uuid, uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_agreement(uuid, uuid, date, date) TO postgres, authenticated, service_role;

-- Every R&M agreement: monthly, due on the 20th of the following month. Audited.
WITH changed AS (
  UPDATE public.crm_commercial_settings c
  SET billing_cycle = 'monthly', payment_due_day_of_month = 20, updated_at = now()
  FROM public.service_agreements a
  WHERE a.id = c.service_agreement_id
    AND a.provider_organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'
    AND (c.billing_cycle IS DISTINCT FROM 'monthly' OR c.payment_due_day_of_month IS DISTINCT FROM 20)
  RETURNING c.id, c.service_agreement_id
)
INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13', NULL, 'agreement_commercial_terms_set', 'crm_commercial_settings', changed.id,
  jsonb_build_object('service_agreement_id', changed.service_agreement_id,
    'reason', 'Owner ruling 2026-10-25: invoiced monthly, due on the 20th of the following month; all prices before GST',
    'after', jsonb_build_object('billing_cycle', 'monthly', 'payment_due_day_of_month', 20),
    'migration', '20261027090000_invoice_due_twentieth')
FROM changed;
