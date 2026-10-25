-- Behavioural truth table: do and invoice is standing authority to do what is needed and invoice the
-- actuals, distinct from pay as you go (all work at the agreed rates). An optional per-job standing
-- authority limit holds back only jobs above it until the client's approval reference is recorded.
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
  v_dai uuid := gen_random_uuid();
  v_open uuid := gen_random_uuid();
  v_payg uuid := gen_random_uuid();
  v_site_dai uuid := gen_random_uuid();
  v_site_open uuid := gen_random_uuid();
  v_site_payg uuid := gen_random_uuid();
  v_period uuid := gen_random_uuid();
  v_job_small uuid;
  v_job_large uuid;
  v_job_open uuid;
  v_job_payg uuid;
  v_result jsonb;
  v_invoice public.invoices%ROWTYPE;
  v_split jsonb;
  v_pl_total numeric;
  v_lines text[];
BEGIN
  INSERT INTO public.organizations (id, name, organization_type, active, status) VALUES
    (v_provider, 'Authority Provider', 'service_provider', true, 'active'),
    (v_client, 'Authority Client', 'government', true, 'active'),
    (v_outsider_org, 'Authority Outsider', 'service_provider', true, 'active');
  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name) VALUES
    (v_admin, 'master', v_provider, v_provider, 'Authority Admin'),
    (v_outsider, 'master', v_outsider_org, v_outsider_org, 'Authority Outsider');
  INSERT INTO public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status) VALUES
    (v_dai, v_provider, v_client, 'Hospital Do And Invoice', 'operational', current_date - 30, 'accepted'),
    (v_open, v_provider, v_client, 'Clinic Do And Invoice No Cap', 'operational', current_date - 30, 'accepted'),
    (v_payg, v_provider, v_client, 'Parks Pay As You Go', 'operational', current_date - 30, 'accepted');
  INSERT INTO public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active) VALUES
    (v_site_dai, v_client, v_provider, 'Ward Block', '1 Hospital Road', st_setsrid(st_makepoint(173.0, -41.4), 4326), -41.4, 173.0, true),
    (v_site_open, v_client, v_provider, 'Clinic', '1 Clinic Road', st_setsrid(st_makepoint(173.1, -41.3), 4326), -41.3, 173.1, true),
    (v_site_payg, v_client, v_provider, 'Park Gate', '1 Park Road', st_setsrid(st_makepoint(173.2, -41.2), 4326), -41.2, 173.2, true);
  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status) VALUES
    (v_dai, v_site_dai, 'active'), (v_open, v_site_open, 'active'), (v_payg, v_site_payg, 'active') ON CONFLICT DO NOTHING;
  UPDATE public.client_sites SET service_agreement_id = v_dai WHERE id = v_site_dai;
  UPDATE public.client_sites SET service_agreement_id = v_open WHERE id = v_site_open;
  UPDATE public.client_sites SET service_agreement_id = v_payg WHERE id = v_site_payg;
  INSERT INTO public.finance_pl_periods (id, organization_id, name, period_start, period_end)
  VALUES (v_period, v_provider, 'Authority month', current_date - 20, current_date + 4);

  -- Terms: the limit belongs to do and invoice only, and is validated and audited.
  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('another organisation cannot set a standing authority limit', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_dai, 'do_and_invoice', '{"standing_authority_limit":250}'), 'Only an administrator of the provider'));

  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('a limit is refused on pay as you go', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'pay_as_you_go', '{"standing_authority_limit":250}'), 'only applies to do and invoice'));
  PERFORM pg_temp.check('a negative limit is refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_dai, 'do_and_invoice', '{"standing_authority_limit":-5}'), 'zero or a positive amount'));
  PERFORM public.set_agreement_commercial_terms(v_payg, 'pay_as_you_go', '{}', NULL);
  PERFORM public.set_agreement_commercial_terms(v_open, 'do_and_invoice', '{}', NULL);
  v_result := public.set_agreement_commercial_terms(v_dai, 'do_and_invoice', '{"standing_authority_limit":250}', NULL);
  PERFORM pg_temp.check('do and invoice stores its standing authority limit',
    (v_result->>'standing_authority_limit')::numeric = 250
    AND (SELECT standing_authority_limit = 250 FROM public.crm_commercial_settings WHERE service_agreement_id = v_dai)
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'agreement_commercial_terms_set'
      AND metadata->>'service_agreement_id' = v_dai::text AND (metadata->'after'->>'standing_authority_limit')::numeric = 250));
  PERFORM public.set_agreement_commercial_terms(v_dai, 'do_and_invoice', '{"payment_terms_days":20}', NULL);
  PERFORM pg_temp.check('the limit is kept when other terms change',
    (SELECT standing_authority_limit = 250 AND payment_terms_days = 20 FROM public.crm_commercial_settings WHERE service_agreement_id = v_dai));

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the table refuses a limit on another model', pg_temp.raises(format(
    'update public.crm_commercial_settings set standing_authority_limit = 10 where service_agreement_id = %L', v_payg), 'standing_authority_limit_check'));

  -- Work: two jobs under standing authority (one under, one over the limit), one with no cap, one pay as you go.
  PERFORM pg_temp.as_user(v_admin);
  SELECT id INTO v_job_small FROM public.create_dispatch_job_for_place(v_provider, v_dai, v_site_dai, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Ward alarm', NULL);
  SELECT id INTO v_job_large FROM public.create_dispatch_job_for_place(v_provider, v_dai, v_site_dai, NULL, gen_random_uuid(), 'callout', 'high', 60, NULL, 'After-hours lockdown', NULL);
  SELECT id INTO v_job_open FROM public.create_dispatch_job_for_place(v_provider, v_open, v_site_open, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Clinic break-in', NULL);
  SELECT id INTO v_job_payg FROM public.create_dispatch_job_for_place(v_provider, v_payg, v_site_payg, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Park callout', NULL);

  PERFORM pg_temp.as_admin();
  INSERT INTO public.dispatch_job_charge_lines (organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_type, description, quantity, unit_rate, line_total) VALUES
    (v_provider, v_job_small, v_client, v_dai, 'hourly', 'Ward alarm', 2, 40, 80),
    (v_provider, v_job_large, v_client, v_dai, 'hourly', 'After-hours lockdown', 4, 50, 200),
    (v_provider, v_job_large, v_client, v_dai, 'travel', 'Lockdown travel', 1, 100, 100),
    (v_provider, v_job_open, v_client, v_open, 'hourly', 'Clinic break-in', 20, 50, 1000),
    (v_provider, v_job_payg, v_client, v_payg, 'hourly', 'Park callout', 2, 50, 100);
  INSERT INTO public.finance_service_costs (organization_id, pl_period_id, service_agreement_id, client_organization_id, site_id, cost_type,
    dispatch_job_id, source_document_type, source_reference, quantity, unit_cost, total_cost) VALUES
    (v_provider, v_period, v_dai, v_client, v_site_dai, 'labour', v_job_large, 'dispatch_job', 'authority:dai', 1, 300, 300),
    (v_provider, v_period, v_payg, v_client, v_site_payg, 'labour', v_job_payg, 'dispatch_job', 'authority:payg', 1, 100, 100);
  PERFORM pg_temp.check('the over-limit test counts every line of the job',
    public.dispatch_job_over_standing_authority(v_job_large, 250) AND NOT public.dispatch_job_over_standing_authority(v_job_small, 250)
    AND NOT public.dispatch_job_over_standing_authority(v_job_large, NULL));

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.get_agreement_billing_basis_summary(v_dai, NULL, NULL);
  PERFORM pg_temp.check('the agreement summary shows the limit and the job awaiting approval',
    (v_result->'commercial'->>'standing_authority_limit')::numeric = 250
    AND (v_result->'commercial'->>'jobs_over_standing_authority_without_approval')::int = 1);

  -- Invoicing: over the limit holds the invoice until the client's approval is recorded.
  PERFORM pg_temp.check('a job over the standing authority limit blocks the invoice', pg_temp.raises(format(
    'select public.generate_crm_invoice_from_completed_work(%L, %L, %L, %L, null, null)', gen_random_uuid(), v_provider, v_client, v_dai),
    '1 do-and-invoice job(s) cost more than the client''s standing authority limit'));
  PERFORM public.set_dispatch_job_client_reference(v_job_large, 'APPROVAL-7', NULL);
  v_result := public.get_agreement_billing_basis_summary(v_dai, NULL, NULL);
  PERFORM pg_temp.check('approval clears the summary count',
    (v_result->'commercial'->>'jobs_over_standing_authority_without_approval')::int = 0);
  v_invoice := public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, v_dai, NULL, NULL);
  SELECT array_agg(description ORDER BY description) INTO v_lines FROM public.invoice_line_items WHERE invoice_id = v_invoice.id;
  PERFORM pg_temp.check('do and invoice bills the actuals, marked as Actuals with the client approval',
    v_invoice.subtotal = 380
    AND v_lines = ARRAY['Actuals — Client approval APPROVAL-7 — After-hours lockdown', 'Actuals — Client approval APPROVAL-7 — Lockdown travel', 'Actuals — Ward alarm']);
  PERFORM pg_temp.check('the due date follows the do and invoice payment terms', v_invoice.due_date = v_invoice.invoice_date + 20);
  PERFORM pg_temp.check('the invoice audit counts the actuals lines',
    EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'crm_invoice_generated_from_completed_work' AND target_id = v_invoice.id
      AND (metadata->>'do_and_invoice_actuals_lines')::int = 3));

  v_invoice := public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, v_open, NULL, NULL);
  PERFORM pg_temp.check('with no limit nothing is held back, however large the job',
    v_invoice.subtotal = 1000 AND (SELECT description FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) = 'Actuals — Clinic break-in');

  v_invoice := public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, v_payg, NULL, NULL);
  PERFORM pg_temp.check('pay as you go is billed at agreed rates, not as Actuals',
    v_invoice.subtotal = 100 AND (SELECT description FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) = 'Park callout');

  -- Finance period: billable work is broken down by model and still reconciles.
  v_split := public.get_finance_pl_period_billing_basis(v_period);
  SELECT total_cost INTO v_pl_total FROM public.get_finance_pl_period_summary(v_period);
  PERFORM pg_temp.check('the period separates do and invoice actuals from pay as you go',
    (v_split->'totals'->'billable_by_model'->>'do_and_invoice')::numeric = 300
    AND (v_split->'totals'->'billable_by_model'->>'pay_as_you_go')::numeric = 100
    AND (v_split->'totals'->'billable_by_model'->>'per_request')::numeric = 0
    AND (v_split->'totals'->>'billable_cost')::numeric = 400
    AND (SELECT (a->>'actuals_cost')::numeric FROM jsonb_array_elements(v_split->'by_agreement') a WHERE a->>'service_agreement_id' = v_dai::text) = 300);
  PERFORM pg_temp.check('the period split still reconciles to the P&L total',
    v_pl_total = 400 AND (v_split->'totals'->>'total_cost')::numeric = v_pl_total);

  -- Changing away from do and invoice clears the standing authority.
  PERFORM public.set_agreement_commercial_terms(v_dai, 'pay_as_you_go', '{}', 'Client moved to agreed rates');
  PERFORM pg_temp.check('another model clears the standing authority limit',
    (SELECT commercial_model = 'pay_as_you_go' AND standing_authority_limit IS NULL FROM public.crm_commercial_settings WHERE service_agreement_id = v_dai));
  PERFORM pg_temp.as_admin();
END $$;

ROLLBACK;
