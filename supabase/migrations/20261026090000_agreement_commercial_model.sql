-- Per-agreement commercial model (owner ruling 2026-10-26).
--
-- Not every client is billed like OneFortyOne. Each service agreement now
-- records how its work is charged:
--   fixed_price_with_extras  fixed contract price; work outside it is Extra (OneFortyOne, STAND, ...)
--   pay_as_you_go            all work charged at the agreed rates, invoiced each billing cycle
--   do_and_invoice           standing authority: do what is needed, invoice the actuals
--   per_request              the client requests each job; each job carries the client's request/PO reference
--   NULL (not set)           today's behaviour: every callout needs a Contract/Extra decision
--
-- Only fixed_price_with_extras (and not set) uses the Contract/Extra decision.
-- The other models bill all completed work; per_request also requires the
-- client's request reference on the job before it can be invoiced.

ALTER TABLE public.crm_commercial_settings
  ADD COLUMN IF NOT EXISTS commercial_model text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.crm_commercial_settings DROP CONSTRAINT IF EXISTS crm_commercial_settings_commercial_model_check;
ALTER TABLE public.crm_commercial_settings ADD CONSTRAINT crm_commercial_settings_commercial_model_check
  CHECK (commercial_model IS NULL OR commercial_model IN ('fixed_price_with_extras', 'pay_as_you_go', 'do_and_invoice', 'per_request'));
CREATE UNIQUE INDEX IF NOT EXISTS crm_commercial_settings_agreement_key ON public.crm_commercial_settings (service_agreement_id);
COMMENT ON COLUMN public.crm_commercial_settings.commercial_model IS 'How work on this agreement is charged: fixed_price_with_extras (contract price + Extra), pay_as_you_go (all work at agreed rates each cycle), do_and_invoice (standing authority, invoice actuals), per_request (each job requested by the client, request/PO reference required). NULL = not set; every callout needs a Contract/Extra decision. Set only through set_agreement_commercial_terms (audited).';
COMMENT ON COLUMN public.crm_commercial_settings.updated_at IS 'Last change through set_agreement_commercial_terms.';

ALTER TABLE public.dispatch_jobs ADD COLUMN IF NOT EXISTS client_order_reference text;
ALTER TABLE public.dispatch_jobs DROP CONSTRAINT IF EXISTS dispatch_jobs_client_order_reference_check;
ALTER TABLE public.dispatch_jobs ADD CONSTRAINT dispatch_jobs_client_order_reference_check
  CHECK (client_order_reference IS NULL OR char_length(btrim(client_order_reference)) BETWEEN 1 AND 120);
COMMENT ON COLUMN public.dispatch_jobs.client_order_reference IS 'The client''s own request or purchase-order reference for this job. Required before invoicing on per_request agreements. Set only through set_dispatch_job_client_reference (audited).';

