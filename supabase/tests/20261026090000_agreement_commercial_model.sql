-- Behavioural truth table for per-agreement commercial models (fixed price plus Extra, pay as you go,
-- do and invoice, per request): terms RPC, client reference, Dispatch refusal, invoicing and the period split.
-- Runs in a transaction and rolls back.
BEGIN;
SET LOCAL role postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL role authenticated;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN SET LOCAL role postgres; END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.raises(p_sql text, p_fragment text) RETURNS boolean LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN false;
EXCEPTION WHEN others THEN
  IF sqlerrm NOT LIKE '%' || p_fragment || '%' THEN RAISE NOTICE 'unexpected error: %', sqlerrm; END IF;
  RETURN sqlerrm LIKE '%' || p_fragment || '%';
END $$;

DO $$
DECLARE
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_outsider_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_payg uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_fixed uuid := gen_random_uuid();
  v_site_payg uuid := gen_random_uuid();
  v_site_request uuid := gen_random_uuid();
  v_site_fixed uuid := gen_random_uuid();
  v_period uuid := gen_random_uuid();
  v_job_payg uuid;
  v_job_request uuid;
  v_job_fixed uuid;
  v_result jsonb;
  v_invoice public.invoices%ROWTYPE;
  v_split jsonb;
  v_pl_total numeric;
  v_payg_row jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type, active, status) VALUES
    (v_provider, 'Model Provider', 'service_provider', true, 'active'),
    (v_client, 'Model Client', 'government', true, 'active'),
    (v_outsider_org, 'Model Outsider', 'service_provider', true, 'active');
  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name) VALUES
    (v_admin, 'master', v_provider, v_provider, 'Model Admin'),
    (v_outsider, 'master', v_outsider_org, v_outsider_org, 'Model Outsider');
  INSERT INTO public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status) VALUES
    (v_payg, v_provider, v_client, 'Parks Pay As You Go', 'operational', current_date - 30, 'accepted'),
    (v_request, v_provider, v_client, 'Dam Per Request', 'operational', current_date - 30, 'accepted'),
    (v_fixed, v_provider, v_client, 'Forest Fixed', 'operational', current_date - 30, 'accepted');
  INSERT INTO public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active) VALUES
    (v_site_payg, v_client, v_provider, 'Park Gate', '1 Park Road', st_setsrid(st_makepoint(173.0, -41.4), 4326), -41.4, 173.0, true),
    (v_site_request, v_client, v_provider, 'Dam Gate', '1 Dam Road', st_setsrid(st_makepoint(173.1, -41.3), 4326), -41.3, 173.1, true),
    (v_site_fixed, v_client, v_provider, 'Forest Gate', '1 Forest Road', st_setsrid(st_makepoint(173.2, -41.2), 4326), -41.2, 173.2, true);
  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status) VALUES
    (v_payg, v_site_payg, 'active'), (v_request, v_site_request, 'active'), (v_fixed, v_site_fixed, 'active') ON CONFLICT DO NOTHING;
  UPDATE public.client_sites SET service_agreement_id = v_payg WHERE id = v_site_payg;
  UPDATE public.client_sites SET service_agreement_id = v_request WHERE id = v_site_request;
  UPDATE public.client_sites SET service_agreement_id = v_fixed WHERE id = v_site_fixed;
  INSERT INTO public.finance_pl_periods (id, organization_id, name, period_start, period_end)
  VALUES (v_period, v_provider, 'Model month', current_date - 20, current_date + 4);

  -- Terms RPC: authorisation and validation.
  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('another organisation cannot set billing terms', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'pay_as_you_go', '{}'), 'Only an administrator of the provider'));
  PERFORM pg_temp.check('helpers are not an API', pg_temp.raises(format(
    'select public.agreement_commercial_model(%L)', v_payg), 'permission denied'));

  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('an unknown model is refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'whatever', '{}'), 'Choose how this client is billed'));
  PERFORM pg_temp.check('an unknown term key is refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'pay_as_you_go', '{"discount":5}'), 'Unknown billing term: discount'));
  PERFORM pg_temp.check('payment terms above 120 days are refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'pay_as_you_go', '{"payment_terms_days":200}'), 'Payment terms must be'));
  PERFORM pg_temp.check('a negative rate is refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'pay_as_you_go', '{"base_rate_per_hour":-1}'), 'zero or a positive number'));

  v_result := public.set_agreement_commercial_terms(v_payg, 'pay_as_you_go', '{"payment_terms_days":7,"base_rate_per_hour":50}', NULL);
  PERFORM pg_temp.check('pay as you go is set with its terms',
    (SELECT commercial_model = 'pay_as_you_go' AND payment_terms_days = 7 AND base_rate_per_hour = 50 FROM public.crm_commercial_settings WHERE service_agreement_id = v_payg)
    AND (v_result->>'uses_contract_extra')::boolean = false);
  PERFORM pg_temp.check('setting terms is audited with before and after',
    EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'agreement_commercial_terms_set' AND organization_id = v_provider
      AND metadata->'after'->>'commercial_model' = 'pay_as_you_go'));
  PERFORM public.set_agreement_commercial_terms(v_payg, 'pay_as_you_go', '{"invoice_email":"accounts@example.test"}', NULL);
  PERFORM pg_temp.check('omitted terms are kept when other terms change',
    (SELECT payment_terms_days = 7 AND invoice_email = 'accounts@example.test' FROM public.crm_commercial_settings WHERE service_agreement_id = v_payg));
  PERFORM pg_temp.check('changing an existing model needs a reason', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'do_and_invoice', '{}'), 'Say why the billing model is changing'));
  PERFORM public.set_agreement_commercial_terms(v_request, 'per_request', '{}', NULL);
  PERFORM pg_temp.check('one settings row per agreement',
    (SELECT count(*) FROM public.crm_commercial_settings WHERE service_agreement_id IN (v_payg, v_request)) = 2);

  -- Dispatch: Contract/Extra is refused on non-fixed agreements; the client reference is governed.
  SELECT id INTO v_job_payg FROM public.create_dispatch_job_for_place(v_provider, v_payg, v_site_payg, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Park callout', NULL);
  SELECT id INTO v_job_request FROM public.create_dispatch_job_for_place(v_provider, v_request, v_site_request, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Dam inspection', NULL);
  SELECT id INTO v_job_fixed FROM public.create_dispatch_job_for_place(v_provider, v_fixed, v_site_fixed, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Forest alarm', NULL);
  PERFORM pg_temp.check('Contract/Extra is refused on a pay as you go agreement', pg_temp.raises(format(
    'select public.set_dispatch_job_billing_basis(%L, %L, null, null)', v_job_payg, 'extra'), 'This agreement is billed pay as you go'));
  PERFORM pg_temp.check('an empty client reference is refused', pg_temp.raises(format(
    'select public.set_dispatch_job_client_reference(%L, %L, null)', v_job_request, '   '), 'Enter the client''s request or purchase-order reference'));

  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('another organisation cannot set the client reference', pg_temp.raises(format(
    'select public.set_dispatch_job_client_reference(%L, %L, null)', v_job_request, 'X-1'), 'Not authorised'));

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the client reference cannot be written directly', pg_temp.raises(format(
    'update public.dispatch_jobs set client_order_reference = %L where id = %L', 'X-1', v_job_request), 'set_dispatch_job_client_reference'));
  INSERT INTO public.dispatch_job_charge_lines (organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_type, description, quantity, unit_rate, line_total) VALUES
    (v_provider, v_job_payg, v_client, v_payg, 'hourly', 'Park callout', 2, 50, 100),
    (v_provider, v_job_request, v_client, v_request, 'hourly', 'Dam inspection', 1, 60, 60),
    (v_provider, v_job_fixed, v_client, v_fixed, 'hourly', 'Forest alarm', 1, 15, 15);
  INSERT INTO public.finance_service_costs (organization_id, pl_period_id, service_agreement_id, client_organization_id, site_id, cost_type,
    dispatch_job_id, source_document_type, source_reference, quantity, unit_cost, total_cost) VALUES
    (v_provider, v_period, v_payg, v_client, v_site_payg, 'labour', v_job_payg, 'dispatch_job', 'model:payg', 1, 100, 100),
    (v_provider, v_period, v_fixed, v_client, v_site_fixed, 'labour', v_job_fixed, 'dispatch_job', 'model:fixed', 1, 15, 15),
    (v_provider, v_period, v_fixed, v_client, NULL, 'labour', NULL, 'timesheet', 'model:timesheet', 1, 40, 40);

  -- Invoicing follows the model.
  PERFORM pg_temp.as_user(v_admin);
  v_invoice := public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, v_payg, NULL, NULL);
  PERFORM pg_temp.check('pay as you go bills the callout with no Contract/Extra decision',
    v_invoice.subtotal = 100 AND (SELECT description FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) = 'Park callout');
  PERFORM pg_temp.check('the due date follows the agreement payment terms', v_invoice.due_date = v_invoice.invoice_date + 7);

  PERFORM pg_temp.check('per request blocks a job with no client reference', pg_temp.raises(format(
    'select public.generate_crm_invoice_from_completed_work(%L, %L, %L, %L, null, null)', gen_random_uuid(), v_provider, v_client, v_request),
    'request or PO reference'));
  v_result := public.set_dispatch_job_client_reference(v_job_request, ' DOC-PO-42 ', NULL);
  PERFORM pg_temp.check('the reference is trimmed and audited',
    (SELECT client_order_reference = 'DOC-PO-42' FROM public.dispatch_jobs WHERE id = v_job_request)
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'dispatch_job_client_reference_set' AND target_id = v_job_request));
  PERFORM pg_temp.check('changing a reference needs a reason', pg_temp.raises(format(
    'select public.set_dispatch_job_client_reference(%L, %L, null)', v_job_request, 'DOC-PO-43'), 'Say why the client reference is changing'));
  v_invoice := public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, v_request, NULL, NULL);
  PERFORM pg_temp.check('per request bills once referenced, and the line carries the reference',
    v_invoice.subtotal = 60 AND (SELECT description FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) = 'Client ref DOC-PO-42 — Dam inspection');
  PERFORM pg_temp.check('the default due date is 14 days', v_invoice.due_date = v_invoice.invoice_date + 14);
  PERFORM pg_temp.check('an invoiced job keeps its reference', pg_temp.raises(format(
    'select public.set_dispatch_job_client_reference(%L, %L, %L)', v_job_request, 'DOC-PO-43', 'Client corrected the PO'), 'already invoiced'));

  PERFORM pg_temp.check('an agreement with no model still needs the Contract/Extra decision', pg_temp.raises(format(
    'select public.generate_crm_invoice_from_completed_work(%L, %L, %L, %L, null, null)', gen_random_uuid(), v_provider, v_client, v_fixed),
    '1 callout charge line(s) need billing set'));

  -- Finance period: billable bucket for non-fixed agreements; totals still reconcile.
  v_split := public.get_finance_pl_period_billing_basis(v_period);
  SELECT total_cost INTO v_pl_total FROM public.get_finance_pl_period_summary(v_period);
  SELECT a INTO v_payg_row FROM jsonb_array_elements(v_split->'by_agreement') a WHERE a->>'service_agreement_id' = v_payg::text;
  PERFORM pg_temp.check('pay as you go cost is billable, not unclassified',
    (v_payg_row->>'billable_cost')::numeric = 100 AND (v_payg_row->>'unclassified_cost')::numeric = 0
    AND v_payg_row->>'commercial_model' = 'pay_as_you_go');
  PERFORM pg_temp.check('an agreement with no model keeps the undecided cost unclassified',
    (v_split->'totals'->>'unclassified_cost')::numeric = 15 AND (v_split->'totals'->>'billable_cost')::numeric = 100);
  PERFORM pg_temp.check('the period split still reconciles to the P&L total',
    v_pl_total = 155 AND (v_split->'totals'->>'total_cost')::numeric = v_pl_total
    AND (v_split->'totals'->>'contract_cost')::numeric + (v_split->'totals'->>'extra_cost')::numeric
      + (v_split->'totals'->>'unclassified_cost')::numeric + (v_split->'totals'->>'billable_cost')::numeric
      + (v_split->'totals'->>'other_cost')::numeric = v_pl_total);

  v_result := public.get_agreement_billing_basis_summary(v_payg, NULL, NULL);
  PERFORM pg_temp.check('the agreement summary reports the model and terms',
    v_result->'commercial'->>'commercial_model' = 'pay_as_you_go' AND (v_result->'commercial'->>'uses_contract_extra')::boolean = false
    AND (v_result->'commercial'->>'payment_terms_days')::int = 7);
  v_result := public.get_agreement_billing_basis_summary(v_fixed, NULL, NULL);
  PERFORM pg_temp.check('an agreement with no settings reports no model and uses Contract/Extra',
    v_result->'commercial'->'commercial_model' = 'null'::jsonb AND (v_result->'commercial'->>'uses_contract_extra')::boolean = true);
  PERFORM pg_temp.as_admin();
END $$;

ROLLBACK;
