-- Behavioural truth table for billing-basis aware invoicing, the derived-code Extra default, and the agreement billing summary.
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
  v_site uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_order jsonb;
  v_job_contract uuid;
  v_job_extra uuid;
  v_job_open uuid;
  v_invoice public.invoices%ROWTYPE;
  v_summary jsonb;
BEGIN
  PERFORM pg_temp.check('no derived group charge code is left without a basis',
    NOT EXISTS (SELECT 1 FROM public.reference_codes WHERE code_type = 'charge_code' AND external_refs->>'scheme' = 'rm_group_charge_code'
      AND external_refs->>'origin' = 'derived' AND nullif(external_refs->>'billing_basis', '') IS NULL));
  PERFORM pg_temp.check('derived defaults are marked as the owner default',
    NOT EXISTS (SELECT 1 FROM public.reference_codes WHERE code_type = 'charge_code' AND external_refs->>'scheme' = 'rm_group_charge_code'
      AND external_refs->>'origin' = 'derived' AND external_refs->>'billing_basis' = 'Extra' AND external_refs->>'basis_source' IS DISTINCT FROM 'owner_default_2026-10-25'
      AND external_refs ? 'basis_source'));
  PERFORM pg_temp.check('OneFortyOne contract codes keep their basis',
    NOT EXISTS (SELECT 1 FROM public.reference_codes WHERE code_type = 'charge_code' AND external_refs->>'scheme' = 'rm_group_charge_code'
      AND external_refs->>'origin' = 'onefortyone' AND external_refs->>'basis_source' = 'owner_default_2026-10-25'));

  INSERT INTO public.organizations (id, name, organization_type, active, status) VALUES
    (v_provider, 'Basis Provider', 'service_provider', true, 'active'),
    (v_client, 'Basis Client', 'government', true, 'active'),
    (v_outsider_org, 'Basis Outsider', 'service_provider', true, 'active');
  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name) VALUES
    (v_admin, 'master', v_provider, v_provider, 'Basis Admin'),
    (v_outsider, 'master', v_outsider_org, v_outsider_org, 'Basis Outsider');
  INSERT INTO public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status)
  VALUES (v_agreement, v_provider, v_client, 'Fixed Monthly Security', 'operational', current_date - 30, 'accepted');
  INSERT INTO public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  VALUES (v_site, v_client, v_provider, 'Forest Gate', '1 Forest Road', st_setsrid(st_makepoint(173.0, -41.4), 4326), -41.4, 173.0, true);
  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status) VALUES (v_agreement, v_site, 'active') ON CONFLICT DO NOTHING;
  UPDATE public.client_sites SET service_agreement_id = v_agreement WHERE id = v_site;

  PERFORM pg_temp.as_user(v_admin);
  v_order := public.manage_agreement_extra_work_order(gen_random_uuid(), v_agreement, 'create', NULL, NULL,
    'Hunter weekend lock access', 'Remove locks Friday and replace Monday for public hunter access.',
    'written', 'Client email', NULL, NULL, current_date - 7, NULL, NULL, NULL);
  SELECT id INTO v_job_contract FROM public.create_dispatch_job_for_place(v_provider, v_agreement, v_site, NULL, gen_random_uuid(), 'patrol', 'normal', 60, NULL, 'Gate check', NULL);
  SELECT id INTO v_job_extra FROM public.create_dispatch_job_for_place(v_provider, v_agreement, v_site, NULL, gen_random_uuid(), 'lock_access', 'normal', 60, NULL, 'Friday lock removal', NULL);
  SELECT id INTO v_job_open FROM public.create_dispatch_job_for_place(v_provider, v_agreement, v_site, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Alarm callout', NULL);
  PERFORM public.set_dispatch_job_billing_basis(v_job_contract, 'contract', NULL, NULL);
  PERFORM public.set_dispatch_job_billing_basis(v_job_extra, 'extra', (v_order->>'id')::uuid, NULL);

  PERFORM pg_temp.as_admin();
  INSERT INTO public.dispatch_job_charge_lines (organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_type, description, quantity, unit_rate, line_total) VALUES
    (v_provider, v_job_contract, v_client, v_agreement, 'hourly', 'Gate check', 1, 80, 80),
    (v_provider, v_job_extra, v_client, v_agreement, 'hourly', 'Lock removal', 2, 55, 110),
    (v_provider, v_job_open, v_client, v_agreement, 'hourly', 'Alarm callout', 1, 120, 120);

  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('unclassified callouts block the invoice with a count', pg_temp.raises(format(
    'select public.generate_crm_invoice_from_completed_work(%L, %L, %L, %L, null, null)', gen_random_uuid(), v_provider, v_client, v_agreement),
    '1 callout charge line(s) need billing set'));

  PERFORM public.set_dispatch_job_billing_basis(v_job_open, 'contract', NULL, NULL);
  v_invoice := public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, v_agreement, NULL, NULL);
  PERFORM pg_temp.check('only the Extra callout is billed', v_invoice.subtotal = 110
    AND (SELECT count(*) FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) = 1);
  PERFORM pg_temp.check('the Extra line names its works order',
    (SELECT description FROM public.invoice_line_items WHERE invoice_id = v_invoice.id) = 'Extra EW-001 — Lock removal');
  PERFORM pg_temp.check('contracted lines stay unbilled and are recorded in the audit',
    (SELECT count(*) FROM public.dispatch_job_charge_lines WHERE service_agreement_id = v_agreement AND billing_basis = 'contract' AND invoice_line_item_id IS NULL) = 2
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE target_id = v_invoice.id AND (metadata->>'contract_callout_lines_not_billed')::int = 2));
  PERFORM pg_temp.check('only contracted work left gives a clear message', pg_temp.raises(format(
    'select public.generate_crm_invoice_from_completed_work(%L, %L, %L, %L, null, null)', gen_random_uuid(), v_provider, v_client, v_agreement),
    'contracted work, covered by the agreement price'));

  v_summary := public.get_agreement_billing_basis_summary(v_agreement, NULL, NULL);
  PERFORM pg_temp.check('summary splits callouts by basis',
    (SELECT (d->>'total')::numeric FROM jsonb_array_elements(v_summary->'dispatch_charge_lines') d WHERE d->>'basis' = 'contract') = 200
    AND (SELECT (d->>'total')::numeric FROM jsonb_array_elements(v_summary->'dispatch_charge_lines') d WHERE d->>'basis' = 'extra') = 110
    AND (SELECT (d->>'uninvoiced_total')::numeric FROM jsonb_array_elements(v_summary->'dispatch_charge_lines') d WHERE d->>'basis' = 'extra') = 0);
  PERFORM pg_temp.check('summary lists the works order with its charges',
    v_summary->'extra_work_orders'->0->>'reference' = 'EW-001' AND (v_summary->'extra_work_orders'->0->>'charge_total')::numeric = 110);
  PERFORM pg_temp.check('summary reports a missing agreement price as null', v_summary->'agreement_price' = 'null'::jsonb);
  PERFORM pg_temp.check('summary with no imported rows is empty, not an error',
    jsonb_array_length(v_summary->'imported_cost_months') = 0 AND (v_summary->'imported_cost_totals'->>'contract_cost')::numeric = 0);

  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('outsider cannot read the summary', pg_temp.raises(format(
    'select public.get_agreement_billing_basis_summary(%L, null, null)', v_agreement), 'Finance administrator access required'));
  PERFORM pg_temp.as_admin();
END $$;

ROLLBACK;