CREATE OR REPLACE FUNCTION public.agreement_commercial_model(p_service_agreement_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT c.commercial_model FROM public.crm_commercial_settings c WHERE c.service_agreement_id = p_service_agreement_id;
$function$;
COMMENT ON FUNCTION public.agreement_commercial_model(uuid) IS 'Internal: the commercial model of one service agreement, NULL when not set or when there is no agreement.';
REVOKE ALL ON FUNCTION public.agreement_commercial_model(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agreement_commercial_model(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.agreement_uses_contract_extra(p_service_agreement_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT coalesce(public.agreement_commercial_model(p_service_agreement_id), 'fixed_price_with_extras') = 'fixed_price_with_extras';
$function$;
COMMENT ON FUNCTION public.agreement_uses_contract_extra(uuid) IS 'Internal: true when callouts on this agreement need a Contract/Extra decision (fixed price + Extra, or model not set). False for pay as you go, do and invoice, and per request, where all completed work is billed.';
REVOKE ALL ON FUNCTION public.agreement_uses_contract_extra(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agreement_uses_contract_extra(uuid) TO postgres;

CREATE OR REPLACE FUNCTION public.commercial_model_label(p_model text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE p_model
    WHEN 'fixed_price_with_extras' THEN 'fixed price plus Extra'
    WHEN 'pay_as_you_go' THEN 'pay as you go'
    WHEN 'do_and_invoice' THEN 'do and invoice'
    WHEN 'per_request' THEN 'per request'
    ELSE 'not set' END;
$function$;
REVOKE ALL ON FUNCTION public.commercial_model_label(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.commercial_model_label(text) TO postgres;

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
                  'base_rate_per_hour', 'overtime_rate_per_hour', 'callout_rate_per_hour', 'callout_minimum_hours', 'travel_rate_per_km')
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
  ON CONFLICT (service_agreement_id) DO UPDATE SET commercial_model = EXCLUDED.commercial_model, updated_at = now();

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
    travel_rate_per_km = CASE WHEN v_terms ? 'travel_rate_per_km' THEN (v_terms->>'travel_rate_per_km')::numeric ELSE c.travel_rate_per_km END
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
    'billing_cycle', v_after.billing_cycle, 'payment_terms_days', v_after.payment_terms_days);
END;
$function$;
COMMENT ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) IS 'Provider administrator sets how an agreement is billed (commercial_model) and optional terms (billing cycle, payment days, invoice email, PO, notes, rates). Only listed keys are accepted; omitted keys are unchanged. Changing an existing model needs a reason. Audited with before/after.';
REVOKE ALL ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_agreement_commercial_terms(uuid, text, jsonb, text) TO postgres, authenticated;

CREATE OR REPLACE FUNCTION public.set_dispatch_job_client_reference(p_job_id uuid, p_reference text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_job public.dispatch_jobs%ROWTYPE;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_job.organization_id) THEN
    RAISE EXCEPTION 'Not authorised to change dispatch jobs for this organisation';
  END IF;
  IF v_reference IS NULL THEN RAISE EXCEPTION 'Enter the client''s request or purchase-order reference'; END IF;
  IF char_length(v_reference) > 120 THEN RAISE EXCEPTION 'Reference is limited to 120 characters'; END IF;
  IF v_job.client_order_reference IS NOT DISTINCT FROM v_reference THEN
    RETURN jsonb_build_object('job_id', v_job.id, 'client_order_reference', v_reference, 'changed', false);
  END IF;
  IF v_job.client_order_reference IS NOT NULL AND char_length(coalesce(v_reason, '')) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Say why the client reference is changing (3 to 500 characters)';
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_job_charge_lines l WHERE l.source_dispatch_id = v_job.id AND l.invoice_line_item_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This job is already invoiced; correct the reference on the invoice, not here';
  END IF;

  PERFORM set_config('fcm.dispatch_billing_rpc', 'on', true);
  UPDATE public.dispatch_jobs SET client_order_reference = v_reference WHERE id = v_job.id;
  PERFORM set_config('fcm.dispatch_billing_rpc', 'off', true);

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, v_actor, 'dispatch_job_client_reference_set', 'dispatch_jobs', v_job.id,
    jsonb_strip_nulls(jsonb_build_object('service_agreement_id', v_job.service_agreement_id, 'reason', v_reason,
      'before', v_job.client_order_reference, 'after', v_reference)));
  RETURN jsonb_build_object('job_id', v_job.id, 'client_order_reference', v_reference, 'changed', true);
END;
$function$;
COMMENT ON FUNCTION public.set_dispatch_job_client_reference(uuid, text, text) IS 'Dispatcher (provider administrator) records the client''s request or purchase-order reference on a dispatch job. Required before invoicing on per_request agreements. Reason required to change an existing reference; refuses invoiced jobs; audited.';
REVOKE ALL ON FUNCTION public.set_dispatch_job_client_reference(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_dispatch_job_client_reference(uuid, text, text) TO postgres, authenticated;

CREATE OR REPLACE FUNCTION public.guard_dispatch_job_billing_basis()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF coalesce(current_setting('fcm.dispatch_billing_rpc', true), '') = 'on' AND current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.billing_basis IS NOT NULL OR NEW.extra_work_order_id IS NOT NULL OR NEW.billing_basis_set_at IS NOT NULL OR NEW.billing_basis_set_by IS NOT NULL THEN
      RAISE EXCEPTION 'Dispatch billing basis is set through set_dispatch_job_billing_basis';
    END IF;
    IF NEW.client_order_reference IS NOT NULL THEN
      RAISE EXCEPTION 'The client reference is set through set_dispatch_job_client_reference';
    END IF;
  ELSE
    IF NEW.billing_basis IS DISTINCT FROM OLD.billing_basis
       OR NEW.extra_work_order_id IS DISTINCT FROM OLD.extra_work_order_id
       OR NEW.billing_basis_set_at IS DISTINCT FROM OLD.billing_basis_set_at
       OR NEW.billing_basis_set_by IS DISTINCT FROM OLD.billing_basis_set_by THEN
      RAISE EXCEPTION 'Dispatch billing basis is set through set_dispatch_job_billing_basis';
    END IF;
    IF NEW.client_order_reference IS DISTINCT FROM OLD.client_order_reference THEN
      RAISE EXCEPTION 'The client reference is set through set_dispatch_job_client_reference';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_dispatch_job_billing_basis() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.guard_dispatch_job_billing_basis() TO postgres;

CREATE OR REPLACE FUNCTION "public"."set_dispatch_job_billing_basis"(p_job_id uuid, p_billing_basis text, p_extra_work_order_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_job public.dispatch_jobs%rowtype;
  v_order public.agreement_extra_work_orders%rowtype;
  v_job_day date;
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_job.organization_id) THEN
    RAISE EXCEPTION 'Not authorised to classify dispatch jobs for this organisation';
  END IF;
  IF p_billing_basis IS NULL OR p_billing_basis NOT IN ('contract', 'extra') THEN
    RAISE EXCEPTION 'Billing basis must be contract or extra';
  END IF;
  IF NOT public.agreement_uses_contract_extra(v_job.service_agreement_id) THEN
    RAISE EXCEPTION 'This agreement is billed %; Contracted work and Extra do not apply. All completed work on it is billed.',
      public.commercial_model_label(public.agreement_commercial_model(v_job.service_agreement_id));
  END IF;
  IF p_extra_work_order_id IS NOT NULL AND p_billing_basis <> 'extra' THEN
    RAISE EXCEPTION 'Only Extra jobs can sit under an Extra works order';
  END IF;
  IF v_job.billing_basis IS NOT NULL
     AND (v_job.billing_basis IS DISTINCT FROM p_billing_basis OR v_job.extra_work_order_id IS DISTINCT FROM p_extra_work_order_id)
     AND char_length(btrim(coalesce(p_reason, ''))) NOT BETWEEN 3 AND 500 THEN
    RAISE EXCEPTION 'Say why the billing basis is changing (3 to 500 characters)';
  END IF;
  IF v_job.billing_basis IS NOT DISTINCT FROM p_billing_basis AND v_job.extra_work_order_id IS NOT DISTINCT FROM p_extra_work_order_id THEN
    RETURN jsonb_build_object('job_id', v_job.id, 'billing_basis', v_job.billing_basis, 'extra_work_order_id', v_job.extra_work_order_id, 'changed', false);
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_job_charge_lines l WHERE l.source_dispatch_id = v_job.id AND l.invoice_line_item_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This job is already invoiced; correct the billing basis through a credit note, not here';
  END IF;

  IF p_extra_work_order_id IS NOT NULL THEN
    SELECT * INTO v_order FROM public.agreement_extra_work_orders WHERE id = p_extra_work_order_id;
    IF NOT FOUND OR v_order.service_agreement_id IS DISTINCT FROM v_job.service_agreement_id THEN
      RAISE EXCEPTION 'The Extra works order must belong to the same service agreement as the job';
    END IF;
    v_job_day := (v_job.created_at AT TIME ZONE 'Pacific/Auckland')::date;
    IF v_job_day < v_order.starts_on OR (v_order.ends_on IS NOT NULL AND v_job_day > v_order.ends_on) THEN
      RAISE EXCEPTION 'Extra works order % was not in force on %', v_order.reference, to_char(v_job_day, 'DD Mon YYYY');
    END IF;
  END IF;

  PERFORM set_config('fcm.dispatch_billing_rpc', 'on', true);
  UPDATE public.dispatch_jobs
  SET billing_basis = p_billing_basis, extra_work_order_id = p_extra_work_order_id,
      billing_basis_set_at = clock_timestamp(), billing_basis_set_by = v_actor
  WHERE id = v_job.id;
  UPDATE public.dispatch_job_charge_lines
  SET billing_basis = p_billing_basis, extra_work_order_id = p_extra_work_order_id
  WHERE source_dispatch_id = v_job.id;
  PERFORM set_config('fcm.dispatch_billing_rpc', 'off', true);

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, v_actor, 'dispatch_job_billing_basis_set', 'dispatch_jobs', v_job.id,
    jsonb_strip_nulls(jsonb_build_object(
      'service_agreement_id', v_job.service_agreement_id, 'reason', nullif(btrim(p_reason), ''),
      'before', jsonb_build_object('billing_basis', v_job.billing_basis, 'extra_work_order_id', v_job.extra_work_order_id),
      'after', jsonb_build_object('billing_basis', p_billing_basis, 'extra_work_order_id', p_extra_work_order_id, 'extra_work_order_reference', v_order.reference))));
  RETURN jsonb_build_object('job_id', v_job.id, 'billing_basis', p_billing_basis, 'extra_work_order_id', p_extra_work_order_id, 'extra_work_order_reference', v_order.reference, 'changed', true);
END;
$function$;
COMMENT ON FUNCTION public.set_dispatch_job_billing_basis(uuid, text, uuid, text) IS 'Dispatcher (provider administrator) marks a dispatch job as contracted work or Extra, optionally under an in-force Extra works order of the same agreement. Refused when the agreement commercial model is not fixed price plus Extra. Reason required to change an existing classification; audited.';
REVOKE ALL ON FUNCTION public.set_dispatch_job_billing_basis(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_dispatch_job_billing_basis(uuid, text, uuid, text) TO postgres, authenticated;

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
        'purchase_order_number', c.purchase_order_number, 'notes', c.notes, 'updated_at', c.updated_at)
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
COMMENT ON FUNCTION public.get_agreement_billing_basis_summary(uuid, date, date) IS 'Read-only, provider-admin only: the agreement commercial model and terms, contracted vs Extra vs unclassified per month for one service agreement (imported patrol cost rows classified by classify_patrol_cost_row_billing_basis), dispatch charge lines by billing basis, Extra works orders, and the accepted-quote agreement price (null when not recorded).';
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
    -- Agreements not billed as fixed price plus Extra bill all their work at agreed rates.
    SELECT s.service_agreement_id,
      CASE WHEN m.uses_ce THEN s.contract_cost ELSE 0 END AS contract_cost,
      CASE WHEN m.uses_ce THEN s.extra_cost ELSE 0 END AS extra_cost,
      CASE WHEN m.uses_ce THEN s.unclassified_cost ELSE 0 END AS unclassified_cost,
      CASE WHEN m.uses_ce THEN 0 ELSE s.contract_cost + s.extra_cost + s.unclassified_cost END AS billable_cost,
      s.other_cost, s.unlinked_cost, s.total_cost,
      CASE WHEN m.uses_ce THEN s.unclassified_rows ELSE 0 END AS unclassified_rows,
      CASE WHEN m.uses_ce THEN s.conflict_rows ELSE 0 END AS conflict_rows
    FROM split s
    CROSS JOIN LATERAL (SELECT public.agreement_uses_contract_extra(s.service_agreement_id) AS uses_ce) m
  ), by_agreement AS (
    SELECT s.service_agreement_id,
      round(sum(s.contract_cost), 2) AS contract_cost, round(sum(s.extra_cost), 2) AS extra_cost,
      round(sum(s.unclassified_cost), 2) AS unclassified_cost, round(sum(s.billable_cost), 2) AS billable_cost,
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
        'total_cost', b.total_cost,
        'unclassified_rows', b.unclassified_rows, 'conflict_rows', b.conflict_rows,
        'agreement_price', p.total,
        'commercial_model', public.agreement_commercial_model(b.service_agreement_id)
      ) ORDER BY b.total_cost DESC, sa.name)
      FROM by_agreement b
      JOIN public.service_agreements sa ON sa.id = b.service_agreement_id
      LEFT JOIN public.organizations client ON client.id = sa.client_organization_id
      LEFT JOIN price p ON p.service_agreement_id = b.service_agreement_id), '[]'::jsonb),
    'basis_rule', 'Imported patrol cost is split by its linked workbook rows (TYPE column first, then the charge-code catalog basis). Dispatch cost follows the job billing choice. Agreements billed pay as you go, do and invoice or per request have no Contract/Extra split: their work is shown as billable at agreed rates. Timesheet, overhead and manual cost is shown as other. Amounts are recorded service cost, not invoiced revenue.'
  ) INTO v_result;
  RETURN v_result;
