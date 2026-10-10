BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
    true
  );
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  SET LOCAL ROLE postgres;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN
    RAISE EXCEPTION 'FAIL [%]', p_label;
  END IF;
  RAISE NOTICE 'ok [%]', p_label;
END
$$;

DO $$
DECLARE
  v_provider uuid := gen_random_uuid();
  v_client uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_agreement uuid := gen_random_uuid();
  v_location uuid;
  v_zone uuid;
  v_event uuid := gen_random_uuid();
  v_vehicle uuid;
  v_observation_one uuid;
  v_observation_two uuid := gen_random_uuid();
  v_result jsonb;
  v_registry jsonb;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES
    (v_provider, 'T Approved Vehicle Provider', 'service_provider'),
    (v_client, 'T Approved Vehicle Client', 'government');

  INSERT INTO public.user_profiles (
    id, role, organization_id, employer_organization_id, display_name
  ) VALUES (
    v_admin, 'admin', v_provider, v_provider, 'Approved Vehicle Admin'
  );

  INSERT INTO public.service_agreements (
    id, provider_organization_id, client_organization_id, name,
    agreement_type, starts_on, invitation_status
  ) VALUES (
    v_agreement, v_provider, v_client, 'T Approved Vehicle Agreement',
    'operational', current_date, 'accepted'
  );

  INSERT INTO public.locations (organization_id, name, address)
  VALUES (v_client, 'T Approved Vehicle Place', '132 Vehicle Test Road')
  RETURNING id INTO v_location;

  INSERT INTO public.location_zones (
    organization_id, location_id, name, zone_type, module_key
  ) VALUES (
    v_client, v_location, 'T Approved Vehicle Zone', 'patrol_route', 'patrol'
  )
  RETURNING id INTO v_zone;

  INSERT INTO public.location_events (
    id, organization_id, zone_id, event_type, module_key, occurred_at,
    source, external_ref, payload
  ) VALUES (
    v_event,
    v_client,
    v_zone,
    'camera_activation',
    'patrol',
    '2026-01-11T04:00:00Z',
    'rm_patrol_log_import',
    'T-approved-vehicle-event',
    jsonb_build_object(
      'source', 'rm_patrol_log_import',
      'comments', 'CCTV review confirmed TST123 entered the gate.',
      'source_file', 'Approved Patrol Log.xlsx',
      'source_sha256', repeat('a', 64),
      'source_sheet', 'DATA',
      'source_row', 42
    )
  );

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.promote_approved_rnm_vehicle_mentions(v_provider);

  PERFORM pg_temp.as_admin();
  SELECT canonical_vehicle_id
    INTO v_vehicle
    FROM public.observations
   WHERE organization_id = v_client
     AND import_key = 'rm_approved_note_plate:' || v_event::text || ':TST123';

  PERFORM pg_temp.check(
    'approved note creates one canonical vehicle observation',
    v_vehicle IS NOT NULL
      AND (v_result->>'observations_inserted')::integer = 1
  );
  PERFORM pg_temp.check(
    'camera provenance remains visible without requiring a photo',
    EXISTS (
      SELECT 1
      FROM public.observations
      WHERE canonical_vehicle_id = v_vehicle
        AND module_key = 'cctv_review'
        AND plate_source = 'historical_import'
        AND officer_notes LIKE 'CCTV review confirmed%'
        AND source_sha256 = repeat('a', 64)
    )
  );
  PERFORM pg_temp.check(
    'promotion records canonical provenance and audit receipt',
    EXISTS (
      SELECT 1
      FROM public.canonical_vehicle_links
      WHERE canonical_vehicle_id = v_vehicle
        AND source_system = 'approved_working_file_observation'
        AND metadata->>'review_state' = 'approved_in_working_file'
    )
    AND EXISTS (
      SELECT 1
      FROM public.audit_log
      WHERE action = 'approved_working_file_plate_promoted'
        AND target_id IN (
          SELECT id FROM public.observations WHERE canonical_vehicle_id = v_vehicle
        )
    )
  );

  PERFORM pg_temp.as_user(v_admin);
  v_registry := public.get_identity_registry(v_provider, 'TST123', 250);
  PERFORM pg_temp.check(
    'provider Identity Records includes client-owned observation vehicles',
    (v_registry->>'vehicle_total')::integer = 1
      AND v_registry->'vehicles'->0->>'plate_number' = 'TST123'
      AND (v_registry->'vehicles'->0->>'observation_count')::integer = 1
  );
  PERFORM pg_temp.check(
    'vehicle activity returns approved CCTV note and source',
    EXISTS (
      SELECT 1
      FROM public.get_identity_vehicle_activity(v_provider, v_vehicle, 10) activity
      WHERE activity.source_kind = 'CCTV review'
        AND activity.officer_notes LIKE 'CCTV review confirmed%'
        AND activity.place_name = 'T Approved Vehicle Zone'
    )
  );

  v_result := public.promote_approved_rnm_vehicle_mentions(v_provider);
  PERFORM pg_temp.check(
    'promotion replay creates no duplicate observation',
    (v_result->>'observations_inserted')::integer = 0
      AND (SELECT count(*) FROM public.observations
           WHERE import_key = 'rm_approved_note_plate:' || v_event::text || ':TST123') = 1
  );

  PERFORM pg_temp.as_admin();
  SELECT id INTO v_observation_one
  FROM public.observations
  WHERE import_key = 'rm_approved_note_plate:' || v_event::text || ':TST123';
  INSERT INTO public.observations (
    id, organization_id, plate_number, zone_id, observed_at, module_key,
    canonical_vehicle_id, plate_source, import_key
  ) VALUES (
    v_observation_two, v_client, 'TST123', v_zone,
    '2026-01-11T04:05:00Z', 'patrol', v_vehicle,
    'historical_import', 'T-approved-photo-reuse'
  );

  PERFORM pg_temp.as_user(v_admin);
  PERFORM public.attach_external_photo_to_record(
    'observation',
    v_observation_one,
    'org/' || v_client::text || '/record-evidence/observation/' || v_observation_one::text || '/' || repeat('b', 64) || '.jpg',
    repeat('b', 64),
    'Approved source photo',
    'Synthetic approved source',
    '260111 1600 TST123.jpg',
    '2026-01-11T03:00:00Z'
  );
  PERFORM public.attach_external_photo_to_record(
    'observation',
    v_observation_two,
    'org/' || v_client::text || '/record-evidence/observation/' || v_observation_one::text || '/' || repeat('b', 64) || '.jpg',
    repeat('b', 64),
    'Approved source photo',
    'Synthetic approved source',
    '260111 1605 TST123.jpg',
    '2026-01-11T03:05:00Z'
  );

  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check(
    'identical photo bytes reuse one evidence item and link both observations',
    (SELECT count(*) = 1 FROM public.evidence_items
      WHERE organization_id = v_client AND sha256_hash = repeat('b', 64))
    AND (SELECT count(*) = 2 FROM public.observation_supporting_evidence
      WHERE observation_id IN (v_observation_one, v_observation_two))
    AND EXISTS (
      SELECT 1 FROM public.audit_log
      WHERE action = 'external_photo_reused_for_observation'
        AND metadata->>'observation_id' = v_observation_two::text
    )
  );
END
$$;

ROLLBACK;
