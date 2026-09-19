-- Behavioural truth table for 20260918150000_cctv_report_provenance.sql.
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
  v_result uuid := gen_random_uuid();
  v_hash text := repeat('ab', 32);
  v_first record;
  v_second record;
  v_verify jsonb;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'T_PROV_ORG', 'service_provider'), (v_other_org, 'T_PROV_OTHER', 'client');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'ProvAdmin'), (v_officer, v_org, 'officer', 'ProvOfficer'), (v_stranger, v_other_org, 'admin', 'ProvStranger');
  INSERT INTO public.locations (organization_id, name, address) VALUES (v_org, 'T Provenance House', '4 Receipt Road') RETURNING id INTO v_house;
  INSERT INTO public.cctv_imports (organization_id, location_id, canonical_place_id, camera_label, camera_key, status, source_device_kind, source_timezone)
  SELECT v_org, id, canonical_place_id, 'Gate camera', 't-prov-gate', 'registered', 'tapo', 'Pacific/Auckland' FROM public.locations WHERE id = v_house
  RETURNING id INTO v_import;
  INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id, sha256_hash, metadata)
  VALUES (v_evidence, v_org, 'cctv_review', 'video', 'org/t/prov.mp4', v_import, v_hash,
          jsonb_build_object('source_sha256', v_hash, 'source_size_bytes', 1234, 'integrity', jsonb_build_object('state', 'verified', 'checked_at', '2026-09-18T01:00:00Z')));
  INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain, status, completed_at, attempt_count)
  VALUES (v_job, v_org, v_evidence, 'video_motion', 'complete', '2026-09-18T02:00:00Z', 1);
  INSERT INTO public.inference_results (id, inference_job_id, evidence_item_id, domain, status, result)
  VALUES (v_result, v_job, v_evidence, 'video_motion', 'complete', jsonb_build_object('classification_plan', jsonb_build_object('policy', 'detector_triage_then_one_full_recognition_per_unique_observation', 'sampled_frames', 120, 'representative_frames', 3)));
  INSERT INTO public.cctv_entity_observations (organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, cctv_import_id, review_state)
  VALUES (v_org, v_job, v_evidence, 'person-1', 'person', '2026-09-18T01:10:00Z', v_import, 'accepted'),
         (v_org, v_job, v_evidence, 'vehicle-1', 'vehicle', '2026-09-18T01:11:00Z', v_import, 'unreviewed');

  -- ── issue: the server enriches and hashes ──
  PERFORM pg_temp.as_user(v_officer);
  SELECT * INTO v_first FROM public.issue_cctv_report_receipt(v_job, v_evidence, v_org, NULL, jsonb_build_object('schema_version', 1, 'report_status', 'review_ready', 'observations', jsonb_build_array(jsonb_build_object('kind', 'person'))));
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a receipt is issued with the provenance the database knows',
    v_first.report_id IS NOT NULL AND v_first.observation_count = 1 AND v_first.sha256 ~ '^[0-9a-f]{64}$'
    AND v_first.provenance->'evidence'->>'sha256_hash' = v_hash
    AND v_first.provenance->'evidence'->>'integrity_state' = 'verified'
    AND v_first.provenance->'import'->>'camera_label' = 'Gate camera'
    AND v_first.provenance->'import'->>'place_name' = 'T Provenance House'
    AND v_first.provenance->'result'->'classification_plan'->>'policy' = 'detector_triage_then_one_full_recognition_per_unique_observation'
    AND (v_first.provenance->'review'->>'observations_total')::int = 2
    AND (v_first.provenance->'review'->>'unreviewed')::int = 1
    AND (v_first.provenance->>'issued_by')::uuid = v_officer);
  PERFORM pg_temp.check('a review_ready claim over undecided sightings is recorded as inconsistent, not silently accepted',
    v_first.provenance->>'review_consistency' = 'client_claims_review_ready_but_database_holds_undecided_sightings');
  PERFORM pg_temp.check('the stored payload carries the provenance and hashes to the returned sha256',
    (SELECT payload->'provenance'->>'receipt_id' = v_first.report_id::text AND sha256 = encode(digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex')
       FROM public.cctv_report_receipts WHERE id = v_first.report_id));
  PERFORM pg_temp.check('the issue is audited with the evidence hash and the consistency verdict',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_report_receipt_issued' AND a.target_id = v_first.report_id
              AND a.metadata->>'evidence_sha256' = v_hash AND a.metadata->>'review_consistency' LIKE 'client_claims%'));
  PERFORM pg_temp.check('a first receipt supersedes nothing', NOT (v_first.provenance ? 'supersedes'));

  -- ── review completes, second receipt supersedes the first ──
  UPDATE public.cctv_entity_observations SET review_state = 'rejected' WHERE evidence_item_id = v_evidence AND source_event_id = 'vehicle-1';
  PERFORM pg_temp.as_user(v_officer);
  SELECT * INTO v_second FROM public.issue_cctv_report_receipt(v_job, v_evidence, v_org, 'batch-7', jsonb_build_object('schema_version', 1, 'report_status', 'review_ready', 'observations', '[]'::jsonb));
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('once every sighting is decided the claim is consistent',
    v_second.provenance->>'review_consistency' = 'consistent' AND (v_second.provenance->'review'->>'rejected')::int = 1);
  PERFORM pg_temp.check('the second receipt names the one it supersedes',
    (v_second.provenance->'supersedes'->>'receipt_id')::uuid = v_first.report_id AND (v_second.provenance->'supersedes'->>'earlier_receipts')::int = 1);
  PERFORM pg_temp.check('the batch id is kept', (SELECT batch_id FROM public.cctv_report_receipts WHERE id = v_second.report_id) = 'batch-7');

  -- ── verification ──
  PERFORM pg_temp.as_user(v_officer);
  v_verify := public.verify_cctv_report_receipt(v_first.report_id, upper(v_first.sha256));
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a presented hash verifies against the stored receipt',
    (v_verify->>'found')::boolean AND (v_verify->>'receipt_intact')::boolean AND (v_verify->>'presented_matches')::boolean
    AND v_verify->>'evidence_sha256_at_issue' = v_hash AND v_verify->>'evidence_sha256_now' = v_hash AND v_verify->>'evidence_integrity_now' = 'verified');
  PERFORM pg_temp.check('verification names the later receipt that supersedes this one', (v_verify->>'superseded_by')::uuid = v_second.report_id);
  PERFORM pg_temp.as_user(v_officer);
  v_verify := public.verify_cctv_report_receipt(v_first.report_id, repeat('00', 32));
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a wrong presented hash is reported as not matching while the receipt itself is intact',
    (v_verify->>'receipt_intact')::boolean AND NOT (v_verify->>'presented_matches')::boolean);
  PERFORM pg_temp.as_user(v_officer);
  v_verify := public.verify_cctv_report_receipt(gen_random_uuid(), NULL);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an unknown receipt id is reported as not found, not as an error', NOT (v_verify->>'found')::boolean);
  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.verify_cctv_report_receipt(v_first.report_id, NULL);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('another organisation cannot verify or read the receipt', v_error LIKE '%access denied%');

  -- ── receipts are records ──
  BEGIN UPDATE public.cctv_report_receipts SET observation_count = 99 WHERE id = v_first.report_id; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('a receipt cannot be edited, even by a privileged session', v_error LIKE '%cannot be updated%');
  BEGIN DELETE FROM public.cctv_report_receipts WHERE id = v_first.report_id; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('a receipt cannot be deleted', v_error LIKE '%cannot be deleted%');
  PERFORM set_config('app.evidence_delete_scope', 'test_dataset_purge', true);
  DELETE FROM public.cctv_report_receipts WHERE evidence_item_id = v_evidence;
  PERFORM set_config('app.evidence_delete_scope', '', true);
  PERFORM pg_temp.check('a declared test-dataset purge may remove test receipts', NOT EXISTS (SELECT 1 FROM public.cctv_report_receipts WHERE evidence_item_id = v_evidence));

  -- ── scope ──
  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.issue_cctv_report_receipt(v_job, v_evidence, v_org, NULL, '{"observations":[]}'::jsonb);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a user outside the organisation cannot issue a receipt', v_error LIKE '%access denied%');
END $$;
ROLLBACK;
