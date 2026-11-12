CREATE OR REPLACE FUNCTION public.builder_autopilot_begin_bb163_correction(_job_id uuid, _blockers text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_job public.builder_jobs%rowtype;
  v_test public.builder_job_steps%rowtype;
  v_round integer;
  v_round_text text;
  v_history jsonb;
  v_event uuid := gen_random_uuid();
  v_matching_jobs integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF _blockers IS NULL OR char_length(btrim(_blockers)) = 0 OR char_length(_blockers) > 4000
     OR _blockers NOT LIKE 'Whole-job acceptance incomplete:%' THEN
    RAISE EXCEPTION 'A whole-job acceptance blocker is required';
  END IF;

  SELECT * INTO v_job
  FROM public.builder_jobs
  WHERE id = _job_id
  FOR UPDATE;

  IF v_job.id IS NULL OR v_job.human_reference IS DISTINCT FROM 'BB-163'
     OR v_job.autopilot_source IS DISTINCT FROM 'routine_monitor'
     OR v_job.repair_risk IS DISTINCT FROM 'routine' THEN
    RAISE EXCEPTION 'BB-163 routine repair required';
  END IF;

  SELECT count(*) INTO v_matching_jobs
  FROM public.builder_jobs
  WHERE human_reference = 'BB-163'
    AND autopilot_source = 'routine_monitor'
    AND repair_risk = 'routine'
    AND status NOT IN ('failed', 'cancelled', 'deployed');
  IF v_matching_jobs <> 1 THEN
    RAISE EXCEPTION 'A unique routine BB-163 job is required';
  END IF;

  IF v_job.status IS DISTINCT FROM 'security_review'
     OR v_job.autopilot_state IS DISTINCT FROM 'blocked'
     OR v_job.workspace_published_at IS NOT NULL
     OR v_job.workspace_published_head_sha IS NOT NULL
     OR v_job.workspace_pull_request_url IS NOT NULL THEN
    RAISE EXCEPTION 'An unpublished BB-163 job at the acceptance gate is required';
  END IF;

  IF v_job.autopilot_report->>'state' IS DISTINCT FROM 'blocked'
     OR coalesce(v_job.autopilot_report->>'reason', v_job.autopilot_report->>'text', '')
          NOT ILIKE '%Whole-job acceptance incomplete%'
     OR _blockers NOT LIKE 'Whole-job acceptance incomplete:%' THEN
    RAISE EXCEPTION 'The recorded whole-job acceptance blocker is required';
  END IF;

  SELECT * INTO v_test
  FROM public.builder_job_steps
  WHERE job_id = _job_id AND step_id = 'test_suite';
  IF v_test.id IS NULL OR v_test.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'The test-suite verification step is not complete';
  END IF;

  IF (SELECT count(*) FROM public.builder_job_steps
      WHERE job_id = _job_id
        AND step_id IN ('product_analysis', 'ui_design', 'frontend_implementation',
          'backend_implementation', 'test_suite', 'security_review', 'code_review', 'release_prep')) <> 8
     OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id AND status = 'running')
     OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'product_analysis' AND status = 'completed')
     OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'ui_design' AND status IN ('completed', 'skipped'))
     OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id
       AND step_id IN ('frontend_implementation', 'backend_implementation') AND status NOT IN ('completed', 'skipped'))
     OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id
       AND step_id IN ('frontend_implementation', 'backend_implementation') AND status = 'completed')
     OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'security_review' AND status = 'completed')
     OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'code_review' AND status IN ('pending', 'blocked'))
     OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'release_prep' AND status = 'pending')
     OR EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = _job_id AND status IN ('pending', 'running'))
     OR EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = _job_id AND status IN ('pending', 'running'))
     OR EXISTS (SELECT 1 FROM public.builder_approvals WHERE job_id = _job_id AND status = 'pending') THEN
    RAISE EXCEPTION 'The BB-163 acceptance gap is not idle and ready for correction';
  END IF;

  v_round_text := v_job.autopilot_report->>'bb163_auto_correction_rounds';
  IF v_round_text IS NOT NULL AND v_round_text !~ '^[0-3]$' THEN
    RAISE EXCEPTION 'Invalid BB-163 correction round state';
  END IF;
  v_round := coalesce(v_round_text::integer, 0);
  v_history := coalesce(v_job.autopilot_report->'bb163_auto_correction_history', '[]'::jsonb);
  IF jsonb_typeof(v_history) IS DISTINCT FROM 'array' OR jsonb_array_length(v_history) <> v_round THEN
    RAISE EXCEPTION 'BB-163 correction history is inconsistent';
  END IF;

  IF v_round >= 3 THEN
    UPDATE public.builder_jobs
    SET autopilot_state = 'blocked',
        autopilot_report = coalesce(autopilot_report, '{}'::jsonb) || jsonb_build_object(
          'state', 'parked',
          'bb163_auto_correction_parked', true,
          'bb163_auto_correction_last_blocker', _blockers,
          'text', 'Parked for Don after three unsuccessful same-job correction rounds. Latest acceptance blocker: ' || _blockers
        ),
        autopilot_updated_at = now(),
        autopilot_reported_at = NULL,
        updated_at = now()
    WHERE id = _job_id
    RETURNING * INTO v_job;

    INSERT INTO public.builder_audit_events (
      organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary
    ) VALUES (
      v_job.organization_id, v_job.id, 'job_status_changed', 'bot',
      jsonb_build_object('autopilot_state', 'blocked', 'correction_rounds', v_round),
      jsonb_build_object('autopilot_state', 'blocked', 'parked', true, 'correction_rounds', v_round, 'blocker', _blockers),
      'BB-163 parked for Don after three unsuccessful correction rounds'
    );
    RETURN jsonb_build_object('outcome', 'parked', 'round', v_round);
  END IF;

  v_round := v_round + 1;
  v_history := v_history || jsonb_build_array(jsonb_build_object(
    'round', v_round,
    'blocker', _blockers,
    'test_summary', v_test.result_summary,
    'attempt_counts', (SELECT jsonb_object_agg(step_id, attempt_count)
      FROM public.builder_job_steps
      WHERE job_id = _job_id AND step_id IN ('frontend_implementation', 'backend_implementation')),
    'recorded_at', now()
  ));

  UPDATE public.builder_artifacts
  SET status = 'superseded'
  WHERE job_id = _job_id
    AND status = 'final'
    AND step_id IN (SELECT id FROM public.builder_job_steps WHERE job_id = _job_id
      AND step_id IN ('frontend_implementation', 'backend_implementation', 'test_suite', 'security_review', 'code_review', 'release_prep'));

  UPDATE public.builder_job_steps
  SET status = 'pending',
      started_at = NULL,
      completed_at = NULL,
      result_summary = NULL,
      evidence_refs = '[]'::jsonb,
      artifact_ids = NULL,
      error = NULL,
      retryable = false,
      blocked_reason = NULL,
      blocked_dependencies = NULL,
      updated_at = now()
  WHERE job_id = _job_id
    AND step_id IN ('frontend_implementation', 'backend_implementation', 'test_suite', 'security_review', 'code_review')
    AND status <> 'skipped';

  UPDATE public.builder_jobs
  SET status = 'implementation_pending',
      autopilot_state = 'driving',
      autopilot_report = coalesce(autopilot_report, '{}'::jsonb) || jsonb_build_object(
        'state', 'correcting',
        'bb163_auto_correction_rounds', v_round,
        'bb163_auto_correction_history', v_history,
        'bb163_auto_correction_parked', false,
        'text', 'Bob is correcting the recorded whole-job acceptance blocker on the same job. Correction round ' || v_round || ' of 3.'
      ),
      autopilot_updated_at = now(),
      autopilot_reported_at = NULL,
      current_step_name = NULL,
      current_step_index = 2,
      last_error = NULL,
      updated_at = now()
  WHERE id = _job_id
  RETURNING * INTO v_job;

  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary
  ) VALUES (
    v_job.organization_id, v_job.id, 'job_status_changed', 'bot',
    jsonb_build_object('status', 'security_review', 'autopilot_state', 'blocked', 'correction_rounds', v_round - 1),
    jsonb_build_object('status', 'implementation_pending', 'autopilot_state', 'driving',
      'correction_round', v_round, 'blocker', _blockers, 'history', v_history),
    'Bob began bounded same-job correction round ' || v_round || ' of 3 for BB-163'
  );
  RETURN jsonb_build_object('outcome', 'correcting', 'round', v_round);
