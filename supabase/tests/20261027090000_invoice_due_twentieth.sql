-- Behavioural truth table: an agreement can be due on a day of the month after the invoiced work
-- (R&M: October work invoiced early November, due 20 November). Both invoice generators use it;
-- without it the due date stays payment_terms_days after the invoice date. Runs in a transaction
-- and rolls back.
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
  v_admin uuid := gen_random_uuid();
  v_due uuid := gen_random_uuid();
  v_days uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_job uuid;
  v_result jsonb;
  v_invoice public.invoices%ROWTYPE;
  v_agreement_invoice record;
  v_last_month_start date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_last_month_end date := (date_trunc('month', current_date) - interval '1 day')::date;
  v_this_twentieth date := date_trunc('month', current_date)::date + 19;
  v_next_twentieth date := (date_trunc('month', current_date) + interval '1 month')::date + 19;
BEGIN
  -- The rule itself.
  PERFORM pg_temp.check('October work invoiced 3 November is due 20 November',
    public.invoice_due_date(date '2026-11-03', date '2026-10-31', 14, 20) = date '2026-11-20');
  PERFORM pg_temp.check('an invoice raised after the 20th rolls to the next 20th',
    public.invoice_due_date(date '2026-11-25', date '2026-10-31', 14, 20) = date '2026-12-20');
  PERFORM pg_temp.check('the 20th itself is not rolled forward',
    public.invoice_due_date(date '2026-11-20', date '2026-10-31', 14, 20) = date '2026-11-20');
  PERFORM pg_temp.check('with no period the month after the invoice is used',
    public.invoice_due_date(date '2026-11-03', NULL, 14, 20) = date '2026-12-20');
  PERFORM pg_temp.check('a December period is due 20 January',
    public.invoice_due_date(date '2027-01-04', date '2026-12-31', 14, 20) = date '2027-01-20');
  PERFORM pg_temp.check('without a due day the payment days still apply',
    public.invoice_due_date(date '2026-11-03', date '2026-10-31', 30, NULL) = date '2026-12-03'
    AND public.invoice_due_date(date '2026-11-03', NULL, NULL, NULL) = date '2026-11-17');

  INSERT INTO public.organizations (id, name, organization_type, active, status) VALUES
    (v_provider, 'Due Day Provider', 'service_provider', true, 'active'),
    (v_client, 'Due Day Client', 'government', true, 'active');
  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name) VALUES
    (v_admin, 'master', v_provider, v_provider, 'Due Day Admin');
  INSERT INTO public.service_agreements (id, provider_organization_id, client_organization_id, name, agreement_type, starts_on, invitation_status) VALUES
    (v_due, v_provider, v_client, 'Monthly Due 20th', 'operational', current_date - 90, 'accepted'),
    (v_days, v_provider, v_client, 'Thirty Days', 'operational', current_date - 90, 'accepted');
  INSERT INTO public.client_sites (id, client_organization_id, organization_id, name, address, center_point, gps_lat, gps_lng, active) VALUES
    (v_site, v_client, v_provider, 'Gate', '1 Gate Road', st_setsrid(st_makepoint(173.0, -41.4), 4326), -41.4, 173.0, true);
  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status) VALUES (v_due, v_site, 'active') ON CONFLICT DO NOTHING;
  UPDATE public.client_sites SET service_agreement_id = v_due WHERE id = v_site;

  -- Terms: validated and audited.
  PERFORM pg_temp.as_user(v_admin);
  PERFORM pg_temp.check('a due day of 31 is refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_due, 'pay_as_you_go', '{"payment_due_day_of_month":31}'), 'from 1 to 28'));
  PERFORM pg_temp.check('a due day that is not a number is refused', pg_temp.raises(format(
    'select public.set_agreement_commercial_terms(%L, %L, %L, null)', v_due, 'pay_as_you_go', '{"payment_due_day_of_month":"20th"}'), 'from 1 to 28'));
  v_result := public.set_agreement_commercial_terms(v_due, 'pay_as_you_go',
    '{"billing_cycle":"monthly","payment_due_day_of_month":20,"base_rate_per_hour":100}', NULL);
  PERFORM pg_temp.check('the due day is stored, returned and audited',
    (v_result->>'payment_due_day_of_month')::int = 20
    AND (SELECT payment_due_day_of_month = 20 FROM public.crm_commercial_settings WHERE service_agreement_id = v_due)
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'agreement_commercial_terms_set'
      AND metadata->>'service_agreement_id' = v_due::text AND (metadata->'after'->>'payment_due_day_of_month')::int = 20));
  PERFORM public.set_agreement_commercial_terms(v_due, 'pay_as_you_go', '{"notes":"monthly"}', NULL);
  PERFORM pg_temp.check('the due day is kept when other terms change',
    (SELECT payment_due_day_of_month = 20 FROM public.crm_commercial_settings WHERE service_agreement_id = v_due));
  PERFORM public.set_agreement_commercial_terms(v_days, 'pay_as_you_go', '{"payment_terms_days":30,"base_rate_per_hour":100}', NULL);

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the table refuses a due day of 29', pg_temp.raises(format(
    'update public.crm_commercial_settings set payment_due_day_of_month = 29 where service_agreement_id = %L', v_due), 'payment_due_day_check'));

  -- Completed work for last month: due on the 20th after it (or the next 20th if invoiced after the 20th).
  PERFORM pg_temp.as_user(v_admin);
  SELECT id INTO v_job FROM public.create_dispatch_job_for_place(v_provider, v_due, v_site, NULL, gen_random_uuid(), 'callout', 'normal', 60, NULL, 'Gate alarm', NULL);
  PERFORM pg_temp.as_admin();
  INSERT INTO public.dispatch_job_charge_lines (organization_id, source_dispatch_id, client_organization_id, service_agreement_id, rate_type, description, quantity, unit_rate, line_total, created_at)
  VALUES (v_provider, v_job, v_client, v_due, 'hourly', 'Gate alarm', 1, 100, 100, v_last_month_end::timestamptz + interval '12 hours');

  PERFORM pg_temp.as_user(v_admin);
  v_invoice := public.generate_crm_invoice_from_completed_work(gen_random_uuid(), v_provider, v_client, v_due, v_last_month_start, v_last_month_end);
  PERFORM pg_temp.check('last month''s work is due on the 20th of this month (next 20th once it has passed)',
    v_invoice.invoice_date = current_date
    AND v_invoice.due_date = CASE WHEN current_date <= v_this_twentieth THEN v_this_twentieth ELSE v_next_twentieth END
    AND v_invoice.subtotal = 100 AND v_invoice.gst_amount = 15 AND v_invoice.total_amount = 115);
  PERFORM pg_temp.check('the due date is audited',
    EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'crm_invoice_generated_from_completed_work' AND target_id = v_invoice.id
      AND (metadata->>'payment_due_day_of_month')::int = 20 AND (metadata->>'due_date')::date = v_invoice.due_date));

  -- The agreement-price invoice now follows the agreement terms too.
  SELECT * INTO v_agreement_invoice FROM public.generate_crm_invoice_from_agreement(gen_random_uuid(), v_due, v_last_month_start, v_last_month_end);
  PERFORM pg_temp.check('the agreement-price invoice is due on the 20th as well',
    (SELECT due_date FROM public.invoices WHERE id = v_agreement_invoice.invoice_id)
      = CASE WHEN current_date <= v_this_twentieth THEN v_this_twentieth ELSE v_next_twentieth END);
  SELECT * INTO v_agreement_invoice FROM public.generate_crm_invoice_from_agreement(gen_random_uuid(), v_days, v_last_month_start, v_last_month_end);
  PERFORM pg_temp.check('an agreement on payment days uses its own days, not a fixed 14',
    (SELECT due_date FROM public.invoices WHERE id = v_agreement_invoice.invoice_id) = current_date + 30);
END $$;

ROLLBACK;
