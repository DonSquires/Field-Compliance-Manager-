-- Behavioural truth table for 20260918120000_cctv_evidence_custody_guard.sql.
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
  v_loose uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_hash text := repeat('ab', 32);
  v_other_hash text := repeat('cd', 32);
  v_row public.evidence_items%rowtype;
  v_result jsonb;
  v_custody jsonb;
  v_error text;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'T_CUSTODY_ORG', 'service_provider'), (v_other_org, 'T_CUSTODY_OTHER', 'client');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'CustodyAdmin'), (v_officer, v_org, 'officer', 'CustodyOfficer'), (v_stranger, v_other_org, 'admin', 'CustodyStranger');
  INSERT INTO public.locations (organization_id, name, address) VALUES (v_org, 'T Custody House', '12 Custody Lane') RETURNING id INTO v_house;
  INSERT INTO public.cctv_imports (organization_id, location_id, canonical_place_id, camera_label, camera_key, status)
  SELECT v_org, id, canonical_place_id, 'Custody camera', 't-custody-camera', 'registered' FROM public.locations WHERE id = v_house
  RETURNING id INTO v_import;
  INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id, metadata)
  VALUES (v_evidence, v_org, 'cctv_review', 'video', 'org/t/custody-one.mp4', v_import, '{"file_name":"custody-one.mp4"}'::jsonb),
         (v_loose, v_org, 'cctv_review', 'video', 'org/t/custody-loose.mp4', v_import, '{}'::jsonb);
  INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain, status)
  VALUES (v_job, v_org, v_evidence, 'video_motion', 'complete');

  -- ── unsealed rows stay workable ──
  PERFORM pg_temp.as_admin();
  UPDATE public.evidence_items SET storage_path = 'org/t/custody-one-moved.mp4' WHERE id = v_evidence;
  UPDATE public.evidence_items SET storage_path = 'org/t/custody-one.mp4' WHERE id = v_evidence;
  PERFORM pg_temp.check('an unsealed recording can still be corrected', (SELECT storage_path FROM public.evidence_items WHERE id = v_evidence) = 'org/t/custody-one.mp4');

  BEGIN
    UPDATE public.evidence_items SET locked_at = clock_timestamp() WHERE id = v_loose;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('a direct lock without an integrity hash is refused by the database itself', v_error LIKE '%cannot be sealed without an integrity hash%');

  -- ── hash provenance: write-once, repeat-tolerant, never silently divergent ──
  PERFORM pg_temp.as_service();
  PERFORM pg_temp.check('first measurement records the hash', public.record_cctv_source_hash(v_evidence, upper(v_hash), 26547788));
  PERFORM pg_temp.check('repeating the same hash is accepted (idempotent worker re-run)', public.record_cctv_source_hash(v_evidence, v_hash, 26547788));
  PERFORM pg_temp.check('a different hash for the same recording is refused rather than recorded', NOT public.record_cctv_source_hash(v_evidence, v_other_hash, 1));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.evidence_items WHERE id = v_evidence;
  PERFORM pg_temp.check('column and provenance agree after the refused rewrite',
    v_row.sha256_hash = v_hash AND v_row.metadata->>'source_sha256' = v_hash AND (v_row.metadata->>'source_size_bytes')::bigint = 26547788);

  BEGIN
    UPDATE public.evidence_items SET sha256_hash = v_other_hash WHERE id = v_evidence;
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.check('even a privileged direct write cannot replace a recorded hash', v_error LIKE '%already carries integrity hash%');

  -- ── playback copy merges instead of replacing ──
  PERFORM pg_temp.as_service();
  PERFORM pg_temp.check('service records the playback copy', public.set_cctv_playback_copy(v_evidence, jsonb_build_object('playback_storage_path', 'org/t/custody-one.playback.mp4', 'playback_transcode_profile', 'remux_copy', 'source_sha256', v_other_hash, 'sha256_hash', v_other_hash)));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.evidence_items WHERE id = v_evidence;
  PERFORM pg_temp.check('playback keys land, provenance survives, smuggled provenance keys are dropped',
    v_row.metadata->>'playback_storage_path' = 'org/t/custody-one.playback.mp4' AND v_row.metadata->>'source_sha256' = v_hash
    AND v_row.metadata->>'file_name' = 'custody-one.mp4' AND v_row.metadata ? 'playback_prepared_at' AND NOT (v_row.metadata ? 'sha256_hash'));
  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.set_cctv_playback_copy(v_evidence, '{"playback_storage_path":"x"}'::jsonb);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('only the service identity records playback copies', v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');

  -- ── integrity verification ──
  PERFORM pg_temp.as_service();
  v_result := public.record_cctv_integrity_check(v_evidence, upper(v_hash), 26547788, 'truth_table');
  PERFORM pg_temp.check('matching bytes verify against the recorded hash', v_result->>'state' = 'verified');
  v_result := public.record_cctv_integrity_check(v_loose, v_hash, 10, 'truth_table');
  PERFORM pg_temp.check('a recording with no recorded hash is reported unanchored, not verified', v_result->>'state' = 'unanchored');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('verification is audited against the recording',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_evidence_integrity_verified' AND a.target_id = v_evidence AND a.organization_id = v_org AND a.metadata->>'checked_by' = 'truth_table'));
  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.record_cctv_integrity_check(v_evidence, v_hash, 1, 'browser');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a browser session cannot assert integrity', v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');

  -- ── seal, then prove the seal holds against every path ──
  PERFORM pg_temp.as_user(v_admin);
  v_result := public.lock_cctv_evidence(v_evidence, 'Police request, case 2026/456');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the administrator seals the recording', (SELECT locked_at FROM public.evidence_items WHERE id = v_evidence) IS NOT NULL);

  BEGIN DELETE FROM public.evidence_items WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('sealed evidence cannot be deleted, even by a privileged session', v_error LIKE '%sealed%cannot be deleted%');

  BEGIN UPDATE public.evidence_items SET locked_at = NULL WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('the seal cannot be cleared', v_error LIKE '%locked_at may not be cleared%');

  BEGIN UPDATE public.evidence_items SET storage_path = 'org/t/swapped.mp4' WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('the stored object reference cannot be swapped under a seal', v_error LIKE '%frozen%');

  BEGIN UPDATE public.evidence_items SET captured_at = captured_at - interval '1 day' WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('the capture time cannot be moved under a seal', v_error LIKE '%frozen%');

  BEGIN UPDATE public.evidence_items SET organization_id = v_other_org WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('sealed evidence cannot change custodian organisation', v_error LIKE '%frozen%');

  BEGIN UPDATE public.evidence_items SET is_court_ready = false WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('court-ready status cannot be withdrawn', v_error LIKE '%court-ready status cannot be withdrawn%');

  BEGIN UPDATE public.evidence_items SET retention_hold = false WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('the retention hold cannot be released while the lock stands', v_error LIKE '%retention hold cannot be released%');

  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.custodian_classify_evidence(v_evidence, 'observation_30_day', 'Trying to age it out');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the retention classifier cannot age out sealed evidence', v_error LIKE '%retention hold cannot be released%');

  BEGIN UPDATE public.evidence_items SET metadata = metadata || jsonb_build_object('source_sha256', v_other_hash) WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('provenance metadata is frozen under a seal', v_error LIKE '%provenance metadata "source_sha256" is frozen%');

  BEGIN UPDATE public.evidence_items SET metadata = metadata - 'evidence_lock' WHERE id = v_evidence; v_error := NULL; EXCEPTION WHEN OTHERS THEN v_error := SQLERRM; END;
  PERFORM pg_temp.check('the lock record inside metadata cannot be removed', v_error LIKE '%provenance metadata "evidence_lock" is frozen%');

  UPDATE public.evidence_items SET metadata = metadata || '{"reviewer_note":"still workable"}'::jsonb WHERE id = v_evidence;
  PERFORM pg_temp.check('non-custody metadata remains editable on sealed evidence', (SELECT metadata->>'reviewer_note' FROM public.evidence_items WHERE id = v_evidence) = 'still workable');

  PERFORM pg_temp.as_service();
  PERFORM pg_temp.check('the worker may still record a playback copy for sealed evidence', public.set_cctv_playback_copy(v_evidence, '{"playback_storage_path":"org/t/custody-one.playback2.mp4"}'::jsonb));
  v_result := public.record_cctv_integrity_check(v_evidence, v_other_hash, 26547788, 'truth_table');
  PERFORM pg_temp.check('a later measurement that differs is recorded as a mismatch, and the sealed hash is untouched',
    v_result->>'state' = 'mismatch' AND (SELECT sha256_hash FROM public.evidence_items WHERE id = v_evidence) = v_hash);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the mismatch is audited with both hashes',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_evidence_integrity_mismatch' AND a.target_id = v_evidence AND a.metadata->>'observed_sha256' = v_other_hash AND a.metadata->>'expected_sha256' = v_hash));
  SELECT * INTO v_row FROM public.evidence_items WHERE id = v_evidence;
  PERFORM pg_temp.check('the integrity record keeps its history', (v_row.metadata->'integrity'->>'state') = 'mismatch' AND (v_row.metadata->'integrity'->>'check_count')::int = 2 AND (v_row.metadata->'integrity'->>'mismatch_count')::int = 1 AND v_row.metadata->'integrity' ? 'first_verified_at');

  -- ── custody record ──
  PERFORM pg_temp.as_user(v_officer);
  v_custody := public.cctv_evidence_custody(v_evidence);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an officer of the custodian organisation can read the custody record',
    v_custody->>'sha256_hash' = v_hash AND (v_custody->>'locked_at') IS NOT NULL AND v_custody->'lock'->>'reason' = 'Police request, case 2026/456'
    AND v_custody->'integrity'->>'state' = 'mismatch' AND (v_custody->>'retention_hold')::boolean);
  PERFORM pg_temp.check('the trail lists the lock, both integrity checks, in time order',
    (SELECT array_agg(e->>'kind' ORDER BY (e->>'at')::timestamptz) FROM jsonb_array_elements(v_custody->'events') e) = ARRAY['cctv_evidence_integrity_verified', 'cctv_evidence_locked', 'cctv_evidence_integrity_mismatch']);
  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.cctv_evidence_custody(v_evidence);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a user outside the custodian organisation cannot read the custody record', v_error LIKE '%access denied%');

  -- ── governed test purge still works ──
  DELETE FROM public.inference_jobs WHERE id = v_job;
  PERFORM set_config('app.evidence_delete_scope', 'test_dataset_purge', true);
  DELETE FROM public.evidence_items WHERE id = v_evidence;
  PERFORM set_config('app.evidence_delete_scope', '', true);
  PERFORM pg_temp.check('a declared test-dataset purge may remove sealed test evidence', NOT EXISTS (SELECT 1 FROM public.evidence_items WHERE id = v_evidence));
END $$;
ROLLBACK;