END;
$function$;
REVOKE ALL ON FUNCTION public.builder_autopilot_begin_bb163_correction(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_begin_bb163_correction(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_autopilot_record(_job_id uuid, _state text, _report jsonb DEFAULT NULL)
RETURNS builder_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _state NOT IN ('driving', 'awaiting_human', 'published', 'blocked', 'done') THEN RAISE EXCEPTION 'Unsupported autopilot state'; END IF;
  UPDATE public.builder_jobs
  SET autopilot_state = _state,
      autopilot_report = CASE
        WHEN _report IS NULL THEN autopilot_report
        WHEN jsonb_typeof(_report) IS DISTINCT FROM 'object' THEN _report
        ELSE _report || jsonb_strip_nulls(jsonb_build_object(
          'bb163_auto_correction_rounds', autopilot_report->'bb163_auto_correction_rounds',
          'bb163_auto_correction_history', autopilot_report->'bb163_auto_correction_history',
          'bb163_auto_correction_parked', autopilot_report->'bb163_auto_correction_parked'
        ))
      END,
      autopilot_reported_at = CASE WHEN _report IS NOT NULL THEN NULL ELSE autopilot_reported_at END,
      autopilot_updated_at = now(),
      updated_at = now()
  WHERE id = _job_id
    AND (autopilot_requested_by IS NOT NULL OR autopilot_source IN ('main_monitor', 'routine_monitor'))
  RETURNING * INTO _job;
  IF _job.id IS NULL THEN RAISE EXCEPTION 'Builder job is not under Bob autopilot'; END IF;
  IF _state = 'awaiting_human' THEN
    INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary)
    VALUES (_job.organization_id, _job.id, 'approval_requested', 'bot',
      jsonb_build_object('autopilot_state', _state, 'gate', _report->>'gate', 'evidential_files', COALESCE(_report->'evidential_files', '[]'::jsonb)),
      'Bob autopilot paused for a human decision');
  END IF;
  RETURN _job;
END;
$function$;
REVOKE ALL ON FUNCTION public.builder_autopilot_record(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_autopilot_record(uuid, text, jsonb) TO postgres, service_role;
