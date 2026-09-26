-- Behavioural truth table for dispatch jobs anchored to either a Site or a Zone.
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

DO $$
DECLARE
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_site uuid := gen_random_uuid();
  v_zone uuid := gen_random_uuid();
  v_other_zone uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_result record;
  v_first_job uuid;
  v_denied boolean := false;
  v_alarm public.alarm_events%rowtype;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type, active, status)
  VALUES
    (v_provider, 'Dispatch Place Provider', 'service_provider', true, 'active'),
    (v_client, 'Dispatch Place Client', 'government', true, 'active');

  INSERT INTO public.user_profiles (id, role, organization_id, employer_organization_id, display_name)
  VALUES (v_admin, 'master', v_provider, v_provider, 'Dispatch Place Admin');

  INSERT INTO public.service_agreements (
    id, provider_organization_id, client_organization_id, name,
    agreement_type, starts_on, invitation_status
  ) VALUES (
    v_agreement, v_provider, v_client, 'Dispatch Place Agreement',
    'operational', current_date, 'accepted'
  );

  INSERT INTO public.client_sites (
    id, client_organization_id, organization_id, name, address,
    center_point, gps_lat, gps_lng, active
  ) VALUES (
    v_site, v_client, v_provider, 'Dispatch Site', '1 Dispatch Way',
    st_setsrid(st_makepoint(173.2840, -41.2706), 4326), -41.2706, 173.2840, true
  );

  INSERT INTO public.location_zones (
    id, organization_id, name, zone_type, module_key, is_active, center_point
  ) VALUES
    (v_zone, v_client, 'Dispatch Zone', 'general', 'patrol', true, st_setsrid(st_makepoint(173.2900, -41.2750), 4326)),
    (v_other_zone, v_client, 'Unlinked Zone', 'general', 'patrol', true, st_setsrid(st_makepoint(173.3000, -41.2800), 4326));

  INSERT INTO public.service_agreement_locations (service_agreement_id, site_id, status)
  VALUES (v_agreement, v_site, 'active') ON CONFLICT DO NOTHING;
  INSERT INTO public.service_agreement_locations (service_agreement_id, zone_id, status)
  VALUES (v_agreement, v_zone, 'active') ON CONFLICT DO NOTHING;

  PERFORM pg_temp.as_user(v_admin);
  SELECT * INTO v_result FROM public.create_dispatch_job_for_place(
    v_provider, v_agreement, NULL, v_zone, v_request,
    'patrol_support', 'normal', 30, NULL, 'Zone response', NULL
  );
  v_first_job := v_result.id;
  PERFORM pg_temp.check(
    'agreement-linked Zone creates one dispatch job',
    v_result.created
    AND EXISTS (
      SELECT 1 FROM public.dispatch_jobs job
      WHERE job.id = v_result.id
        AND job.client_site_id IS NULL
        AND job.zone_id = v_zone
    )
  );

  SELECT * INTO v_result FROM public.create_dispatch_job_for_place(
    v_provider, v_agreement, NULL, v_zone, v_request,
    'patrol_support', 'normal', 30, NULL, 'Zone response', NULL
  );
  PERFORM pg_temp.check(
    'Zone dispatch replay is idempotent',
    NOT v_result.created AND v_result.id = v_first_job
  );

  SELECT * INTO v_alarm FROM public.record_alarm_signal(
    v_first_job, now() - interval '1 minute', 'burglary', 'phone'
  );
  PERFORM pg_temp.check(
    'alarm intake preserves the Zone as its location',
    v_alarm.site_id IS NULL AND v_alarm.location_name = 'Dispatch Zone'
  );

  BEGIN
    PERFORM public.create_dispatch_job_for_place(
      v_provider, v_agreement, NULL, v_other_zone, gen_random_uuid(),
      'patrol_support', 'normal', 30, NULL, NULL, NULL
    );
  EXCEPTION WHEN others THEN
    v_denied := sqlerrm LIKE '%Place is not active under this service agreement%';
  END;
  PERFORM pg_temp.check('unlinked Zone is rejected', v_denied);

  PERFORM pg_temp.as_admin();
  INSERT INTO public.rate_rules (
    organization_id, rule_kind, name, rate_type, amount, job_type,
    client_org_id, zone_id, priority, active, effective_from
  ) VALUES
    (v_provider, 'pay', 'Zone travel pay', 'per_km', 0.95, 'patrol_support', NULL, v_zone, 50, true, current_date - 1),
    (v_provider, 'billing', 'Zone travel charge', 'per_km', 1.04, 'patrol_support', v_client, v_zone, 50, true, current_date - 1);
  UPDATE public.dispatch_jobs
  SET status = 'completed',
      en_route_at = now() - interval '45 minutes',
      on_scene_at = now() - interval '30 minutes',
      completed_at = now(),
      insert_gps_lat = -41.2900,
      insert_gps_lng = 173.2400
  WHERE id = v_first_job;
  PERFORM public.resolve_dispatch_job_financials_internal(v_admin, gen_random_uuid(), v_first_job, NULL);
  PERFORM pg_temp.check(
    'Zone completion resolves travel distance and Zone-specific rates',
    EXISTS (
      SELECT 1 FROM public.dispatch_job_pay_lines line
      WHERE line.source_dispatch_id = v_first_job
        AND line.rate_type = 'per_km'
        AND line.rate_rule_id IS NOT NULL
        AND line.distance_km > 0
    )
    AND EXISTS (
      SELECT 1 FROM public.dispatch_job_charge_lines line
      WHERE line.source_dispatch_id = v_first_job
        AND line.rate_type = 'per_km'
        AND line.rate_rule_id IS NOT NULL
        AND line.distance_km > 0
    )
  );

  PERFORM pg_temp.as_user(v_admin);
  SELECT * INTO v_result FROM public.create_dispatch_job(
    v_provider, v_agreement, v_site, gen_random_uuid(),
    'alarm_response', 'high', 15, NULL, 'Legacy Site path', NULL
  );
  PERFORM pg_temp.check(
    'legacy Site-only RPC remains compatible',
    v_result.created
    AND EXISTS (
      SELECT 1 FROM public.dispatch_jobs job
      WHERE job.id = v_result.id
        AND job.client_site_id = v_site
        AND job.zone_id IS NULL
    )
  );

  PERFORM pg_temp.as_admin();
END $$;

ROLLBACK;