END;
$function$;
COMMENT ON FUNCTION public.get_finance_pl_period_billing_basis(uuid) IS 'Read-only, active finance administrator of the period organization only: splits the P&L period service cost into Contract, Extra, unclassified, billable (agreements not billed fixed price plus Extra) and other, per agreement with its commercial model. Totals reconcile to get_finance_pl_period_summary.total_cost. Does not modify finance_service_costs.';
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
    count(*) FILTER (WHERE NOT x.uses_ce)::integer
    INTO v_unclassified, v_contract_skipped, v_missing_reference, v_billable_callouts
  FROM (
    SELECT line.billing_basis, job.client_order_reference,
      public.agreement_uses_contract_extra(line.service_agreement_id) AS uses_ce,
      public.agreement_commercial_model(line.service_agreement_id) AS model
    FROM public.dispatch_job_charge_lines line
    LEFT JOIN public.dispatch_jobs job ON job.id = line.source_dispatch_id
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
      ewo.reference AS extra_reference, job.client_order_reference, x.uses_ce
    FROM public.dispatch_job_charge_lines line
    LEFT JOIN public.agreement_extra_work_orders ewo ON ewo.id = line.extra_work_order_id
    LEFT JOIN public.dispatch_jobs job ON job.id = line.source_dispatch_id
    CROSS JOIN LATERAL (SELECT public.agreement_uses_contract_extra(line.service_agreement_id) AS uses_ce) x
    WHERE line.organization_id = p_organization_id AND line.client_organization_id = p_client_organization_id
      AND (line.billing_basis = 'extra' OR NOT x.uses_ce)
      AND line.invoice_line_item_id IS NULL AND line.created_at::date BETWEEN v_start AND v_end
      AND (p_service_agreement_id IS NULL OR line.service_agreement_id IS NULL OR line.service_agreement_id = p_service_agreement_id)
    ORDER BY line.created_at
  LOOP
    v_count := v_count + 1;
    INSERT INTO public.invoice_line_items (invoice_id, line_number, description, quantity, unit_price, line_total, organization_id, item_type, source_dispatch_id, created_by)
    VALUES (v_invoice.id, v_count,
      CASE WHEN v_row.uses_ce THEN 'Extra' || coalesce(' ' || v_row.extra_reference, '') || ' — ' ELSE '' END
        || coalesce('Client ref ' || v_row.client_order_reference || ' — ', '')
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
      'payment_terms_days', v_terms_days));
  RETURN v_invoice;
