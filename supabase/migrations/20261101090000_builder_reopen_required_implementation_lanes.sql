CREATE OR REPLACE FUNCTION public.builder_reopen_required_implementation_lanes(_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.builder_jobs%ROWTYPE;
  v_approval public.builder_approvals%ROWTYPE;
  v_step public.builder_job_steps%ROWTYPE;
  v_approval_id uuid;
  v_reopened text[] := ARRAY[]::text[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;

  SELECT * INTO v_job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.status <> 'implementation_pending'
    OR v_job.code_review_mode <> 'human' OR v_job.code_review_status <> 'pending'
    OR v_job.code_review_revision IS NULL THEN
    RAISE EXCEPTION 'Job is not continuing a confirmed human implementation correction';
  END IF;

  v_approval_id := NULLIF(v_job.code_review_revision->>'approval_id', '')::uuid;
  SELECT * INTO v_approval FROM public.builder_approvals
    WHERE id = v_approval_id AND job_id = v_job.id FOR UPDATE;
  IF v_approval.id IS NULL OR v_approval.status <> 'cancelled'
    OR v_approval.approval_type <> 'implementation_review'
    OR v_approval.requested_target_sha IS DISTINCT FROM v_job.target_sha
    OR v_job.workspace_published_at IS NOT NULL OR v_job.workspace_published_head_sha IS NOT NULL
    OR v_job.workspace_pull_request_url IS NOT NULL THEN
    RAISE EXCEPTION 'Confirmed correction is stale or already published';
  END IF;
  IF EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND status = 'running')
    OR EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = v_job.id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = v_job.id AND status IN ('pending', 'running'))
    OR EXISTS (SELECT 1 FROM public.builder_approvals WHERE job_id = v_job.id AND status = 'pending')
    OR EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = v_job.id AND step_id = 'release_prep'
      AND (status <> 'pending' OR started_at IS NOT NULL OR completed_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Required implementation lanes can only reopen before work or release starts';
  END IF;
  IF v_job.code_review_revision ? 'reopened_required_lanes' THEN
    RETURN jsonb_build_object('reopened', v_job.code_review_revision->'reopened_required_lanes');
  END IF;

  FOR v_step IN
    SELECT * FROM public.builder_job_steps
    WHERE job_id = v_job.id AND status = 'skipped'
      AND ((step_id = 'frontend_implementation' AND v_job.frontend_required)
        OR (step_id = 'backend_implementation' AND v_job.backend_required))
    ORDER BY ordinal_position
    FOR UPDATE
  LOOP
    UPDATE public.builder_job_steps SET status = 'pending', started_at = NULL, completed_at = NULL,
      result_summary = NULL, error = NULL, retryable = false, blocked_reason = NULL, artifact_ids = NULL,
      updated_at = now()
    WHERE id = v_step.id;
    v_reopened := array_append(v_reopened, v_step.step_id);
    INSERT INTO public.builder_audit_events (
      organization_id, job_id, event_type, actor_type, previous_value, new_value, change_summary, related_approval_id
    ) VALUES (
      v_job.organization_id, v_job.id, 'error_recorded', 'builder_mode',
      jsonb_build_object('step_id', v_step.step_id, 'status', 'skipped'),
      jsonb_build_object('step_id', v_step.step_id, 'status', 'pending', 'cause', 'required_lane_skipped'),
      'Reopened a required implementation lane for the confirmed same-job correction',
      v_approval.id
    );
  END LOOP;

  UPDATE public.builder_jobs SET code_review_revision = code_review_revision || jsonb_build_object(
    'reopened_required_lanes', to_jsonb(v_reopened), 'required_lanes_reopened_at', now()
  ), updated_at = now()
  WHERE id = v_job.id;

  RETURN jsonb_build_object('reopened', to_jsonb(v_reopened));
END;
$$;

REVOKE ALL ON FUNCTION public.builder_reopen_required_implementation_lanes(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_reopen_required_implementation_lanes(uuid) TO postgres, service_role;

DO $patch$
DECLARE
  v_definition text := pg_get_functiondef('public.builder_skip_implementation_step(uuid,uuid,text,text)'::regprocedure);
  v_anchor text := '_sibling_mode := CASE WHEN';
  v_replacement text := 'IF jsonb_typeof(_job.code_review_revision->''reopened_required_lanes'') = ''array''
    AND _job.code_review_revision->''reopened_required_lanes'' ? _step.step_id THEN
    RAISE EXCEPTION ''A required lane reopened by the confirmed correction cannot be skipped'';
  END IF;
  _sibling_mode := CASE WHEN';
BEGIN
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Implementation skip changed; review reopened-lane guard before applying';
  END IF;
  EXECUTE replace(v_definition, v_anchor, v_replacement);
END;
$patch$;
