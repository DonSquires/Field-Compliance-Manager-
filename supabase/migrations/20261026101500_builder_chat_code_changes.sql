ALTER TABLE public.builder_jobs ADD COLUMN code_review_revision jsonb
  CHECK (code_review_revision IS NULL OR jsonb_typeof(code_review_revision) = 'object');

CREATE OR REPLACE FUNCTION public.builder_chat_request_code_changes(p_message_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_card public.builder_chat_messages%rowtype;
  v_source public.builder_chat_messages%rowtype;
  v_approval public.builder_approvals%rowtype;
  v_job public.builder_jobs%rowtype;
  v_revision jsonb;
  v_feedback text;
  v_seed_ids jsonb := '{}'::jsonb;
  v_step public.builder_job_steps%rowtype;
  v_patch uuid;
  v_count integer;
  v_event uuid;
BEGIN
  SELECT m.* INTO v_card FROM public.builder_chat_messages m
    JOIN public.builder_chat_threads t ON t.id = m.thread_id
    WHERE m.id = p_message_id AND m.kind = 'proposal' AND m.role = 'bob' AND t.created_by = v_user
    FOR UPDATE OF m;
  IF v_card.id IS NULL OR v_card.payload->'revision'->>'kind' IS DISTINCT FROM 'implementation' THEN
    RAISE EXCEPTION 'Implementation correction card not found';
  END IF;
  IF v_card.payload ? 'revision_receipt' THEN RETURN (v_card.payload->>'revision_receipt')::uuid; END IF;
  v_revision := v_card.payload->'revision';
  v_feedback := v_revision->>'feedback';
  IF v_feedback IS NULL OR char_length(btrim(v_feedback)) < 40 OR char_length(v_feedback) > 4000 THEN
    RAISE EXCEPTION 'Bounded implementation feedback is required';
  END IF;
  SELECT * INTO v_source FROM public.builder_chat_messages
    WHERE id = (v_revision->>'source_message_id')::uuid
      AND thread_id = v_card.thread_id AND created_by = v_user
      AND id::text = v_card.payload->>'message_id' AND role = 'owner' AND status = 'done'
      AND payload->>'pm_purpose' IN ('pm', 'technical_review')
      AND payload->'research_consent'->>'allowed' = 'true';
  IF v_source.id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.builder_chat_messages WHERE thread_id = v_card.thread_id
      AND kind = 'proposal' AND payload->>'job_id' = v_revision->>'job_id'
  ) THEN RAISE EXCEPTION 'Corrections require an accepted same-thread handoff and completed approved PM turn'; END IF;

  -- Match the existing human decision RPC's approval-before-job lock order.
  SELECT * INTO v_approval FROM public.builder_approvals
    WHERE id = (v_revision->>'approval_id')::uuid FOR UPDATE;
  IF v_approval.id IS NULL OR v_approval.status <> 'pending'
    OR v_approval.approval_type <> 'implementation_review'
    OR v_approval.job_id::text IS DISTINCT FROM v_revision->>'job_id'
    OR v_approval.expires_at <= now() THEN
    RAISE EXCEPTION 'Human code review has moved or expired; prepare a fresh correction card';
  END IF;
  IF public.can_approve_action(v_user, v_approval.organization_id) IS DISTINCT FROM true
    OR (cardinality(v_approval.requested_from_users) > 0
      AND NOT (v_user = ANY(v_approval.requested_from_users))) THEN
    RAISE EXCEPTION 'User is not authorized to request implementation changes';
  END IF;
  SELECT * INTO v_job FROM public.builder_jobs WHERE id = v_approval.job_id FOR UPDATE;
  IF v_job.status IS DISTINCT FROM 'security_review' OR v_job.code_review_mode IS DISTINCT FROM 'human'
    OR v_job.code_review_status IS DISTINCT FROM 'pending'
    OR v_job.target_sha IS DISTINCT FROM v_approval.requested_target_sha
    OR v_job.target_sha IS DISTINCT FROM v_revision->>'target_sha'
    OR v_job.workspace_published_at IS NOT NULL OR v_job.workspace_published_head_sha IS NOT NULL
    OR v_job.workspace_pull_request_url IS NOT NULL THEN
    RAISE EXCEPTION 'Job is not at an unpublished pending human code review';
  END IF;
  PERFORM 1 FROM public.builder_job_steps WHERE job_id = v_job.id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND step_id = 'code_review' AND status = 'blocked')
    OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND step_id = 'security_review' AND status = 'completed')
    OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND step_id = 'test_suite' AND status = 'completed')
    OR NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND step_id = 'release_prep'
      AND status = 'pending' AND started_at IS NULL AND completed_at IS NULL)
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND status = 'running')
    OR EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = v_job.id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = v_job.id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_approvals WHERE job_id = v_job.id AND status = 'pending' AND id <> v_approval.id) THEN
    RAISE EXCEPTION 'Implementation correction requires idle completed verification and an untouched release';
  END IF;

  FOR v_step IN SELECT * FROM public.builder_job_steps WHERE job_id = v_job.id
    AND step_id IN ('frontend_implementation', 'backend_implementation')
  LOOP
    IF v_step.status = 'skipped' THEN CONTINUE; END IF;
    IF v_step.status <> 'completed' THEN RAISE EXCEPTION 'Implementation must be completed or scope-skipped'; END IF;
    SELECT count(*), (array_agg(r.patch_artifact_id))[1] INTO v_count, v_patch
      FROM public.builder_worker_runs r JOIN public.builder_artifacts a ON a.id = r.patch_artifact_id
      WHERE r.job_id = v_job.id AND r.step_id = v_step.id AND r.status = 'completed'
        AND r.organization_id = v_job.organization_id AND r.target_sha = v_job.target_sha
        AND r.profile = CASE v_step.step_id WHEN 'frontend_implementation' THEN 'frontend-verify' ELSE 'backend-verify' END
        AND a.job_id = v_job.id AND a.step_id = v_step.id AND a.status = 'final'
        AND a.artifact_type = 'code_implementation' AND a.id = ANY(v_approval.reviewed_artifact_ids);
    IF v_count <> 1 THEN RAISE EXCEPTION 'Exactly one reviewed verified patch per implementation lane is required'; END IF;
    v_seed_ids := v_seed_ids || jsonb_build_object(v_step.step_id, v_patch);
  END LOOP;
  IF v_seed_ids = '{}'::jsonb THEN RAISE EXCEPTION 'No reviewed implementation to correct'; END IF;

  UPDATE public.builder_approvals SET status = 'cancelled', decided_by = v_user,
    approval_comment = v_feedback, responded_at = now(), updated_at = now() WHERE id = v_approval.id;
  UPDATE public.builder_artifacts SET status = 'superseded', updated_at = now()
    WHERE job_id = v_job.id AND status = 'final' AND step_id IN (
      SELECT id FROM public.builder_job_steps WHERE job_id = v_job.id
        AND step_id IN ('frontend_implementation', 'backend_implementation', 'test_suite', 'security_review', 'code_review', 'release_prep'));
  UPDATE public.builder_job_steps SET status = 'pending', started_at = NULL, completed_at = NULL,
    result_summary = NULL, error = NULL, retryable = false, blocked_reason = NULL, updated_at = now()
    WHERE job_id = v_job.id AND step_id IN ('frontend_implementation', 'backend_implementation', 'test_suite', 'security_review', 'code_review')
      AND status <> 'skipped';
  UPDATE public.builder_jobs SET status = 'implementation_pending', code_review_status = 'pending',
    code_review_artifact_id = NULL, current_step_name = NULL, current_step_index = 2, last_error = NULL,
    code_review_revision = jsonb_build_object('approval_id', v_approval.id, 'feedback', v_feedback,
      'review_quote', v_source.content, 'source_message_id', v_source.id, 'requested_by', v_user,
      'seed_patch_ids', v_seed_ids, 'requested_at', now()),
    autopilot_state = CASE WHEN autopilot_requested_by IS NOT NULL THEN 'driving' ELSE autopilot_state END,
    updated_at = now() WHERE id = v_job.id;
  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_user_id, actor_type, previous_value, new_value,
    change_summary, related_artifact_ids, related_approval_id
  ) VALUES (
    v_job.organization_id, v_job.id, 'job_status_changed', v_user, 'user',
    jsonb_build_object('status', 'security_review'),
    jsonb_build_object('status', 'implementation_pending', 'feedback', v_feedback,
      'source_message_id', v_source.id, 'seed_patch_ids', v_seed_ids),
    'Owner requested same-job implementation corrections; fresh verification, security and human review required',
    v_approval.reviewed_artifact_ids, v_approval.id
  ) RETURNING id INTO v_event;
  UPDATE public.builder_chat_messages SET payload = payload || jsonb_build_object(
    'revision_receipt', v_event, 'revision_requested_at', now()) WHERE id = v_card.id;
  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_chat_request_code_changes(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.builder_chat_request_code_changes(uuid) TO authenticated;
