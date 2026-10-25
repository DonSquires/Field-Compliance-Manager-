-- Behavioural truth table for the P&L period Contract / Extra split and the shared patrol-row classification rule.
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
  v_period uuid := gen_random_uuid();
  v_empty_period uuid := gen_random_uuid();
  v_batch uuid := gen_random_uuid();
  v_line_labour uuid := gen_random_uuid();
  v_line_vehicle uuid := gen_random_uuid();
  v_job_contract uuid;
  v_job_open uuid;
  v_day date := current_date - 5;
  v_split jsonb;
  v_agreement_summary jsonb;
  v_pl_total numeric;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type, active, status) VALUES
    (v_provider, 'Split Provider', 'service_provider', true, 'active'),
    (v_client, 'Split Client', 'government', true, 'active'),
    (v_outsider_org, 'Split Outsider', 'service_provider', true, 'active');
  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name) VALUES
    (v_admin, 'master', v_provider, v_provider, 'Split Admin'),
    (v_outsider, 'master', v_outsider_org, v_outsider_org, 'Split Outsider');
  INSERT INTO public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status)
  VALUES (v_agreement, v_provider, v_client, 'Forest Security', 'operational', current_date - 60, 'accepted');
  INSERT INTO public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active)
  VALUES (v_site, v_client, v_provider, 'Forest Gate', '1 Forest Road', st_setsrid(st_makepoint(173.0, -41.4), 4326), -41.4, 173.0, true);
  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status) VALUES (v_agreement, v_site, 'active') ON CONFLICT DO NOTHING;
  UPDATE public.client_sites SET service_agreement_id = v_agreement WHERE id = v_site;
  INSERT INTO public.reference_codes (organization_id, code_type, code, name, external_refs) VALUES
    (v_provider, 'charge_code', '90001', 'Lock Replace', '{"billing_basis":"Contract"}'),
    (v_provider, 'charge_code', '90002', 'Hunter Lock Removal', '{"billing_basis":"Extra"}');
  INSERT INTO public.finance_pl_periods (id, organization_id, name, period_start, period_end) VALUES
    (v_period, v_provider, 'Split month', v_day - 20, v_day + 4),
    (v_empty_period, v_provider, 'Empty month', v_day - 60, v_day - 21);

  PERFORM pg_temp.as_user(v_admin);
  SELECT id INTO v_job_contract FROM public.create_dispatch_job_for_place(v_provider, v_agreement, v_site, NULL, gen_random_uuid(), 'patrol', 'normal', 60, NULL, 'Gate check', NULL);
  SELECT id INTO v_job_open FROM public.create_dispatch_job_for_place(v_provider, v_agreement, v_site, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Alarm callout', NULL);
  PERFORM public.set_dispatch_job_billing_basis(v_job_contract, 'contract', NULL, NULL);

  PERFORM pg_temp.as_admin();
  INSERT INTO public.finance_service_costs (id, organization_id, pl_period_id, service_agreement_id, client_organization_id, site_id, cost_type,
    dispatch_job_id, source_document_type, source_reference, quantity, unit_cost, total_cost) VALUES
    (v_line_labour, v_provider, v_period, v_agreement, v_client, v_site, 'labour', NULL, 'patrol_log', 'split:labour', 1, 100, 100),
    (v_line_vehicle, v_provider, v_period, v_agreement, v_client, v_site, 'vehicle', NULL, 'patrol_log', 'split:vehicle', 1, 50, 50),
    (gen_random_uuid(), v_provider, v_period, v_agreement, v_client, v_site, 'labour', v_job_contract, 'dispatch_job', 'split:job-contract', 1, 70, 70),
    (gen_random_uuid(), v_provider, v_period, v_agreement, v_client, v_site, 'labour', v_job_open, 'dispatch_job', 'split:job-open', 1, 15, 15),
    (gen_random_uuid(), v_provider, v_period, v_agreement, v_client, NULL, 'labour', NULL, 'timesheet', 'split:timesheet', 1, 200, 200);

  INSERT INTO public.file_import_batches (id, organization_id, batch_name, source_file, parser, created_by)
  VALUES (v_batch, v_provider, 'Split workbook', 'split.xlsx', 'patrol_finance', v_admin);
  INSERT INTO public.file_import_finance_cost_rows (organization_id, batch_id, client_organization_id, service_agreement_id, source_file,
    source_sha256, derivative_sha256, source_sheet, source_row, source_row_sha256, component, cost_type, amount, service_date, site_id,
    source_values, status, finance_service_cost_id, applied_at)
  SELECT v_provider, v_batch, v_client, v_agreement, 'split.xlsx', repeat('a', 64), repeat('b', 64), 'List', r.source_row,
    encode(sha256(convert_to('split-row-' || r.source_row, 'UTF8')), 'hex'), r.component, r.cost_type, r.amount, v_day, v_site,
    r.source_values, 'applied', r.line_id, now()
  FROM (VALUES
    (2, 'job_cost', 'labour', 40::numeric, '{"activity_type":"Contract","charge_code":"90002"}'::jsonb, v_line_labour),
    (3, 'job_cost', 'labour', 35::numeric, '{"charge_code":"90002"}'::jsonb, v_line_labour),
    (4, 'job_cost', 'labour', 25::numeric, '{"charge_code":"99999"}'::jsonb, v_line_labour),
    (5, 'travel_cost', 'vehicle', 30::numeric, '{"activity_type":" extra ","charge_code":"90001"}'::jsonb, v_line_vehicle)
  ) AS r(source_row, component, cost_type, amount, source_values, line_id);

  PERFORM pg_temp.check('classification: TYPE wins over the catalog and flags the conflict',
    (SELECT basis = 'contract' AND conflict FROM public.classify_patrol_cost_row_billing_basis(v_provider, '{"activity_type":"Contract","charge_code":"90002"}')));
  PERFORM pg_temp.check('classification: catalog basis is used when TYPE is blank',
    (SELECT basis = 'extra' AND NOT conflict FROM public.classify_patrol_cost_row_billing_basis(v_provider, '{"activity_type":"","charge_code":"90002"}')));
  PERFORM pg_temp.check('classification: unknown code and no TYPE is unclassified',
    (SELECT basis = 'unclassified' FROM public.classify_patrol_cost_row_billing_basis(v_provider, '{"charge_code":"99999"}')));

  PERFORM pg_temp.as_user(v_admin);
  v_split := public.get_finance_pl_period_billing_basis(v_period);
  SELECT total_cost INTO v_pl_total FROM public.get_finance_pl_period_summary(v_period);

  PERFORM pg_temp.check('period split reconciles to the P&L total',
    (v_split->'totals'->>'total_cost')::numeric = v_pl_total AND v_pl_total = 435
    AND (v_split->'totals'->>'contract_cost')::numeric + (v_split->'totals'->>'extra_cost')::numeric
      + (v_split->'totals'->>'unclassified_cost')::numeric + (v_split->'totals'->>'other_cost')::numeric = v_pl_total);
  PERFORM pg_temp.check('contract = TYPE contract row + contracted dispatch job', (v_split->'totals'->>'contract_cost')::numeric = 110);
  PERFORM pg_temp.check('extra = catalog Extra row + trimmed TYPE extra row', (v_split->'totals'->>'extra_cost')::numeric = 65);
  PERFORM pg_temp.check('unclassified = unknown row + unlinked remainder + undecided dispatch job',
    (v_split->'totals'->>'unclassified_cost')::numeric = 60 AND (v_split->'totals'->>'unlinked_cost')::numeric = 20);
  PERFORM pg_temp.check('timesheet cost is other, not guessed', (v_split->'totals'->>'other_cost')::numeric = 200);
  PERFORM pg_temp.check('row counters (rows 2 and 5 disagree with the catalog)',
    (v_split->'totals'->>'unclassified_rows')::int = 1 AND (v_split->'totals'->>'conflict_rows')::int = 2);
  PERFORM pg_temp.check('one agreement row with names and a null price',
    jsonb_array_length(v_split->'by_agreement') = 1
    AND v_split->'by_agreement'->0->>'agreement_name' = 'Forest Security'
    AND v_split->'by_agreement'->0->>'client_name' = 'Split Client'
    AND (v_split->'by_agreement'->0->>'total_cost')::numeric = 435
    AND v_split->'by_agreement'->0->'agreement_price' = 'null'::jsonb);
  PERFORM pg_temp.check('finance cost lines are not rewritten',
    (SELECT count(*) FROM public.finance_service_costs WHERE pl_period_id = v_period) = 5);

  v_agreement_summary := public.get_agreement_billing_basis_summary(v_agreement, NULL, NULL);
  PERFORM pg_temp.check('agreement tab uses the same rule',
    (v_agreement_summary->'imported_cost_totals'->>'contract_cost')::numeric = 40
    AND (v_agreement_summary->'imported_cost_totals'->>'extra_cost')::numeric = 65
    AND (v_agreement_summary->'imported_cost_totals'->>'unclassified_cost')::numeric = 25
    AND (v_agreement_summary->'imported_cost_totals'->>'conflict_rows')::int = 2);

  v_split := public.get_finance_pl_period_billing_basis(v_empty_period);
  PERFORM pg_temp.check('empty period returns zeros, not an error',
    (v_split->'totals'->>'total_cost')::numeric = 0 AND jsonb_array_length(v_split->'by_agreement') = 0);

  PERFORM pg_temp.as_user(v_outsider);
  PERFORM pg_temp.check('another organisation cannot read the period', pg_temp.raises(format(
    'select public.get_finance_pl_period_billing_basis(%L)', v_period), 'P&L period not found in organization'));
  PERFORM pg_temp.check('the classification helper is not an API', pg_temp.raises(format(
    'select * from public.classify_patrol_cost_row_billing_basis(%L, %L)', v_provider, '{}'), 'permission denied'));
  PERFORM pg_temp.as_admin();
END $$;

ROLLBACK;