END;
$function$;
COMMENT ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) IS 'Sweep completed, uninvoiced workshop lines, billable dispatch charge lines and ready patrol visit lines for one client into a single draft invoice (GST 15%). Callouts follow the agreement commercial model: fixed price plus Extra (or not set) bills Extra only, skips Contract and blocks while any callout has no decision; pay as you go, do and invoice and per request bill every callout, and per request blocks until each job has the client reference. Due date uses the agreement payment terms when one agreement is invoiced (default 14 days). Stamps invoice_line_item_id on the source lines so nothing is billed twice. Idempotent on client_request_id; audited.';
REVOKE ALL ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date) TO postgres, authenticated;

-- Owner-confirmed commercial models for the R&M agreements (2026-10-26).
-- Billing cycle and payment terms stay at the table defaults until confirmed per client.
DO $seed$
DECLARE
  v_row record;
  v_settings_id uuid;
  v_agreement public.service_agreements%ROWTYPE;
BEGIN
  FOR v_row IN
    SELECT * FROM (VALUES
      ('c36761e5-1634-419d-9ae5-234d3ec934ec'::uuid, 'fixed_price_with_extras'), -- OneFortyOne
      ('ea29860c-54ad-4ae8-99af-2295bfd3af32'::uuid, 'fixed_price_with_extras'), -- STAND (PF Olsen)
      ('ea833b30-62bb-4f63-a390-feef857edc99'::uuid, 'fixed_price_with_extras'), -- Tasman District Council
      ('ff245fea-4ba7-4dd0-bc59-36fd22becb9d'::uuid, 'fixed_price_with_extras'), -- Birdhurst
      ('1febbf58-9f9a-4738-86c6-32061d6e6bdd'::uuid, 'fixed_price_with_extras'), -- Stringer
      ('ad2a5116-c480-4ee8-bdff-87b4d0da03e9'::uuid, 'fixed_price_with_extras'), -- Wrattens
      ('a3a145e2-487b-43b5-b9e6-f930791c4817'::uuid, 'fixed_price_with_extras'), -- Thomas Bros
      ('a9f026fa-7383-4277-b066-61ce109e9525'::uuid, 'fixed_price_with_extras'), -- Taylors Contracting
      ('58eed793-3b77-4d9c-bfab-ee95e7d2fe3a'::uuid, 'pay_as_you_go'),           -- Nelson City Council
      ('cd5a09f1-ee13-4d50-b061-7d0830504911'::uuid, 'pay_as_you_go'),           -- R&M Other Private Clients
      ('76d81924-97df-40ba-80d0-488c4ae14776'::uuid, 'pay_as_you_go'),           -- Private - Parks
      ('8e8b4f6a-22c4-4790-a75f-484c3aad2685'::uuid, 'pay_as_you_go'),           -- Private - Redvale - Merc
      ('4586f744-fa1a-4cb7-95a1-9b018034712f'::uuid, 'do_and_invoice'),          -- Tasman Pine Forests
      ('909fc41b-2118-46a2-84e4-02a6c2b7ea97'::uuid, 'do_and_invoice'),          -- Merril and Ring
      ('e53834ad-0a20-4d84-ba31-c7dbbb611939'::uuid, 'do_and_invoice'),          -- NMDHB
      ('5da711eb-fc09-4cc5-ae08-450c0bbe6d0e'::uuid, 'do_and_invoice'),          -- NZ Health
      ('4b8d20b7-20f8-4a94-8a11-a7eef0dee2ac'::uuid, 'per_request'),             -- Department of Conservation
      ('06d3a4fa-415f-41be-b276-bd58cc28ec2f'::uuid, 'per_request'),             -- Fulton Hogan (Maitai Dam)
      ('93c28500-430b-4dd1-a143-af737146bb7d'::uuid, 'per_request')              -- Operation Lizard (DART)
    ) AS t(agreement_id, model)
  LOOP
    SELECT * INTO v_agreement FROM public.service_agreements WHERE id = v_row.agreement_id;
    CONTINUE WHEN NOT FOUND;
    CONTINUE WHEN EXISTS (SELECT 1 FROM public.crm_commercial_settings c WHERE c.service_agreement_id = v_row.agreement_id AND c.commercial_model IS NOT NULL);
    INSERT INTO public.crm_commercial_settings (service_agreement_id, commercial_model, notes, updated_at)
    VALUES (v_row.agreement_id, v_row.model, 'Billing model confirmed by the owner 2026-10-26. Billing cycle and payment terms are defaults until confirmed for this client.', now())
    ON CONFLICT (service_agreement_id) DO UPDATE SET commercial_model = EXCLUDED.commercial_model, updated_at = now()
    RETURNING id INTO v_settings_id;
    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_agreement.provider_organization_id, NULL, 'agreement_commercial_terms_set', 'crm_commercial_settings', v_settings_id,
      jsonb_build_object('service_agreement_id', v_row.agreement_id, 'reason', 'Owner-confirmed billing model (migration 20261026090000)',
        'after', jsonb_build_object('commercial_model', v_row.model)));
  END LOOP;
