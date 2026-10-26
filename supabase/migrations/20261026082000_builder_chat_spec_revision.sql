CREATE OR REPLACE FUNCTION public.builder_chat_request_spec_revision(p_message_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := public.builder_chat_require_owner();
  v_card public.builder_chat_messages%rowtype;
  v_approval public.builder_approvals%rowtype;
  v_job public.builder_jobs%rowtype;
  v_step public.builder_job_steps%rowtype;
  v_revision jsonb;
  v_feedback text;
  v_event uuid;
BEGIN
  SELECT m.* INTO v_card FROM public.builder_chat_messages m
    JOIN public.builder_chat_threads t ON t.id = m.thread_id
    WHERE m.id = p_message_id AND m.kind = 'proposal' AND t.created_by = v_user
    FOR UPDATE OF m;
  IF v_card.id IS NULL OR jsonb_typeof(v_card.payload->'revision') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Specification revision card not found';
  END IF;
  IF v_card.payload ? 'revision_receipt' THEN
    RETURN (v_card.payload->>'revision_receipt')::uuid;
  END IF;
  v_revision := v_card.payload->'revision';
  v_feedback := v_revision->>'feedback';
  IF v_feedback IS NULL OR char_length(btrim(v_feedback)) < 40 OR char_length(v_feedback) > 4000 THEN
    RAISE EXCEPTION 'Bounded specification feedback is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.builder_chat_messages m
    WHERE m.thread_id = v_card.thread_id AND m.kind = 'proposal'
      AND m.payload->>'job_id' = v_revision->>'job_id'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.builder_chat_messages m
    WHERE m.id = (v_revision->>'source_message_id')::uuid
      AND m.thread_id = v_card.thread_id AND m.created_by = v_user
      AND m.id::text = v_card.payload->>'message_id' AND m.role = 'owner' AND m.status = 'done'
      AND m.payload->>'pm_purpose' IN ('pm', 'technical_review')
      AND m.payload->'research_consent'->>'allowed' = 'true'
  ) THEN RAISE EXCEPTION 'Revision must belong to an accepted owner handoff and approved PM turn'; END IF;

  -- Match the decision RPC's approval-before-job lock order.
  SELECT * INTO v_approval FROM public.builder_approvals
    WHERE id = (v_revision->>'approval_id')::uuid FOR UPDATE;
  IF v_approval.id IS NULL OR v_approval.status <> 'pending'
    OR v_approval.approval_type <> 'specification_review'
    OR v_approval.job_id::text IS DISTINCT FROM v_revision->>'job_id'
    OR v_approval.expires_at <= now() THEN
    RAISE EXCEPTION 'Specification review has moved or expired; prepare a fresh revision';
  END IF;
  IF public.can_approve_action(v_user, v_approval.organization_id) IS DISTINCT FROM true
    OR (cardinality(v_approval.requested_from_users) > 0
      AND NOT (v_user = ANY(v_approval.requested_from_users))) THEN
    RAISE EXCEPTION 'User is not authorized to revise this specification';
  END IF;
  SELECT * INTO v_job FROM public.builder_jobs WHERE id = v_approval.job_id FOR UPDATE;
  IF v_job.status IS DISTINCT FROM 'specification_ready'
    OR v_job.target_sha IS DISTINCT FROM v_approval.requested_target_sha
    OR v_job.target_sha IS DISTINCT FROM v_revision->>'target_sha' THEN
    RAISE EXCEPTION 'Job has moved beyond this specification gate';
  END IF;
  PERFORM 1 FROM public.builder_job_steps WHERE job_id = v_job.id FOR UPDATE;
  SELECT * INTO v_step FROM public.builder_job_steps
    WHERE job_id = v_job.id AND builder_mode = 'product_analyst';
  IF v_step.id IS NULL OR v_step.status <> 'completed'
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id
      AND id <> v_step.id AND status <> 'pending')
    OR EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = v_job.id)
    OR EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = v_job.id AND status = 'running') THEN
    RAISE EXCEPTION 'Revision is limited to an idle initial specification review';
  END IF;

  UPDATE public.builder_approvals SET status = 'cancelled', decided_by = v_user,
    approval_comment = v_feedback, responded_at = now(), updated_at = now()
    WHERE id = v_approval.id;
  UPDATE public.builder_artifacts SET status = 'superseded', updated_at = now()
    WHERE job_id = v_job.id AND id = ANY(v_approval.reviewed_artifact_ids) AND status = 'final';
  UPDATE public.builder_job_steps SET status = 'pending', started_at = NULL, completed_at = NULL,
    result_summary = NULL, error = NULL, retryable = false,
    input_context = COALESCE(input_context, '{}'::jsonb) || jsonb_build_object(
      'specification_revision', jsonb_build_object('feedback', v_feedback,
        'review_quote', v_revision->>'review_quote', 'approval_id', v_approval.id,
        'source_message_id', v_revision->>'source_message_id', 'requested_by', v_user)),
    updated_at = now() WHERE id = v_step.id;
  UPDATE public.builder_jobs SET status = 'analysis_pending', last_error = NULL,
    autopilot_state = CASE WHEN autopilot_requested_by IS NOT NULL THEN 'driving' ELSE autopilot_state END,
    updated_at = now() WHERE id = v_job.id;
  INSERT INTO public.builder_audit_events (
    organization_id, job_id, event_type, actor_user_id, actor_type,
    previous_value, new_value, change_summary, related_artifact_ids, related_approval_id
  ) VALUES (
    v_job.organization_id, v_job.id, 'job_status_changed', v_user, 'user',
    jsonb_build_object('status', 'specification_ready'),
    jsonb_build_object('status', 'analysis_pending', 'feedback', v_feedback, 'source_message_id', v_revision->>'source_message_id'),
    'Owner requested a revised specification on the existing job; no implementation approved',
    v_approval.reviewed_artifact_ids, v_approval.id
  ) RETURNING id INTO v_event;
  UPDATE public.builder_chat_messages
    SET payload = payload || jsonb_build_object('revision_receipt', v_event, 'revision_requested_at', now())
    WHERE id = v_card.id;
  RETURN v_event;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_chat_request_spec_revision(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.builder_chat_request_spec_revision(uuid) TO authenticated;
