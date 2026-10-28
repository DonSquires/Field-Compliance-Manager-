CREATE OR REPLACE FUNCTION public.builder_retry_failed_frontend_patch(
  p_job_id uuid,
  p_step_id uuid,
  p_patch_artifact_id uuid,
  p_target_sha text,
  p_job_updated_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_job public.builder_jobs%rowtype;
  v_step public.builder_job_steps%rowtype;
  v_patch public.builder_artifacts%rowtype;
  v_run public.builder_worker_runs%rowtype;
  v_receipt uuid;
BEGIN
  IF p_job_id IS NULL OR p_step_id IS NULL OR p_patch_artifact_id IS NULL
    OR p_job_updated_at IS NULL OR p_target_sha IS NULL OR p_target_sha !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'A pinned failed patch handoff is required';
  END IF;

  SELECT * INTO v_job FROM public.builder_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.autopilot_requested_by IS DISTINCT FROM v_user
    OR public.can_approve_action(v_user, v_job.organization_id) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'User is not authorized to hand off this Builder job';
  END IF;

  SELECT id INTO v_receipt FROM public.builder_audit_events
    WHERE job_id = p_job_id AND actor_user_id = v_user AND event_type = 'job_status_changed'
      AND new_value->>'handoff_kind' = 'saved_frontend_patch_retry'
      AND new_value->>'step_id' = p_step_id::text
      AND new_value->>'patch_artifact_id' = p_patch_artifact_id::text
      AND new_value->>'target_sha' = p_target_sha
      AND new_value->>'request_updated_at' = p_job_updated_at::text
    ORDER BY created_at DESC LIMIT 1;
  IF v_receipt IS NOT NULL THEN RETURN v_receipt; END IF;

  IF v_job.status IS DISTINCT FROM 'failed'
    OR v_job.updated_at IS DISTINCT FROM p_job_updated_at
    OR v_job.target_sha IS DISTINCT FROM p_target_sha
    OR v_job.code_review_mode IS DISTINCT FROM 'human'
    OR v_job.frontend_required IS DISTINCT FROM true
    OR v_job.workspace_published_at IS NOT NULL
    OR v_job.workspace_published_head_sha IS NOT NULL
    OR v_job.workspace_pull_request_url IS NOT NULL
    OR v_job.workspace_pull_request_head_sha IS NOT NULL THEN
    RAISE EXCEPTION 'Failed job changed, is published, or is not eligible; refresh before retrying';
  END IF;

  SELECT * INTO v_step FROM public.builder_job_steps
    WHERE id = p_step_id AND job_id = p_job_id FOR UPDATE;
  IF v_step.id IS NULL OR v_step.step_id <> 'frontend_implementation'
    OR v_step.builder_mode <> 'frontend_engineer'
    OR v_step.status <> 'failed' OR v_step.retryable IS DISTINCT FROM false
    OR v_step.error IS NULL
    OR v_step.error NOT LIKE 'Verifier recovery paused after two infrastructure or attribution failures; patch preserved;%'
    OR v_step.input_context->>'patch_artifact_id' IS DISTINCT FROM p_patch_artifact_id::text
    OR v_step.input_context->>'target_sha' IS DISTINCT FROM p_target_sha
    OR (SELECT count(*) FROM public.builder_job_steps WHERE job_id = p_job_id AND status = 'failed') <> 1
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = p_job_id AND status = 'running')
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = p_job_id
      AND step_id IN ('test_suite', 'security_review', 'code_review', 'release_prep')
      AND (status <> 'pending' OR started_at IS NOT NULL OR completed_at IS NOT NULL))
    OR (SELECT count(*) FROM public.builder_job_steps WHERE job_id = p_job_id
      AND step_id IN ('test_suite', 'security_review', 'code_review', 'release_prep')) <> 4
    OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = p_job_id
      AND step_id = 'product_analysis' AND status = 'completed')
    OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = p_job_id
      AND step_id = 'ui_design' AND status = 'completed')
    OR (v_job.backend_required AND (SELECT count(*) FROM public.builder_job_steps
      WHERE job_id = p_job_id AND step_id = 'backend_implementation') <> 1)
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = p_job_id
      AND step_id = 'backend_implementation'
      AND ((v_job.backend_required AND status <> 'pending')
        OR (NOT v_job.backend_required AND status NOT IN ('pending', 'skipped'))
        OR started_at IS NOT NULL OR completed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Saved-patch retry requires one paused frontend verifier and untouched downstream gates';
  END IF;

  IF EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = p_job_id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = p_job_id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_approvals WHERE job_id = p_job_id AND status = 'pending') THEN
    RAISE EXCEPTION 'An active worker, model run, or approval prevents the saved-patch retry';
  END IF;

  SELECT * INTO v_patch FROM public.builder_artifacts
    WHERE id = p_patch_artifact_id AND job_id = p_job_id AND step_id = p_step_id
      AND artifact_type = 'code_implementation' AND status = 'final' FOR UPDATE;
  IF v_patch.id IS NULL OR v_patch.checksum IS NULL OR v_patch.checksum !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'The exact final saved patch is unavailable';
  END IF;

  SELECT * INTO v_run FROM public.builder_worker_runs
    WHERE job_id = p_job_id AND step_id = p_step_id
    ORDER BY created_at DESC LIMIT 1;
  IF v_run.id IS NULL OR v_run.status <> 'failed' OR v_run.profile <> 'frontend-verify'
    OR v_run.patch_artifact_id IS DISTINCT FROM v_patch.id
    OR v_run.target_sha IS DISTINCT FROM p_target_sha
    OR v_run.exit_code IS NULL OR v_run.exit_code = 0 THEN
    RAISE EXCEPTION 'The latest frontend verifier did not fail against this saved patch and target';
  END IF;

  v_receipt := gen_random_uuid();
  UPDATE public.builder_job_steps SET
    retryable = true,
    error = 'Verifier recovery pending: owner-confirmed saved patch verification',
    input_context = coalesce(input_context, '{}'::jsonb) || jsonb_build_object(
      'patch_artifact_id', v_patch.id, 'target_sha', v_job.target_sha,
      'owner_patch_retry_receipt', v_receipt, 'owner_patch_retry_actor', v_user,
      'owner_patch_retry_at', now()
    ),
    updated_at = now()
    WHERE id = v_step.id;

  UPDATE public.builder_jobs SET status = 'implementation_pending', last_error = NULL,
    current_step_name = NULL, current_step_index = 2,
    autopilot_state = CASE WHEN autopilot_requested_by IS NOT NULL THEN 'driving' ELSE autopilot_state END,
    updated_at = now()
    WHERE id = v_job.id;

  INSERT INTO public.builder_audit_events (
    id, organization_id, job_id, event_type, actor_user_id, actor_type,
    previous_value, new_value, change_summary, related_artifact_ids
  ) VALUES (
    v_receipt, v_job.organization_id, v_job.id, 'job_status_changed', v_user, 'user',
    jsonb_build_object('status', v_job.status, 'step_id', v_step.id, 'step_error', v_step.error,
      'attempt_count', v_step.attempt_count, 'target_sha', v_job.target_sha),
    jsonb_build_object('status', 'implementation_pending', 'handoff_kind', 'saved_frontend_patch_retry',
      'step_id', v_step.id, 'patch_artifact_id', v_patch.id, 'patch_checksum', v_patch.checksum,
      'target_sha', v_job.target_sha, 'request_updated_at', p_job_updated_at::text,
      'attempt_count', v_step.attempt_count, 'owner_user_id', v_user),
    'Owner confirmed same-job verification of the preserved frontend patch; no approval or publication',
    ARRAY[v_patch.id]
  );
  RETURN v_receipt;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_retry_failed_frontend_patch(uuid, uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.builder_retry_failed_frontend_patch(uuid, uuid, uuid, text, timestamptz)
  TO authenticated;

DO $patch$
DECLARE
  v_signature regprocedure := 'public.builder_claim_frontend_worker(uuid,uuid,uuid,text,text,integer)'::regprocedure;
  v_definition text;
  v_anchor text := '_idempotency_key := _job.id::text || ''::'' || _step.id::text || ''::'' || _job.target_sha || ''::'' || _patch.checksum
    || CASE WHEN _job.code_review_revision->>''approval_id'' IS NOT NULL
      THEN ''::correction::'' || (_job.code_review_revision->>''approval_id'') ELSE '''' END;';
  v_replacement text := '_idempotency_key := _job.id::text || ''::'' || _step.id::text || ''::'' || _job.target_sha || ''::'' || _patch.checksum
    || CASE WHEN _job.code_review_revision->>''approval_id'' IS NOT NULL
      THEN ''::correction::'' || (_job.code_review_revision->>''approval_id'') ELSE '''' END
    || CASE WHEN _step.input_context->>''owner_patch_retry_receipt'' IS NOT NULL
      THEN ''::owner_patch_retry::'' || (_step.input_context->>''owner_patch_retry_receipt'') ELSE '''' END;';
BEGIN
  v_definition := pg_get_functiondef(v_signature);
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Frontend worker claim changed; review saved-patch retry history key before applying';
  END IF;
  EXECUTE replace(v_definition, v_anchor, v_replacement);
END;
$patch$;