END
$seed$;

-- OneFortyOne fixed monthly contract price as an accepted quote (owner decision 2026-10-26;
-- amount from the OneFortyOne workbook Sheet2). Inserted as draft, then accepted, so the
-- accepted-quote commercial snapshot is captured.
DO $quote$
DECLARE
  v_agreement public.service_agreements%ROWTYPE;
  v_quote_id uuid;
  -- The platform owner approved the price; the snapshot requires a named approver.
  v_approver uuid := (SELECT p.id FROM public.user_profiles p WHERE p.id = '1b02ab97-8611-40ab-a3a0-b5c74589db58' AND p.deactivated_at IS NULL);
BEGIN
  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = 'c36761e5-1634-419d-9ae5-234d3ec934ec';
  IF NOT FOUND OR v_approver IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.quotes q WHERE q.service_agreement_id = v_agreement.id AND q.status = 'accepted') THEN RETURN; END IF;
  INSERT INTO public.quotes (provider_org_id, client_org_id, title, status, currency, gst_rate, total_cost, subtotal_charge, discount_amount, gst_amount, total_charge, notes, service_agreement_id, created_by)
  VALUES (v_agreement.provider_organization_id, v_agreement.client_organization_id, 'OneFortyOne fixed monthly contract price', 'draft', 'NZD', 0.15,
    0, 13333, 0, round(13333 * 0.15, 2), round(13333 * 1.15, 2),
    'Fixed monthly price for the contracted security service, as recorded in the OneFortyOne workbook (Sheet2). Work outside the contract is Extra and billed on top. Recorded on owner instruction 2026-10-26.',
    v_agreement.id, v_approver)
  RETURNING id INTO v_quote_id;
  INSERT INTO public.quote_lines (quote_id, kind, description, quantity, unit_cost, unit_charge, line_order)
  VALUES (v_quote_id, 'custom', 'Contracted forest security service - fixed price per month', 1, 0, 13333, 0);
  UPDATE public.quotes SET status = 'accepted', accepted_at = now(), accepted_by = v_approver WHERE id = v_quote_id;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_agreement.provider_organization_id, v_approver, 'agreement_contract_price_recorded', 'quotes', v_quote_id,
    jsonb_build_object('service_agreement_id', v_agreement.id, 'source', 'OneFortyOne workbook Sheet2', 'period', 'month',
      'reason', 'Owner decision 2026-10-26 (migration 20261026090000)'));
END
$quote$;
