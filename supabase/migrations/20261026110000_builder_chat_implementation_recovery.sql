CREATE OR REPLACE FUNCTION public.builder_chat_recover_implementation(p_message_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_card public.builder_chat_messages%rowtype;
  v_source public.builder_chat_messages%rowtype;
  v_job public.builder_jobs%rowtype;
  v_step public.builder_job_steps%rowtype;
  v_approval public.builder_approvals%rowtype;
  v_revision jsonb;
  v_feedback text;
  v_event uuid := gen_random_uuid();
BEGIN
  SELECT m.* INTO v_card FROM public.builder_chat_messages m
    JOIN public.builder_chat_threads t ON t.id = m.thread_id
    WHERE m.id = p_message_id AND m.kind = 'proposal' AND m.role = 'bob' AND t.created_by = v_user
    FOR UPDATE OF m;
  IF v_card.id IS NULL OR v_card.payload->'revision'->>'kind' IS DISTINCT FROM 'recovery' THEN
    RAISE EXCEPTION 'Implementation recovery card not found';
  END IF;
  IF v_card.payload ? 'revision_receipt' THEN RETURN (v_card.payload->>'revision_receipt')::uuid; END IF;
  v_revision := v_card.payload->'revision';
  v_feedback := v_revision->>'feedback';
  IF v_feedback IS NULL OR char_length(btrim(v_feedback)) < 40 OR char_length(v_feedback) > 4000 THEN
    RAISE EXCEPTION 'Bounded recovery feedback is required';
  END IF;
  SELECT * INTO v_source FROM public.builder_chat_messages
    WHERE id = (v_revision->>'source_message_id')::uuid AND thread_id = v_card.thread_id
      AND created_by = v_user AND id::text = v_card.payload->>'message_id'
      AND role = 'owner' AND status = 'done' AND payload->>'pm_purpose' IN ('pm', 'technical_review')
      AND payload->'research_consent'->>'allowed' = 'true';
  IF v_source.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.builder_chat_messages WHERE thread_id = v_card.thread_id
      AND kind = 'proposal' AND payload->>'job_id' = v_revision->>'job_id'
  ) THEN RAISE EXCEPTION 'Recovery requires an accepted same-thread handoff and completed approved PM turn'; END IF;

  SELECT * INTO v_job FROM public.builder_jobs WHERE id = (v_revision->>'job_id')::uuid FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status IS DISTINCT FROM 'failed'
    OR v_job.target_sha IS DISTINCT FROM v_revision->>'target_sha'
    OR v_job.updated_at IS DISTINCT FROM (v_revision->>'job_updated_at')::timestamptz
    OR v_job.code_review_revision->>'approval_id' IS DISTINCT FROM v_revision->>'approval_id'
    OR v_job.code_review_revision->>'approval_id' IS NULL
    OR v_job.code_review_mode IS DISTINCT FROM 'human'
    OR v_job.workspace_published_at IS NOT NULL OR v_job.workspace_published_head_sha IS NOT NULL
    OR v_job.workspace_pull_request_url IS NOT NULL THEN
    RAISE EXCEPTION 'Failed correction changed or is published; prepare a fresh recovery card';
  END IF;
  SELECT * INTO v_approval FROM public.builder_approvals
    WHERE id = (v_job.code_review_revision->>'approval_id')::uuid;
  IF v_approval.id IS NULL OR v_approval.job_id <> v_job.id
    OR v_approval.organization_id IS DISTINCT FROM v_job.organization_id
    OR v_approval.approval_type <> 'implementation_review' OR v_approval.status <> 'cancelled'
    OR v_approval.requested_target_sha IS DISTINCT FROM v_job.target_sha
    OR public.can_approve_action(v_user, v_job.organization_id) IS DISTINCT FROM true
    OR (cardinality(v_approval.requested_from_users) > 0 AND NOT (v_user = ANY(v_approval.requested_from_users))) THEN
    RAISE EXCEPTION 'User is not authorized to recover this correction';
  END IF;
  PERFORM 1 FROM public.builder_job_steps WHERE job_id = v_job.id FOR UPDATE;
  SELECT * INTO v_step FROM public.builder_job_steps
    WHERE id = (v_revision->>'failed_step_id')::uuid AND job_id = v_job.id;
  IF v_step.id IS NULL OR v_step.status <> 'failed'
    OR v_step.step_id NOT IN ('frontend_implementation', 'backend_implementation')
    OR v_step.error NOT LIKE 'generation: %'
    OR v_step.error IS NULL
    OR (SELECT count(*) FROM public.builder_job_steps WHERE job_id = v_job.id AND status = 'failed') <> 1
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND status = 'running')
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id
      AND step_id IN ('frontend_implementation', 'backend_implementation') AND id <> v_step.id AND status NOT IN ('pending', 'skipped'))
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id
      AND step_id IN ('test_suite', 'security_review', 'code_review', 'release_prep')
      AND (status <> 'pending' OR started_at IS NOT NULL OR completed_at IS NOT NULL))
    OR (SELECT count(*) FROM public.builder_job_steps WHERE job_id = v_job.id
      AND step_id IN ('test_suite', 'security_review', 'code_review', 'release_prep')) <> 4
    OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND step_id = 'product_analysis' AND status = 'completed')
    OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND step_id = 'ui_design' AND status IN ('completed', 'skipped'))
    OR EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = v_job.id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = v_job.id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_approvals WHERE job_id = v_job.id AND status = 'pending')
    OR EXISTS (SELECT 1 FROM public.builder_artifacts WHERE job_id = v_job.id AND status = 'final'
      AND artifact_type = 'code_implementation' AND step_id = v_step.id) THEN
    RAISE EXCEPTION 'Recovery requires an idle author failure without a patch and untouched downstream checks';
  END IF;
  UPDATE public.builder_job_steps SET status = 'pending', started_at = NULL, completed_at = NULL,
    error = NULL, result_summary = NULL, blocked_reason = NULL, retryable = false, updated_at = now()
    WHERE id = v_step.id;
  UPDATE public.builder_jobs SET status = 'implementation_pending', last_error = NULL,
    current_step_name = NULL, current_step_index = 2,
    code_review_revision = code_review_revision || jsonb_build_object(
      'recovery_id', v_event, 'recovery_feedback', v_feedback, 'recovery_report', v_source.content,
      'recovery_source_message_id', v_source.id, 'recovered_by', v_user, 'recovered_at', now()),
    autopilot_state = CASE WHEN autopilot_requested_by IS NOT NULL THEN 'driving' ELSE autopilot_state END,
    updated_at = now() WHERE id = v_job.id;
  INSERT INTO public.builder_audit_events (
    id, organization_id, job_id, event_type, actor_user_id, actor_type, previous_value, new_value,
    change_summary, related_approval_id
  ) VALUES (
    v_event, v_job.organization_id, v_job.id, 'job_status_changed', v_user, 'user',
    jsonb_build_object('status', v_job.status, 'step_id', v_step.id, 'step_error', v_step.error,
      'attempt_count', v_step.attempt_count, 'previous_recovery_id', v_job.code_review_revision->>'recovery_id'),
    jsonb_build_object('status', 'implementation_pending', 'source_message_id', v_source.id,
      'feedback', v_feedback, 'human_report', v_source.content, 'attempt_count', v_step.attempt_count),
    'Owner confirmed same-job recovery after implementation author failure; attempts and history preserved',
    v_approval.id
  );
  UPDATE public.builder_chat_messages SET payload = payload || jsonb_build_object('revision_receipt', v_event)
    WHERE id = v_card.id;
  RETURN v_event;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.builder_chat_recover_implementation(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.builder_chat_recover_implementation(uuid) TO authenticated;
