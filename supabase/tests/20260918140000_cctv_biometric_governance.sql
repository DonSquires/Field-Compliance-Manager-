-- Behavioural truth table for 20260918140000_cctv_biometric_governance.sql.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.as_user(p_user uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  SET LOCAL ROLE authenticated;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_service() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  SET LOCAL ROLE service_role;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.as_admin() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  SET LOCAL ROLE postgres;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.face(p_seed float) RETURNS public.vector LANGUAGE sql AS $$
  SELECT ('[' || array_to_string(array_fill(p_seed, ARRAY[128]), ',') || ']')::public.vector(128)
$$;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_officer uuid := gen_random_uuid();
  v_stranger uuid := gen_random_uuid();
  v_house uuid;
  v_import uuid;
  v_evidence uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_rejected uuid;
  v_old_unreviewed uuid;
  v_fresh_unreviewed uuid;
  v_accepted uuid;
  v_row public.cctv_entity_observations%rowtype;
  v_result jsonb;
  v_count integer;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'T_BIO_ORG', 'service_provider'), (v_other_org, 'T_BIO_OTHER', 'client');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'BioAdmin'), (v_officer, v_org, 'officer', 'BioOfficer'), (v_stranger, v_other_org, 'admin', 'BioStranger');
  INSERT INTO public.locations (organization_id, name, address) VALUES (v_org, 'T Bio House', '9 Template Way') RETURNING id INTO v_house;
  INSERT INTO public.cctv_imports (organization_id, location_id, canonical_place_id, camera_label, camera_key, status)
  SELECT v_org, id, canonical_place_id, 'Bio camera', 't-bio-camera', 'registered' FROM public.locations WHERE id = v_house
  RETURNING id INTO v_import;
  INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id)
  VALUES (v_evidence, v_org, 'cctv_review', 'video', 'org/t/bio.mp4', v_import);
  INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain, status)
  VALUES (v_job, v_org, v_evidence, 'video_motion', 'complete');

  INSERT INTO public.cctv_entity_observations (organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, cctv_import_id, face_vec, appearance_vec, candidate_embedding, review_state, created_at)
  VALUES (v_org, v_job, v_evidence, 'person-1', 'person', '2026-06-01T10:00:00Z', v_import, pg_temp.face(0.1), NULL, '[0.1,0.2]'::jsonb, 'unreviewed', clock_timestamp() - interval '120 days')
  RETURNING id INTO v_old_unreviewed;
  INSERT INTO public.cctv_entity_observations (organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, cctv_import_id, face_vec, review_state, created_at)
  VALUES (v_org, v_job, v_evidence, 'person-2', 'person', '2026-09-17T10:00:00Z', v_import, pg_temp.face(0.2), 'unreviewed', clock_timestamp() - interval '2 days')
  RETURNING id INTO v_fresh_unreviewed;
  INSERT INTO public.cctv_entity_observations (organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, cctv_import_id, face_vec, review_state, created_at)
  VALUES (v_org, v_job, v_evidence, 'person-3', 'person', '2026-09-17T10:05:00Z', v_import, pg_temp.face(0.3), 'unreviewed', clock_timestamp() - interval '1 day')
  RETURNING id INTO v_rejected;
  INSERT INTO public.cctv_entity_observations (organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, cctv_import_id, face_vec, review_state, created_at)
  VALUES (v_org, v_job, v_evidence, 'person-4', 'person', '2026-01-01T10:00:00Z', v_import, pg_temp.face(0.4), 'accepted', clock_timestamp() - interval '300 days')
  RETURNING id INTO v_accepted;

  -- ── browser roles cannot read templates ──
  PERFORM pg_temp.as_user(v_officer);
  SELECT count(*) INTO v_count FROM public.cctv_entity_observations WHERE organization_id = v_org;
  PERFORM pg_temp.check('an organisation member still lists sightings through the allowed columns', v_count = 4);
  SELECT count(*) INTO v_count FROM public.cctv_entity_observations WHERE organization_id = v_org AND thumbnail IS NULL AND review_state = 'unreviewed';
  PERFORM pg_temp.check('review-facing columns remain readable', v_count = 3);
  BEGIN
    PERFORM face_vec FROM public.cctv_entity_observations WHERE organization_id = v_org LIMIT 1;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('the face template column is not readable by a signed-in member', v_error LIKE '%permission denied%');
  BEGIN
    PERFORM appearance_vec, candidate_embedding, appearance_embedding FROM public.cctv_entity_observations WHERE organization_id = v_org LIMIT 1;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('the appearance and raw embedding columns are not readable either', v_error LIKE '%permission denied%');
  BEGIN
    PERFORM * FROM public.cctv_entity_observations WHERE organization_id = v_org LIMIT 1;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('a wildcard read fails rather than leaking templates', v_error LIKE '%permission denied%');

  -- ── matching still works inside the database ──
  PERFORM pg_temp.as_user(v_officer);
  SELECT count(*) INTO v_count FROM public.find_cctv_portfolio_matches(v_org, 'person', to_jsonb(array_fill(0.2::float, ARRAY[128])), NULL, NULL, v_fresh_unreviewed, 5);
  PERFORM pg_temp.check('same-or-similar matching still runs for the reviewer through the definer path', v_count >= 1);

  -- ── review responses carry no templates ──
  PERFORM pg_temp.as_user(v_officer);
  v_row := public.review_cctv_entity_observation(v_rejected, 'reject', NULL, NULL, NULL, 'Not a face');
  PERFORM pg_temp.check('the review response is redacted of templates', v_row.face_vec IS NULL AND v_row.candidate_embedding IS NULL AND v_row.review_state = 'rejected');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('redaction is on the response only; the stored template is untouched until expiry', (SELECT face_vec IS NOT NULL FROM public.cctv_entity_observations WHERE id = v_rejected));

  -- ── expiry ──
  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.expire_cctv_biometric_templates(interval '90 days', v_org, 100);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('only the service identity can expire templates', v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');

  BEGIN
    PERFORM pg_temp.as_service();
    PERFORM public.expire_cctv_biometric_templates(interval '1 hour', v_org, 100);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a retention window shorter than a day is refused', v_error LIKE '%at least one day%');

  PERFORM pg_temp.as_service();
  v_result := public.expire_cctv_biometric_templates(interval '90 days', v_org, 100);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('expiry reports what it removed', (v_result->>'expired')::int = 2);
  PERFORM pg_temp.check('a rejected sighting loses its templates immediately',
    (SELECT face_vec IS NULL AND attributes->>'biometric_templates_expiry_reason' = 'rejected' FROM public.cctv_entity_observations WHERE id = v_rejected));
  PERFORM pg_temp.check('an undecided sighting past the window loses its templates',
    (SELECT face_vec IS NULL AND candidate_embedding IS NULL AND attributes->>'biometric_templates_expiry_reason' = 'retention_window' FROM public.cctv_entity_observations WHERE id = v_old_unreviewed));
  PERFORM pg_temp.check('a recent undecided sighting keeps its template', (SELECT face_vec IS NOT NULL FROM public.cctv_entity_observations WHERE id = v_fresh_unreviewed));
  PERFORM pg_temp.check('an accepted identity keeps its template regardless of age', (SELECT face_vec IS NOT NULL FROM public.cctv_entity_observations WHERE id = v_accepted));
  PERFORM pg_temp.check('the sightings themselves remain', (SELECT count(*) FROM public.cctv_entity_observations WHERE organization_id = v_org) = 4);
  PERFORM pg_temp.check('expiry is audited per organisation with counts only',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.organization_id = v_org AND a.action = 'cctv_biometric_templates_expired'
              AND (a.metadata->>'expired')::int = 2 AND (a.metadata->>'rejected')::int = 1 AND (a.metadata->>'aged_out')::int = 1 AND NOT (a.metadata ? 'observation_ids')));
  PERFORM pg_temp.as_service();
  v_result := public.expire_cctv_biometric_templates(interval '90 days', v_org, 100);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a second run has nothing left to expire', (v_result->>'expired')::int = 0);

  -- ── governance readout ──
  PERFORM pg_temp.as_user(v_officer);
  v_result := public.cctv_biometric_governance(v_org);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the organisation can see its biometric holdings',
    (v_result->>'live_face_templates')::int = 2 AND (v_result->>'expired_templates')::int = 2 AND (v_result->>'rejected_still_holding_templates')::int = 0
    AND (v_result->>'last_expiry_run_at') IS NOT NULL AND v_result->>'default_retention' = '90 days');
  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.cctv_biometric_governance(v_org);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('another organisation cannot read the holdings', v_error LIKE '%access denied%');
END $$;
ROLLBACK;
