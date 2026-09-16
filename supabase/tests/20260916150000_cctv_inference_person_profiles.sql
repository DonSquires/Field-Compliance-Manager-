-- Behavioural truth table for 20260916150000_cctv_inference_person_profiles.sql.
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

CREATE OR REPLACE FUNCTION pg_temp.emb(p_dims int, p_seed int, p_noise real) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_agg(round((CASE WHEN i = p_seed THEN 1.0 ELSE 0.0 END + p_noise * sin(i * 0.37 + p_seed))::numeric, 6) ORDER BY i)
  FROM generate_series(1, p_dims) AS i
$$;

DO $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_other_org uuid := gen_random_uuid();
  v_admin uuid := gen_random_uuid();
  v_other_admin uuid := gen_random_uuid();
  v_house uuid;
  v_import uuid;
  v_evidence_one uuid := gen_random_uuid();
  v_evidence_two uuid := gen_random_uuid();
  v_evidence_three uuid := gen_random_uuid();
  v_evidence_four uuid := gen_random_uuid();
  v_job_one uuid := gen_random_uuid();
  v_job_two uuid := gen_random_uuid();
  v_job_three uuid := gen_random_uuid();
  v_job_four uuid := gen_random_uuid();
  v_person_one uuid;
  v_person_two uuid;
  v_person_four uuid;
  v_canonical_one uuid;
  v_observation_one uuid;
  v_observation_two uuid;
  v_observation_three uuid;
  v_observation_four uuid;
  v_portfolio_one uuid;
  v_result uuid;
  v_row public.cctv_entity_observations%rowtype;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'T_CCTV_PROFILE_ORG', 'service_provider'), (v_other_org, 'T_CCTV_PROFILE_OTHER', 'client');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'ProfileAdmin'), (v_other_admin, v_other_org, 'admin', 'ProfileStranger');
  INSERT INTO public.locations (organization_id, name, address)
  VALUES (v_org, 'T CCTV Profile House', '150 Profile Road')
  RETURNING id INTO v_house;
  INSERT INTO public.cctv_imports (organization_id, location_id, canonical_place_id, camera_label, camera_key, status)
  SELECT v_org, id, canonical_place_id, 'Profile camera', 't-profile-camera', 'registered'
  FROM public.locations WHERE id = v_house
  RETURNING id INTO v_import;
  INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id)
  VALUES
    (v_evidence_one, v_org, 'cctv_review', 'video', 'org/t/profile-one.mp4', v_import),
    (v_evidence_two, v_org, 'cctv_review', 'video', 'org/t/profile-two.mp4', v_import),
    (v_evidence_three, v_org, 'cctv_review', 'video', 'org/t/profile-three.mp4', v_import),
    (v_evidence_four, v_org, 'cctv_review', 'video', 'org/t/profile-four.mp4', v_import);
  INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain, status)
  VALUES
    (v_job_one, v_org, v_evidence_one, 'video_motion', 'processing'),
    (v_job_two, v_org, v_evidence_two, 'video_motion', 'queued'),
    (v_job_three, v_org, v_evidence_three, 'video_motion', 'queued'),
    (v_job_four, v_org, v_evidence_four, 'video_motion', 'queued');

  PERFORM pg_temp.as_service();
  PERFORM public.record_cctv_entity_observations(v_job_one, v_evidence_one, v_org, jsonb_build_array(
    jsonb_build_object(
      'source_event_id', 'person-one',
      'entity_kind', 'person',
      'observed_at', '2026-09-16T10:00:00Z',
      'candidate_embedding', pg_temp.emb(128, 3, 0.02),
      'appearance_embedding', pg_temp.emb(256, 7, 0.02),
      'model_confidence', 0.91,
      'attributes', jsonb_build_object('face_event_id', 'face-one', 'upper_body_colour', 'blue')
    )
  ));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.cctv_entity_observations WHERE inference_job_id = v_job_one;
  v_observation_one := v_row.id;
  v_person_one := v_row.person_record_id;
  v_canonical_one := v_row.canonical_person_id;
  v_portfolio_one := v_row.portfolio_key;
  PERFORM pg_temp.check('inference creates an unknown person record and canonical profile',
    v_person_one IS NOT NULL
    AND v_canonical_one IS NOT NULL
    AND (SELECT display_name = 'Unknown Person #1' AND review_state = 'manual_review_required' FROM public.person_records WHERE id = v_person_one)
    AND (SELECT display_name = 'Unknown Person #1' AND review_state = 'manual_review_required' FROM public.canonical_people WHERE id = v_canonical_one)
    AND EXISTS (SELECT 1 FROM public.canonical_person_links WHERE canonical_person_id = v_canonical_one AND source_table = 'person_records' AND source_id = v_person_one)
  );
  PERFORM pg_temp.check('automatic person profile keeps the CCTV observation unreviewed',
    v_row.review_state = 'unreviewed' AND v_row.portfolio_state = 'unmatched'
  );
  PERFORM pg_temp.check('unknown profile stores a monotonic per-org sequence and inference provenance',
    (SELECT metadata->>'cctv_unknown_person_number' = '1' AND metadata->>'cctv_portfolio_key' = v_portfolio_one::text AND metadata->>'identity_status' = 'unknown_pending_human_review' FROM public.person_records WHERE id = v_person_one)
  );

  PERFORM pg_temp.as_service();
  PERFORM public.record_cctv_entity_observations(v_job_two, v_evidence_two, v_org, jsonb_build_array(
    jsonb_build_object(
      'source_event_id', 'person-two',
      'entity_kind', 'person',
      'observed_at', '2026-09-16T10:05:00Z',
      'candidate_embedding', pg_temp.emb(128, 3, 0.04),
      'appearance_embedding', pg_temp.emb(256, 7, 0.04),
      'model_confidence', 0.89,
      'attributes', jsonb_build_object('upper_body_colour', 'blue')
    )
  ));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.cctv_entity_observations WHERE inference_job_id = v_job_two;
  v_observation_two := v_row.id;
  PERFORM pg_temp.check('similar face/body inference reuses the portfolio profile',
    v_row.portfolio_key = v_portfolio_one
    AND v_row.person_record_id = v_person_one
    AND v_row.canonical_person_id = v_canonical_one
    AND v_row.review_state = 'unreviewed'
    AND (SELECT count(*) FROM public.person_records WHERE organization_id = v_org) = 1
  );
  PERFORM pg_temp.check('profile matching returns the canonical profile candidate',
    EXISTS (
      SELECT 1 FROM public.find_cctv_portfolio_matches(v_org, 'person', pg_temp.emb(128, 3, 0.03), pg_temp.emb(256, 7, 0.03)) AS match
      WHERE match.person_record_id = v_person_one AND match.portfolio_key = v_portfolio_one
    )
  );

  PERFORM pg_temp.as_service();
  PERFORM public.record_cctv_entity_observations(v_job_three, v_evidence_three, v_org, jsonb_build_array(
    jsonb_build_object(
      'source_event_id', 'person-three',
      'entity_kind', 'person',
      'observed_at', '2026-09-16T10:10:00Z',
      'candidate_embedding', pg_temp.emb(128, 60, 0.02),
      'appearance_embedding', pg_temp.emb(256, 80, 0.02),
      'model_confidence', 0.86
    )
  ));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.cctv_entity_observations WHERE inference_job_id = v_job_three;
  v_observation_three := v_row.id;
  v_person_two := v_row.person_record_id;
  PERFORM pg_temp.check('a dissimilar person creates the next unknown profile',
    v_person_two IS NOT NULL
    AND v_person_two <> v_person_one
    AND (SELECT display_name = 'Unknown Person #2' AND metadata->>'cctv_unknown_person_number' = '2' FROM public.person_records WHERE id = v_person_two)
  );

  PERFORM pg_temp.as_user(v_other_admin);
  BEGIN
    PERFORM public.update_cctv_person_profile(v_observation_one, 'Unauthorised name');
    RAISE EXCEPTION 'cross-org profile write unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('a reviewer outside the organization cannot name an inferred profile', v_error LIKE '%access denied%');

  PERFORM pg_temp.as_user(v_admin);
  v_row := public.update_cctv_person_profile(
    v_observation_one,
    'Aroha Example',
    jsonb_build_object('identification_note', 'Named after human review of source footage'),
    'Name recorded after reviewer inspected the footage.'
  );
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('human profile update renames the existing record and canonical projection',
    v_row.review_state = 'accepted'
    AND v_row.person_record_id = v_person_one
    AND v_row.canonical_person_id = v_canonical_one
    AND (SELECT display_name = 'Aroha Example' AND metadata #>> '{profile_details,identification_note}' = 'Named after human review of source footage' FROM public.person_records WHERE id = v_person_one)
    AND (SELECT display_name = 'Aroha Example' AND normalized_name = 'arohaexample' AND review_state = 'manual_review_required' AND NOT (metadata ? 'profile_details') FROM public.canonical_people WHERE id = v_canonical_one)
    AND EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'cctv_person_profile_updated' AND target_table = 'person_records' AND target_id = v_person_one)
  );
  PERFORM pg_temp.check('other profile observations retain an explicit unreviewed state',
    (SELECT review_state = 'unreviewed' AND person_record_id = v_person_one AND canonical_person_id = v_canonical_one FROM public.cctv_entity_observations WHERE id = v_observation_two)
  );

  PERFORM pg_temp.as_service();
  PERFORM public.record_cctv_entity_observations(v_job_four, v_evidence_four, v_org, jsonb_build_array(
    jsonb_build_object(
      'source_event_id', 'person-four',
      'entity_kind', 'person',
      'observed_at', '2026-09-16T10:15:00Z',
      'candidate_embedding', pg_temp.emb(128, 110, 0.02),
      'appearance_embedding', pg_temp.emb(256, 140, 0.02),
      'model_confidence', 0.84
    )
  ));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.cctv_entity_observations WHERE inference_job_id = v_job_four;
  v_observation_four := v_row.id;
  v_person_four := v_row.person_record_id;
  PERFORM pg_temp.check('unknown numbering remains monotonic after a human renames an earlier profile',
    (SELECT display_name = 'Unknown Person #3' AND metadata->>'cctv_unknown_person_number' = '3' FROM public.person_records WHERE id = v_person_four)
  );

  PERFORM pg_temp.as_service();
  v_result := public.complete_motion_inference(
    v_job_one,
    v_evidence_one,
    v_org,
    jsonb_build_object(
      'motion_segments', jsonb_build_array(),
      'consolidated_events', jsonb_build_object('face_events', jsonb_build_array(
        jsonb_build_object('event_id', 'face-one', 'subject_id', 'subject-one', 'face_embedding', pg_temp.emb(128, 3, 0.02))
      ))
    )
  );
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('completion attaches face evidence to the inferred profile without a duplicate person',
    v_result IS NOT NULL
    AND (SELECT count(*) FROM public.person_records WHERE organization_id = v_org) = 3
    AND EXISTS (SELECT 1 FROM public.face_observations WHERE evidence_item_id = v_evidence_one AND person_record_id = v_person_one AND metadata->>'source_event_id' = 'face-one')
  );
END $$;

ROLLBACK;
