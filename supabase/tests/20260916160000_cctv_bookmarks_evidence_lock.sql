-- Behavioural truth table for 20260916160000_cctv_bookmarks_evidence_lock.sql.
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
  v_unanchored uuid := gen_random_uuid();
  v_job uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_observation uuid;
  v_result jsonb;
  v_second jsonb;
  v_incident public.incidents%rowtype;
  v_row public.evidence_items%rowtype;
  v_error text;
  v_hash text := repeat('ab', 32);
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'T_CCTV_LOCK_ORG', 'service_provider'), (v_other_org, 'T_CCTV_LOCK_OTHER', 'client');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_admin, v_org, 'admin', 'LockAdmin'), (v_officer, v_org, 'officer', 'LockOfficer'), (v_stranger, v_other_org, 'admin', 'LockStranger');
  INSERT INTO public.locations (organization_id, name, address)
  VALUES (v_org, 'T CCTV Lock House', '160 Lock Road')
  RETURNING id INTO v_house;
  INSERT INTO public.cctv_imports (organization_id, location_id, canonical_place_id, camera_label, camera_key, status)
  SELECT v_org, id, canonical_place_id, 'Lock camera', 't-lock-camera', 'registered'
  FROM public.locations WHERE id = v_house
  RETURNING id INTO v_import;
  INSERT INTO public.evidence_items (id, organization_id, module_key, evidence_kind, storage_path, cctv_import_id)
  VALUES (v_evidence, v_org, 'cctv_review', 'video', 'org/t/lock-one.mp4', v_import),
         (v_unanchored, v_org, 'cctv_review', 'video', 'desktop/t/legacy.mp4', NULL);
  INSERT INTO public.inference_jobs (id, organization_id, evidence_item_id, domain, status)
  VALUES (v_job, v_org, v_evidence, 'video_motion', 'processing');
  INSERT INTO public.cctv_entity_observations (organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, cctv_import_id)
  VALUES (v_org, v_job, v_evidence, 'vehicle-1', 'vehicle', '2026-09-16T10:00:00Z', v_import)
  RETURNING id INTO v_observation;

  -- ── bookmarks ──
  PERFORM pg_temp.as_user(v_officer);
  v_result := public.create_cctv_bookmark(v_evidence, '2026-09-16T10:00:05Z', 'White ute stops at gate', 'Driver looks at camera', NULL, 'high', v_observation, v_request);
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_incident FROM public.incidents WHERE id = (v_result->>'incident_id')::uuid;
  PERFORM pg_temp.check('bookmark becomes an incident anchored to the import place',
    v_incident.id IS NOT NULL AND v_incident.incident_type = 'cctv_bookmark' AND v_incident.severity = 'high' AND v_incident.status = 'open'
    AND v_incident.location_id = v_house AND v_incident.organization_id = v_org AND v_incident.officer_user_id = v_officer
    AND v_incident.occurred_at = '2026-09-16T10:00:05Z'::timestamptz AND v_incident.description LIKE 'White ute stops at gate%Driver looks at camera'
  );
  PERFORM pg_temp.check('bookmark attaches the recording under an allowed attachment kind',
    EXISTS (SELECT 1 FROM public.incident_attachments a WHERE a.incident_id = v_incident.id AND a.evidence_item_id = v_evidence AND a.attachment_kind = 'video')
  );
  PERFORM pg_temp.check('bookmark is audited with its evidence, observation and request id',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_bookmark_created' AND a.target_id = v_incident.id
              AND (a.metadata->>'evidence_item_id')::uuid = v_evidence AND (a.metadata->>'observation_id')::uuid = v_observation
              AND (a.metadata->>'client_request_id')::uuid = v_request)
  );
  PERFORM pg_temp.as_user(v_officer);
  v_second := public.create_cctv_bookmark(v_evidence, '2026-09-16T10:00:05Z', 'White ute stops at gate', NULL, NULL, 'high', NULL, v_request);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a retried bookmark with the same request id is deduped, not doubled',
    (v_second->>'deduped')::boolean AND v_second->>'incident_id' = v_result->>'incident_id'
    AND (SELECT count(*) FROM public.incidents WHERE incident_type = 'cctv_bookmark' AND organization_id = v_org) = 1
  );

  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.create_cctv_bookmark(v_evidence, '2026-09-16T10:00:05Z', 'Stranger bookmark', NULL, NULL, 'standard', NULL, NULL);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a user outside the custodian organisation cannot bookmark the recording', v_error LIKE '%access denied%');

  BEGIN
    PERFORM pg_temp.as_user(v_officer);
    PERFORM public.create_cctv_bookmark(v_unanchored, '2026-09-16T10:00:05Z', 'Legacy upload', NULL, NULL, 'standard', NULL, NULL);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a recording with no place anchor is refused instead of violating the incident place constraint', v_error LIKE '%not anchored to a place%');

  BEGIN
    PERFORM pg_temp.as_user(v_officer);
    PERFORM public.create_cctv_bookmark(v_evidence, '2026-09-16T10:00:05Z', '   ', NULL, NULL, 'standard', NULL, NULL);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a bookmark needs a title', v_error LIKE '%title is required%');

  -- ── source hash ──
  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.record_cctv_source_hash(v_evidence, v_hash, 1024);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  -- EXECUTE is revoked from authenticated, so the grant refuses before the body's own guard can.
  PERFORM pg_temp.check('only the service identity can record a source hash', v_error LIKE '%Service identity required%' OR v_error LIKE '%permission denied%');

  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.lock_cctv_evidence(v_evidence, 'Police request, case 2026/123');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a lock is refused before the integrity hash exists', v_error LIKE '%no integrity hash yet%');

  PERFORM pg_temp.as_service();
  PERFORM pg_temp.check('service records the source hash and size', public.record_cctv_source_hash(v_evidence, upper(v_hash), 26547788));
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.evidence_items WHERE id = v_evidence;
  PERFORM pg_temp.check('source hash is stored lower-case with its provenance',
    v_row.sha256_hash = v_hash AND v_row.metadata->>'source_sha256' = v_hash AND (v_row.metadata->>'source_size_bytes')::bigint = 26547788 AND v_row.metadata ? 'source_hashed_at'
  );
  PERFORM pg_temp.as_service();
  PERFORM public.record_cctv_source_hash(v_evidence, repeat('cd', 32), 1);
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a second hash never overwrites the first', (SELECT sha256_hash FROM public.evidence_items WHERE id = v_evidence) = v_hash);

  BEGIN
    PERFORM pg_temp.as_service();
    PERFORM public.record_cctv_source_hash(v_evidence, 'not-a-hash', 1);
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a malformed hash is rejected', v_error LIKE '%64-character hex%');

  -- ── evidence lock ──
  BEGIN
    PERFORM pg_temp.as_user(v_officer);
    PERFORM public.lock_cctv_evidence(v_evidence, 'Officer tries to lock');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an officer cannot apply an evidence lock', v_error LIKE '%administrator%');

  BEGIN
    PERFORM pg_temp.as_user(v_stranger);
    PERFORM public.lock_cctv_evidence(v_evidence, 'Stranger admin tries to lock');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('an administrator of another organisation cannot lock the recording', v_error LIKE '%administrator%');

  BEGIN
    PERFORM pg_temp.as_user(v_admin);
    PERFORM public.lock_cctv_evidence(v_evidence, 'abc');
    v_error := NULL;
  EXCEPTION WHEN OTHERS THEN v_error := SQLERRM;
  END;
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('a lock needs a stated reason', v_error LIKE '%stated reason%');

  PERFORM pg_temp.as_user(v_admin);
  v_result := public.lock_cctv_evidence(v_evidence, 'Police request, case 2026/123');
  PERFORM pg_temp.as_admin();
  SELECT * INTO v_row FROM public.evidence_items WHERE id = v_evidence;
  PERFORM pg_temp.check('the custodian administrator seals the recording against retention',
    NOT (v_result->>'already_locked')::boolean AND v_row.locked_at IS NOT NULL AND v_row.is_court_ready AND v_row.retention_hold
    AND v_row.retention_reason = 'evidence_lock: Police request, case 2026/123'
    AND (v_row.metadata->'evidence_lock'->>'locked_by')::uuid = v_admin
  );
  PERFORM pg_temp.check('the lock is audited with the hash it sealed',
    EXISTS (SELECT 1 FROM public.audit_log a WHERE a.action = 'cctv_evidence_locked' AND a.target_id = v_evidence AND a.actor_user_id = v_admin AND a.metadata->>'sha256_hash' = v_hash)
  );
  PERFORM pg_temp.as_user(v_admin);
  v_second := public.lock_cctv_evidence(v_evidence, 'Second attempt, different reason');
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('locking twice reports already_locked and changes nothing',
    (v_second->>'already_locked')::boolean AND (SELECT retention_reason FROM public.evidence_items WHERE id = v_evidence) = 'evidence_lock: Police request, case 2026/123'
  );
  PERFORM pg_temp.as_service();
  PERFORM pg_temp.check('the service cannot touch the hash of a locked recording', NOT public.record_cctv_source_hash(v_evidence, repeat('ef', 32), 2));
  PERFORM pg_temp.as_admin();
  PERFORM pg_temp.check('the sealed hash survives the refused rewrite', (SELECT sha256_hash FROM public.evidence_items WHERE id = v_evidence) = v_hash);
END $$;
ROLLBACK;
