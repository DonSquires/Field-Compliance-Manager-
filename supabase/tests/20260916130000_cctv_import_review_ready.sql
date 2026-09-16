-- Behavioural truth table for 20260916130000_cctv_import_review_ready.sql.
-- Runs in a transaction and rolls back.
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
  v_user uuid := gen_random_uuid();
  v_house uuid;
  v_import public.cctv_imports%rowtype;
  v_archived_import public.cctv_imports%rowtype;
  v_reg_first jsonb;
  v_reg_second jsonb;
  v_reg_archived jsonb;
  v_first_job uuid;
  v_second_job uuid;
  v_archived_job uuid;
  v_first_evidence uuid;
  v_second_evidence uuid;
  v_archived_evidence uuid;
  v_result uuid;
BEGIN
  INSERT INTO public.organizations (id, name, organization_type)
  VALUES (v_org, 'T_CCTV_IMPORT_LIFECYCLE', 'service_provider');
  INSERT INTO public.user_profiles (id, organization_id, role, display_name)
  VALUES (v_user, v_org, 'admin', 'CctvLifecycleAdmin');
  INSERT INTO public.locations (organization_id, name, address)
  VALUES (v_org, 'T CCTV Import House', '130 Review Ready Road')
  RETURNING id INTO v_house;

  PERFORM pg_temp.as_user(v_user);
  v_import := public.create_cctv_import(v_org, v_house, 'Lifecycle camera', p_source_device_kind => 'tapo');
  v_reg_first := public.register_cctv_import_video(
    v_import.id,
    'org/' || v_org::text || '/cctv/' || v_import.id::text || '/first.mp4',
    'first.mp4', 100, NULL, '2026-09-16T10:00:00Z', '2026-09-16T10:01:00Z', 'first.mp4'
  );
  v_reg_second := public.register_cctv_import_video(
    v_import.id,
    'org/' || v_org::text || '/cctv/' || v_import.id::text || '/second.mp4',
    'second.mp4', 100, NULL, '2026-09-16T10:01:00Z', '2026-09-16T10:02:00Z', 'second.mp4'
  );
  v_first_job := (v_reg_first->>'inference_job_id')::uuid;
  v_second_job := (v_reg_second->>'inference_job_id')::uuid;
  v_first_evidence := (v_reg_first->>'evidence_item_id')::uuid;
  v_second_evidence := (v_reg_second->>'evidence_item_id')::uuid;
  PERFORM pg_temp.check('two registered clips leave the import registered', (SELECT status = 'registered' FROM public.cctv_imports WHERE id = v_import.id));

  PERFORM pg_temp.as_service();
  PERFORM public.claim_cctv_inference_job(v_first_job, gen_random_uuid(), 900);
  v_result := public.complete_motion_inference(v_first_job, v_first_evidence, v_org, '{"motion_segments": []}'::jsonb);
  PERFORM pg_temp.check('first completed clip stores a result', v_result IS NOT NULL AND (SELECT status = 'complete' FROM public.inference_jobs WHERE id = v_first_job));
  PERFORM pg_temp.check('first completed clip does not prematurely mark the multi-video import ready', (SELECT status = 'registered' FROM public.cctv_imports WHERE id = v_import.id));
  PERFORM pg_temp.check('no review-ready audit until every clip is terminal', NOT EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'cctv_import_review_ready' AND target_id = v_import.id));

  PERFORM public.claim_cctv_inference_job(v_second_job, gen_random_uuid(), 900);
  v_result := public.complete_motion_inference(v_second_job, v_second_evidence, v_org, '{"motion_segments": []}'::jsonb);
  PERFORM pg_temp.check('last completed clip marks the parent import review ready', (SELECT status = 'review_ready' FROM public.cctv_imports WHERE id = v_import.id));
  PERFORM pg_temp.check('review-ready audit records both terminal video jobs', EXISTS (
    SELECT 1 FROM public.audit_log
    WHERE action = 'cctv_import_review_ready'
      AND target_id = v_import.id
      AND (metadata->>'completed_video_jobs')::integer = 2
  ));

  PERFORM pg_temp.as_user(v_user);
  v_archived_import := public.create_cctv_import(v_org, v_house, 'Archived lifecycle camera', p_source_device_kind => 'tapo');
  v_reg_archived := public.register_cctv_import_video(
    v_archived_import.id,
    'org/' || v_org::text || '/cctv/' || v_archived_import.id::text || '/archived.mp4',
    'archived.mp4', 100, NULL, '2026-09-16T11:00:00Z', '2026-09-16T11:01:00Z', 'archived.mp4'
  );
  v_archived_job := (v_reg_archived->>'inference_job_id')::uuid;
  v_archived_evidence := (v_reg_archived->>'evidence_item_id')::uuid;
  PERFORM pg_temp.as_service();
  UPDATE public.cctv_imports SET status = 'archived' WHERE id = v_archived_import.id;
  PERFORM public.claim_cctv_inference_job(v_archived_job, gen_random_uuid(), 900);
  PERFORM public.complete_motion_inference(v_archived_job, v_archived_evidence, v_org, '{"motion_segments": []}'::jsonb);
  PERFORM pg_temp.check('a late completion never reopens an archived import', (SELECT status = 'archived' FROM public.cctv_imports WHERE id = v_archived_import.id));
  PERFORM pg_temp.check('archived import has no review-ready audit', NOT EXISTS (SELECT 1 FROM public.audit_log WHERE action = 'cctv_import_review_ready' AND target_id = v_archived_import.id));

  PERFORM pg_temp.as_admin();
END $$;

ROLLBACK;
