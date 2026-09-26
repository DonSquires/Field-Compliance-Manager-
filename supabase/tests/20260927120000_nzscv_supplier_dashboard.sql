-- Read-only NZSCV supplier dashboard: role boundary, aggregate usage, and redaction.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL ROLE postgres;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok [%]', p_label;
END
$$;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_supplier uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_scv uuid := gen_random_uuid();
  v_plate text := 'T' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  v_result jsonb;
  v_denied boolean := false;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type, active, status)
  VALUES (v_org, 'NZSCV supplier dashboard test', 'service_provider', true, 'active');

  INSERT INTO auth.users (id, instance_id, aud, role, email)
  VALUES
    (v_supplier, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nzscv-supplier@example.test'),
    (v_admin, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ordinary-admin@example.test');

  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name, email)
  VALUES
    (v_supplier, 'nzscv_monitor', v_org, v_org, 'NZSCV Supplier', 'nzscv-supplier@example.test'),
    (v_admin, 'admin', v_org, v_org, 'Ordinary Admin', 'ordinary-admin@example.test');

  INSERT INTO public.canonical_scv (
    id, plate_number, certificate_number, certificate_status, issued_date,
    expiry_date, source, imported_at, raw_source_row
  ) VALUES (
    v_scv, v_plate, 'CERT-TEST-1', 'active', current_date - 30,
    current_date + 60, 'csv_import', clock_timestamp(), '{"private_supplier_column":"must-not-leak"}'::jsonb
  );

  INSERT INTO public.scv_import_batches (
    organization_id, source_name, file_name, status, total_rows, valid_rows,
    inserted_rows, updated_rows, skipped_rows, invalid_rows, imported_by,
    started_at, completed_at
  ) VALUES (
    v_org, 'canonical_scv_csv', 'private-supplier-file.csv', 'completed', 1, 1,
    1, 0, 0, 0, v_admin, clock_timestamp(), clock_timestamp()
  );

  INSERT INTO public.observations (
    organization_id, officer_id, plate_number, module_key, canonical_scv_id,
    observed_at
  ) VALUES (
    v_org, v_admin, v_plate, 'freedom_camping', v_scv, clock_timestamp()
  );

  PERFORM pg_temp.as_user(v_supplier);
  SELECT public.get_nzscv_supplier_dashboard(v_plate, 20, 0) INTO v_result;
  PERFORM pg_temp.as_admin();

  PERFORM pg_temp.check('supplier sees matching public register row', jsonb_array_length(v_result->'records') = 1 AND v_result#>>'{records,0,plate_number}' = v_plate);
  PERFORM pg_temp.check('supplier sees aggregate Freedom Camping usage', (v_result#>>'{summary,freedom_camping_lookups_total}')::integer >= 1);
  PERFORM pg_temp.check('supplier sees a thirty-day usage series', jsonb_array_length(v_result->'daily_usage') = 30);
  PERFORM pg_temp.check('supplier sees import health without source filenames', jsonb_array_length(v_result->'imports') >= 1 AND v_result::text NOT LIKE '%private-supplier-file.csv%');
  PERFORM pg_temp.check('supplier response omits tenant and raw source detail', v_result#>>'{privacy,tenant_details_included}' = 'false' AND v_result::text NOT LIKE '%must-not-leak%' AND v_result::text NOT LIKE '%NZSCV supplier dashboard test%');

  PERFORM pg_temp.as_user(v_admin);
  BEGIN
    PERFORM public.get_nzscv_supplier_dashboard(NULL, 20, 0);
  EXCEPTION WHEN OTHERS THEN
    v_denied := SQLERRM LIKE '%NZSCV supplier access required%';
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('ordinary admin is denied supplier analytics', v_denied);
END
$$;

ROLLBACK;
