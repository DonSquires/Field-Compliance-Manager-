-- Behavioural truth table: a fixed monthly fee is drawn down by the month's contracted work
-- (owner ruling 2026-10-25). Under-delivery is credited, work above the fee is billed as Extra
-- only when pre-agreed or justified (otherwise absorbed), and a month is settled once, when it is
-- over and all its work is classified and priced. Runs in a transaction and rolls back.
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
  v_fixed uuid := gen_random_uuid();
  v_payg uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_quote uuid := gen_random_uuid();
  v_rule uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_period uuid := gen_random_uuid();
  v_cost uuid := gen_random_uuid();
  v_job uuid;
  v_this date := date_trunc('month', current_date)::date;
  v_credit date := (date_trunc('month', current_date) - interval '2 months')::date;
  v_over date := (date_trunc('month', current_date) - interval '3 months')::date;
  v_absorb date := (date_trunc('month', current_date) - interval '4 months')::date;
  v_unclassified date := (date_trunc('month', current_date) - interval '5 months')::date;
  v_empty date := (date_trunc('month', current_date) - interval '6 months')::date;
  v_agreed date := (date_trunc('month', current_date) - interval '7 months')::date;
  v_request uuid := gen_random_uuid();
  v_result jsonb;
  v_drawdown jsonb;
  v_month jsonb;
  v_inv record;
  v_again record;
  v_redo record;
  v_row public.agreement_fee_settlements%ROWTYPE;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type, active, status) VALUES
    (v_provider, 'Drawdown Provider', 'service_provider', true, 'active'),
    (v_client, 'Drawdown Client', 'government', true, 'active'),
    (v_outsider_org, 'Drawdown Outsider', 'service_provider', true, 'active');
  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name) VALUES
    (v_admin, 'master', v_provider, v_provider, 'Drawdown Admin'),
    (v_outsider, 'master', v_outsider_org, v_outsider_org, 'Drawdown Outsider');
  INSERT INTO public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status) VALUES
    (v_fixed, v_provider, v_client, 'Forest Fixed Fee', 'operational', current_date - 400, 'accepted'),
    (v_payg, v_provider, v_client, 'Pay As You Go', 'operational', current_date - 400, 'accepted');
  INSERT INTO public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  VALUES (v_site, v_client, v_provider, 'Forest Gate', '1 Forest Road', st_setsrid(st_makepoint(173.0, -41.4), 4326), -41.4, 173.0, true);
  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status) VALUES (v_fixed, v_site, 'active') ON CONFLICT DO NOTHING;
  UPDATE public.client_sites SET service_agreement_id = v_fixed WHERE id = v_site;
  INSERT INTO public.quotes (id, provider_org_id, client_org_id, title, status, service_agreement_id, accepted_at)
  VALUES (v_quote, v_provider, v_client, 'Forest fixed fee', 'accepted', v_fixed, now());
  INSERT INTO public.quote_lines (quote_id, description, quantity, unit_charge) VALUES (v_quote, 'Contracted forest security - fixed price per month', 1, 1000);
  INSERT INTO public.reference_codes (organization_id, code_type, code, name, external_refs) VALUES
    (v_provider, 'charge_code', '91001', 'Gate patrol', '{"billing_basis":"Contract"}'),
    (v_provider, 'charge_code', '91002', 'Hunter lock removal', '{"billing_basis":"Extra"}');
  INSERT INTO public.rate_rules (id, organization_id, rule_kind, name, rate_type, amount) VALUES (v_rule, v_provider, 'billing', 'Callout', 'hourly', 100);

  -- Imported patrol rows: one finance line backs them all.
  INSERT INTO public.finance_pl_periods (id, organization_id, name, period_start, period_end)
  VALUES (v_period, v_provider, 'Drawdown months', v_agreed, v_this - 1);
  INSERT INTO public.finance_service_costs (id, organization_id, pl_period_id, service_agreement_id, client_organization_id, site_id, cost_type,
    source_document_type, source_reference, quantity, unit_cost, total_cost)
  VALUES (v_cost, v_provider, v_period, v_fixed, v_client, v_site, 'labour', 'patrol_log', 'drawdown:labour', 1, 1, 1);
  INSERT INTO public.file_import_batches (id, organization_id, batch_name, source_file, parser, created_by)
  VALUES (v_batch, v_provider, 'Drawdown workbook', 'drawdown.xlsx', 'patrol_finance', v_admin);
  INSERT INTO public.file_import_finance_cost_rows (organization_id, batch_id, client_organization_id, service_agreement_id, source_file,
    source_sha256, derivative_sha256, source_sheet, source_row, source_row_sha256, component, cost_type, amount, service_date, site_id,
    source_values, status, finance_service_cost_id, applied_at)
  SELECT v_provider, v_batch, v_client, v_fixed, 'drawdown.xlsx', repeat('a', 64), repeat('b', 64), 'List', r.source_row,
    encode(sha256(convert_to('drawdown-row-' || r.source_row, 'UTF8')), 'hex'), 'job_cost', 'labour', r.amount, r.service_date, v_site,
    r.source_values, 'applied', v_cost, now()
  FROM (VALUES
    (2, 300::numeric, v_credit + 3, '{"charge_code":"91001"}'::jsonb),
    (3, 50::numeric, v_credit + 4, '{"charge_code":"91002"}'::jsonb),
    (4, 1200::numeric, v_over + 3, '{"activity_type":"Contract"}'::jsonb),
    (5, 1100::numeric, v_absorb + 3, '{"charge_code":"91001"}'::jsonb),
    (6, 900::numeric, v_unclassified + 3, '{"charge_code":"91001"}'::jsonb),
    (7, 25::numeric, v_unclassified + 4, '{"charge_code":"99999"}'::jsonb),
    (8, 1300::numeric, v_agreed + 3, '{"charge_code":"91001"}'::jsonb),
    (9, 400::numeric, v_this, '{"charge_code":"91001"}'::jsonb)
  ) AS r(source_row, amount, service_date, source_values);

  -- A priced Contract callout in the credit month.
  PERFORM pg_temp.as_user(v_admin);
  SELECT id INTO v_job FROM public.create_dispatch_job_for_place(v_provider, v_fixed, v_site, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Gate alarm', NULL);
  PERFORM public.set_dispatch_job_billing_basis(v_job, 'contract', NULL, NULL);
  PERFORM pg_temp.as_admin();
  INSERT INTO public.dispatch_job_charge_lines (organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_rule_id, rate_type, description, quantity, unit_rate, line_total, created_at)
  VALUES (v_provider, v_job, v_client, v_fixed, v_rule, 'hourly', 'Gate alarm', 2, 100, 200, (v_credit + 10)::timestamptz + interval '12 hours');

  -- Terms: the overrun policy is a fixed price plus Extra term, validated and audited.
  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.set_agreement_commercial_terms(v_payg, 'pay_as_you_go', '{"payment_due_day_of_month":20}', NULL);
  PERFORM pg_temp.check('the overrun policy is refused on pay as you go', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_payg, 'pay_as_you_go', '{"fee_overrun_policy":"justify"}'), 'only applies to fixed price'));
  PERFORM pg_temp.check('an unknown overrun policy is refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_fixed, 'fixed_price_with_extras', '{"fee_overrun_policy":"always"}'), 'pre-agreed as Extra'));
  v_result := public.set_agreement_commercial_terms(v_fixed, 'fixed_price_with_extras', '{"payment_due_day_of_month":20,"fee_overrun_policy":"justify"}', NULL);
  PERFORM pg_temp.check('the overrun policy is stored, returned and audited',
    v_result->>'fee_overrun_policy' = 'justify'
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'agreement_commercial_terms_set'
      AND metadata->>'service_agreement_id' = v_fixed::text AND metadata->'after'->>'fee_overrun_policy' = 'justify'));

  -- The drawdown view.
  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('an outsider cannot read the drawdown', pg_temp.raises(format(
    'select public.get_agreement_fee_drawdown(%L)', v_fixed), 'Finance administrator access required'));
  PERFORM pg_temp.as_user(v_admin);
  v_drawdown := public.get_agreement_fee_drawdown(v_fixed, v_agreed, v_this);
  PERFORM pg_temp.check('the drawdown lists each month newest first with the fee',
    (v_drawdown->>'applies')::boolean AND (v_drawdown->>'fee')::numeric = 1000 AND v_drawdown->>'fee_source' = 'accepted_quote'
    AND jsonb_array_length(v_drawdown->'months') = 8 AND v_drawdown->'months'->0->>'month' = to_char(v_this, 'YYYY-MM'));
  SELECT m INTO v_month FROM jsonb_array_elements(v_drawdown->'months') m WHERE m->>'month' = to_char(v_credit, 'YYYY-MM');
  PERFORM pg_temp.check('a credit month: imported Contract and Contract callouts draw the fee down; Extra rows do not',
    (v_month->'contract_work'->'imported'->>'amount')::numeric = 300
    AND (v_month->'contract_work'->'imported'->>'extra_amount')::numeric = 50
    AND (v_month->'contract_work'->'callouts'->>'amount')::numeric = 200
    AND (v_month->'contract_work'->>'total')::numeric = 500 AND (v_month->>'balance')::numeric = 500
    AND v_month->>'outcome' = 'credit' AND jsonb_array_length(v_month->'blockers') = 0);
  PERFORM pg_temp.check('this month is not finished',
    EXISTS (SELECT 1 FROM jsonb_array_elements(v_drawdown->'months'->0->'blockers') b WHERE b->>'code' = 'month_not_finished'));
  SELECT m INTO v_month FROM jsonb_array_elements(v_drawdown->'months') m WHERE m->>'month' = to_char(v_unclassified, 'YYYY-MM');
  PERFORM pg_temp.check('an unclassified row blocks its month',
    v_month->'blockers'->0->>'code' = 'unclassified_imported_rows' AND (v_month->'contract_work'->'imported'->>'unclassified_amount')::numeric = 25);
  SELECT m INTO v_month FROM jsonb_array_elements(v_drawdown->'months') m WHERE m->>'month' = to_char(v_empty, 'YYYY-MM');
  PERFORM pg_temp.check('a month with no work recorded is blocked, not credited in full',
    v_month->'blockers'->0->>'code' = 'no_work_recorded');
  v_result := public.get_agreement_fee_drawdown(v_payg);
  PERFORM pg_temp.check('pay as you go has no drawdown', NOT (v_result->>'applies')::boolean AND jsonb_array_length(v_result->'months') = 0);

  -- Settling refuses what cannot be settled.
  PERFORM pg_temp.check('a part month is refused', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L)', gen_random_uuid(), v_fixed, v_credit, v_credit + 14), 'whole calendar month'));
  PERFORM pg_temp.check('an unfinished month is refused', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L)', gen_random_uuid(), v_fixed, v_this, (v_this + interval '1 month - 1 day')::date), 'has not finished'));
  PERFORM pg_temp.check('an unclassified month is refused', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L)', gen_random_uuid(), v_fixed, v_unclassified, (v_unclassified + interval '1 month - 1 day')::date), 'not marked Contract or Extra'));
  PERFORM pg_temp.check('a month with no work is refused', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L)', gen_random_uuid(), v_fixed, v_empty, (v_empty + interval '1 month - 1 day')::date), 'No work is recorded'));
  PERFORM pg_temp.check('an overrun decision on pay as you go is refused', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L, %L)', gen_random_uuid(), v_payg, v_credit, (v_credit + interval '1 month - 1 day')::date, 'absorb'), 'Only a fixed price'));

  -- Credit month.
  SELECT * INTO v_inv FROM public.generate_crm_invoice_from_agreement(v_request, v_fixed, v_credit, (v_credit + interval '1 month - 1 day')::date);
  PERFORM pg_temp.check('unused contract value is credited on the invoice',
    v_inv.subtotal = 500 AND v_inv.gst_amount = 75 AND v_inv.total_amount = 575 AND v_inv.line_item_count = 2
    AND EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = v_inv.invoice_id AND line_total = -500 AND description LIKE 'Credit — contracted work not used in %'));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.agreement_fee_settlements WHERE service_agreement_id = v_fixed AND period_start = v_credit;
  PERFORM pg_temp.check('the settlement records the drawdown',
    v_row.outcome = 'credit' AND v_row.fee_amount = 1000 AND v_row.imported_contract_amount = 300 AND v_row.callout_contract_amount = 200
    AND v_row.contract_work_amount = 500 AND v_row.balance = 500 AND v_row.adjustment_amount = -500 AND v_row.invoice_id = v_inv.invoice_id);
  PERFORM pg_temp.check('the drawdown is audited',
    EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'crm_invoice_generated_from_agreement' AND target_id = v_inv.invoice_id
      AND metadata->'fee_drawdown'->>'outcome' = 'credit' AND (metadata->'fee_drawdown'->>'adjustment_amount')::numeric = -500));
  PERFORM pg_temp.as_user(v_admin);
  SELECT * INTO v_again FROM public.generate_crm_invoice_from_agreement(v_request, v_fixed, v_credit, (v_credit + interval '1 month - 1 day')::date);
  PERFORM pg_temp.check('the same request returns the same invoice', v_again.invoice_id = v_inv.invoice_id);
  PERFORM pg_temp.check('a month is settled once', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L)', gen_random_uuid(), v_fixed, v_credit, (v_credit + interval '1 month - 1 day')::date), 'already settled on invoice'));
  PERFORM pg_temp.as_admin();
  UPDATE public.invoices SET status = 'void' WHERE id = v_inv.invoice_id;
  PERFORM pg_temp.as_user(v_admin);
  SELECT * INTO v_redo FROM public.generate_crm_invoice_from_agreement(gen_random_uuid(), v_fixed, v_credit, (v_credit + interval '1 month - 1 day')::date);
  PERFORM pg_temp.check('a void invoice frees the month to be settled again',
    v_redo.invoice_id <> v_inv.invoice_id AND v_redo.subtotal = 500
    AND (SELECT count(*) = 1 AND bool_and(invoice_id = v_redo.invoice_id) FROM public.agreement_fee_settlements WHERE service_agreement_id = v_fixed AND period_start = v_credit));

  -- Overrun without a pre-agreement: justified or absorbed, never silent.
  PERFORM pg_temp.check('an overrun needs a decision', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L)', gen_random_uuid(), v_fixed, v_over, (v_over + interval '1 month - 1 day')::date), 'above the monthly fee'));
  PERFORM pg_temp.check('billing an overrun as Extra needs a justification', pg_temp.raises(format(
    'select * from public.generate_crm_invoice_from_agreement(%L, %L, %L, %L, %L, %L)', gen_random_uuid(), v_fixed, v_over, (v_over + interval '1 month - 1 day')::date, 'bill_as_extra', 'storm'), 'Say why'));
  SELECT * INTO v_inv FROM public.generate_crm_invoice_from_agreement(gen_random_uuid(), v_fixed, v_over, (v_over + interval '1 month - 1 day')::date,
    'bill_as_extra', 'Storm damage: client asked for daily patrols for two weeks');
  PERFORM pg_temp.check('a justified overrun is billed as Extra with the reason on the line',
    v_inv.subtotal = 1200 AND EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = v_inv.invoice_id AND line_total = 200
      AND description LIKE 'Extra — contracted work above the monthly fee in %Storm damage%'));
  SELECT * INTO v_inv FROM public.generate_crm_invoice_from_agreement(gen_random_uuid(), v_fixed, v_absorb, (v_absorb + interval '1 month - 1 day')::date, 'absorb');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an absorbed overrun bills only the fee and is recorded',
    v_inv.subtotal = 1000 AND v_inv.line_item_count = 1
    AND (SELECT outcome = 'overrun_absorbed' AND balance = -100 AND adjustment_amount = 0 FROM public.agreement_fee_settlements WHERE invoice_id = v_inv.invoice_id));

  -- Pre-agreed (OneFortyOne): billed as Extra without asking.
  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.set_agreement_commercial_terms(v_fixed, 'fixed_price_with_extras', '{"fee_overrun_policy":"bill_as_extra"}', NULL);
  SELECT * INTO v_inv FROM public.generate_crm_invoice_from_agreement(gen_random_uuid(), v_fixed, v_agreed, (v_agreed + interval '1 month - 1 day')::date);
  PERFORM pg_temp.check('a pre-agreed overrun is billed as Extra',
    v_inv.subtotal = 1300 AND EXISTS (SELECT 1 FROM public.invoice_line_items WHERE invoice_id = v_inv.invoice_id AND line_total = 300
      AND description LIKE '%as agreed with the client'));

  -- Who can see settlements.
  PERFORM pg_temp.check('the provider administrator sees the settlements',
    (SELECT count(*) FROM public.agreement_fee_settlements WHERE service_agreement_id = v_fixed) = 4);
  PERFORM pg_temp.check('the API cannot write settlements', pg_temp.raises(format(
    'delete from public.agreement_fee_settlements where service_agreement_id = %L', v_fixed), 'permission denied'));
  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('an outsider sees no settlements',
    (SELECT count(*) FROM public.agreement_fee_settlements WHERE service_agreement_id = v_fixed) = 0);

  -- Changing the model clears the policy.
  PERFORM pg_temp.as_user(v_admin);
  v_result := public.set_agreement_commercial_terms(v_fixed, 'pay_as_you_go', '{}', 'Client moved to pay as you go');
  PERFORM pg_temp.check('another billing model clears the overrun policy', v_result->>'fee_overrun_policy' IS NULL);

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('patrol visits on fixed price plus Extra are not billed again by the completed-work invoice',
    pg_get_functiondef('public.generate_crm_invoice_from_completed_work(uuid, uuid, uuid, uuid, date, date)'::regprocedure)
      LIKE '%agreement_commercial_model(line.service_agreement_id), '''') <> ''fixed_price_with_extras''%');
END $$;

ROLLBACK;
