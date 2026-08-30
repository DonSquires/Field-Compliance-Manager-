-- Optional code review policy: none, authenticated human, or independent AI.

ALTER TABLE public.builder_jobs
  ADD COLUMN IF NOT EXISTS code_review_mode text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS code_review_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS code_review_artifact_id uuid REFERENCES public.builder_artifacts(id) ON DELETE SET NULL,
  ADD CONSTRAINT builder_jobs_code_review_mode_check CHECK (code_review_mode IN ('none', 'human', 'independent_ai')),
  ADD CONSTRAINT builder_jobs_code_review_status_check CHECK (code_review_status IN ('not_required', 'pending', 'passed', 'blocked'));

ALTER TABLE public.builder_artifacts DROP CONSTRAINT IF EXISTS builder_artifacts_artifact_type_check;
ALTER TABLE public.builder_artifacts ADD CONSTRAINT builder_artifacts_artifact_type_check CHECK (
  artifact_type IN (
    'product_specification', 'ui_design_plan', 'component_inventory', 'code_implementation',
    'changed_file_manifest', 'test_results', 'test_coverage_report', 'security_review',
    'code_review', 'dependency_analysis', 'build_logs', 'deployment_manifest', 'rollback_plan',
    'release_notes', 'screenshots', 'design_tokens', 'accessibility_report'
  )
);

ALTER TABLE public.builder_job_steps DROP CONSTRAINT IF EXISTS builder_job_steps_builder_mode_check;
ALTER TABLE public.builder_job_steps ADD CONSTRAINT builder_job_steps_builder_mode_check CHECK (
  builder_mode IN ('product_analyst', 'ux_designer', 'frontend_engineer', 'backend_engineer',
    'qa_security_reviewer', 'code_reviewer', 'release_engineer')
);

UPDATE public.builder_job_steps SET ordinal_position = 8 WHERE step_id = 'release_prep' AND ordinal_position = 7;
INSERT INTO public.builder_job_steps (job_id, step_id, ordinal_position, builder_mode, status, blocked_dependencies)
SELECT job.id, 'code_review', 7, 'code_reviewer',
  CASE WHEN job.code_review_mode = 'none' THEN 'skipped' ELSE 'pending' END,
  ARRAY['security_review']
FROM public.builder_jobs job
WHERE NOT EXISTS (SELECT 1 FROM public.builder_job_steps step WHERE step.job_id = job.id AND step.step_id = 'code_review');
UPDATE public.builder_jobs SET total_steps = GREATEST(total_steps, 8);

CREATE OR REPLACE FUNCTION public.builder_set_code_review_policy(_job_id uuid, _mode text)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _uid uuid := auth.uid(); _job public.builder_jobs%rowtype;
BEGIN
  IF auth.role() <> 'authenticated' OR _uid IS NULL THEN RAISE EXCEPTION 'Authenticated human identity required'; END IF;
  IF _mode NOT IN ('none', 'human', 'independent_ai') THEN RAISE EXCEPTION 'Unsupported code review mode'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'intake' THEN RAISE EXCEPTION 'Code review policy can only be set during intake'; END IF;
  IF NOT public.can_approve_action(_uid, _job.organization_id) THEN RAISE EXCEPTION 'User cannot configure this job'; END IF;
  UPDATE public.builder_jobs SET code_review_mode = _mode,
    code_review_status = CASE WHEN _mode = 'none' THEN 'not_required' ELSE 'pending' END, updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  UPDATE public.builder_job_steps SET status = CASE WHEN _mode = 'none' THEN 'skipped' ELSE 'pending' END, updated_at = now()
  WHERE job_id = _job.id AND step_id = 'code_review';
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_user_id, actor_type, new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'job_status_changed', _uid, 'user',
    jsonb_build_object('code_review_mode', _mode), 'Optional code review policy configured');
  RETURN _job;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_start_code_review(
  _job_id uuid, _step_id uuid, _reviewed_artifact_ids uuid[], _requested_from_users uuid[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype; _approval public.builder_approvals%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'security_review' THEN RAISE EXCEPTION 'Job is not ready for optional code review'; END IF;
  IF _step.id IS NULL OR _step.step_id <> 'code_review' OR _step.builder_mode <> 'code_reviewer' THEN RAISE EXCEPTION 'Code review step is missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_job_steps WHERE job_id = _job.id AND step_id = 'security_review' AND status = 'completed') THEN
    RAISE EXCEPTION 'Independent security review must complete first';
  END IF;
  IF COALESCE(cardinality(_reviewed_artifact_ids), 0) < 4 OR (
    SELECT count(*) FROM public.builder_artifacts WHERE job_id = _job.id AND id = ANY(_reviewed_artifact_ids) AND status = 'final'
  ) <> cardinality(_reviewed_artifact_ids) THEN RAISE EXCEPTION 'Code review evidence snapshot is incomplete'; END IF;

  IF _job.code_review_mode = 'none' THEN
    UPDATE public.builder_job_steps SET status = 'skipped', completed_at = now(), result_summary = 'Optional code review not requested', updated_at = now() WHERE id = _step.id;
    UPDATE public.builder_jobs SET code_review_status = 'not_required', updated_at = now() WHERE id = _job.id;
    RETURN jsonb_build_object('mode', 'none', 'status', 'skipped');
  ELSIF _job.code_review_mode = 'human' THEN
    UPDATE public.builder_job_steps SET status = 'blocked', blocked_reason = 'Waiting for human code review', input_context = jsonb_build_object('reviewed_artifact_ids', _reviewed_artifact_ids), updated_at = now() WHERE id = _step.id;
    INSERT INTO public.builder_approvals (organization_id, job_id, approval_type, triggered_at_status, status,
      requested_from_users, requested_target_sha, reviewed_artifact_ids)
    VALUES (_job.organization_id, _job.id, 'implementation_review', 'security_review', 'pending',
      COALESCE(_requested_from_users, '{}'), _job.target_sha, _reviewed_artifact_ids)
    RETURNING * INTO _approval;
    UPDATE public.builder_jobs SET code_review_status = 'pending', updated_at = now() WHERE id = _job.id;
    INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids, related_approval_id)
    VALUES (_job.organization_id, _job.id, 'approval_requested', 'bot', jsonb_build_object('approval_type', 'implementation_review', 'target_sha', _job.target_sha),
      'Optional human code review requested', _reviewed_artifact_ids, _approval.id);
    RETURN jsonb_build_object('mode', 'human', 'status', 'pending', 'approval_id', _approval.id);
  ELSIF _job.code_review_mode = 'independent_ai' THEN
    UPDATE public.builder_job_steps SET status = 'running', attempt_count = attempt_count + 1, started_at = now(),
      input_context = jsonb_build_object('reviewed_artifact_ids', _reviewed_artifact_ids, 'target_sha', _job.target_sha), updated_at = now()
    WHERE id = _step.id;
    UPDATE public.builder_jobs SET code_review_status = 'pending', updated_at = now() WHERE id = _job.id;
    RETURN jsonb_build_object('mode', 'independent_ai', 'status', 'running');
  END IF;
  RAISE EXCEPTION 'Unsupported code review policy state';
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_decide_human_code_review(_approval_id uuid, _decision text, _comment text DEFAULT NULL)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _uid uuid := auth.uid(); _approval public.builder_approvals%rowtype; _job public.builder_jobs%rowtype; _passed boolean;
BEGIN
  IF auth.role() <> 'authenticated' OR _uid IS NULL THEN RAISE EXCEPTION 'Authenticated human identity required'; END IF;
  IF _decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  SELECT * INTO _approval FROM public.builder_approvals WHERE id = _approval_id AND approval_type = 'implementation_review' FOR UPDATE;
  IF _approval.id IS NULL OR _approval.status <> 'pending' THEN RAISE EXCEPTION 'Human code review is missing or decided'; END IF;
  IF NOT public.can_approve_action(_uid, _approval.organization_id) THEN RAISE EXCEPTION 'User cannot review this job'; END IF;
  IF cardinality(_approval.requested_from_users) > 0 AND NOT (_uid = ANY(_approval.requested_from_users)) THEN RAISE EXCEPTION 'Review was not requested from this user'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _approval.job_id FOR UPDATE;
  IF _job.status <> 'security_review' OR _job.code_review_mode <> 'human' OR _approval.requested_target_sha IS DISTINCT FROM _job.target_sha THEN RAISE EXCEPTION 'Human code review is stale'; END IF;
  _passed := _decision = 'approved';
  UPDATE public.builder_approvals SET status = _decision, decided_by = _uid,
    approved_by = CASE WHEN _passed THEN _uid ELSE NULL END, approval_comment = NULLIF(btrim(_comment), ''), responded_at = now(), updated_at = now()
  WHERE id = _approval.id;
  UPDATE public.builder_job_steps SET status = CASE WHEN _passed THEN 'completed' ELSE 'failed' END, completed_at = now(),
    blocked_reason = NULL, result_summary = CASE WHEN _passed THEN 'Optional human code review passed' ELSE 'Human code review blocked release' END,
    error = CASE WHEN _passed THEN NULL ELSE 'Human code review rejected implementation' END, artifact_ids = _approval.reviewed_artifact_ids, updated_at = now()
  WHERE job_id = _job.id AND step_id = 'code_review';
  UPDATE public.builder_jobs SET code_review_status = CASE WHEN _passed THEN 'passed' ELSE 'blocked' END,
    status = CASE WHEN _passed THEN 'security_review' ELSE 'failed' END,
    last_error = CASE WHEN _passed THEN NULL ELSE COALESCE(NULLIF(btrim(_comment), ''), 'Human code review rejected implementation') END, updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_user_id, actor_type, new_value, change_summary, related_artifact_ids, related_approval_id)
  VALUES (_job.organization_id, _job.id, CASE WHEN _passed THEN 'approval_approved' ELSE 'approval_rejected' END, _uid, 'user',
    jsonb_build_object('code_review_status', _job.code_review_status, 'target_sha', _job.target_sha),
    CASE WHEN _passed THEN 'Optional human code review passed' ELSE 'Human code review blocked release' END,
    _approval.reviewed_artifact_ids, _approval.id);
  RETURN _job;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_complete_independent_code_review(
  _job_id uuid, _step_id uuid, _reviewer_model_run_id uuid, _review_artifact_id uuid, _verdict text
)
RETURNS public.builder_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype; reviewer_run public.builder_model_runs%rowtype; author_run public.builder_model_runs%rowtype; _passed boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _verdict NOT IN ('passed', 'blocked') THEN RAISE EXCEPTION 'Independent review verdict is invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO reviewer_run FROM public.builder_model_runs WHERE id = _reviewer_model_run_id AND job_id = _job_id AND step_id = _step_id;
  SELECT model_run.* INTO author_run FROM public.builder_model_runs model_run
  JOIN public.builder_job_steps author_step ON author_step.id = model_run.step_id
  WHERE model_run.job_id = _job_id AND author_step.builder_mode = 'frontend_engineer' AND model_run.status = 'completed'
  ORDER BY model_run.completed_at DESC LIMIT 1;
  IF _job.id IS NULL OR _job.status <> 'security_review' OR _job.code_review_mode <> 'independent_ai' THEN RAISE EXCEPTION 'Independent code review is not configured'; END IF;
  IF _step.id IS NULL OR _step.status <> 'running' OR _step.builder_mode <> 'code_reviewer' THEN RAISE EXCEPTION 'Independent code review step is not running'; END IF;
  IF reviewer_run.id IS NULL OR reviewer_run.status <> 'completed' OR NOT (_review_artifact_id = ANY(reviewer_run.output_artifact_ids)) THEN RAISE EXCEPTION 'Independent reviewer model evidence is incomplete'; END IF;
  IF author_run.id IS NULL OR reviewer_run.model_name = author_run.model_name THEN RAISE EXCEPTION 'Independent reviewer must use a different model identity'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = _review_artifact_id AND job_id = _job.id AND step_id = _step.id AND artifact_type = 'code_review' AND status = 'final') THEN
    RAISE EXCEPTION 'Independent code review artifact is invalid';
  END IF;
  _passed := _verdict = 'passed';
  UPDATE public.builder_job_steps SET status = CASE WHEN _passed THEN 'completed' ELSE 'failed' END, completed_at = now(), retryable = false,
    artifact_ids = ARRAY[_review_artifact_id], result_summary = CASE WHEN _passed THEN 'Independent AI code review passed' ELSE 'Independent AI code review blocked release' END,
    error = CASE WHEN _passed THEN NULL ELSE 'Independent AI code review found blocking defects' END, updated_at = now() WHERE id = _step.id;
  UPDATE public.builder_jobs SET code_review_status = CASE WHEN _passed THEN 'passed' ELSE 'blocked' END,
    code_review_artifact_id = _review_artifact_id, status = CASE WHEN _passed THEN 'security_review' ELSE 'failed' END,
    last_error = CASE WHEN _passed THEN NULL ELSE 'Independent AI code review found blocking defects' END, updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids)
  VALUES (_job.organization_id, _job.id, CASE WHEN _passed THEN 'step_completed' ELSE 'step_failed' END, 'builder_mode',
    jsonb_build_object('code_review_status', _job.code_review_status, 'reviewer_model', reviewer_run.model_name, 'author_model', author_run.model_name),
    CASE WHEN _passed THEN 'Independent AI code review passed' ELSE 'Independent AI code review blocked release' END, ARRAY[_review_artifact_id]);
  RETURN _job;
END;
$$;

CREATE OR REPLACE FUNCTION public.builder_enforce_release_review_policy()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _job public.builder_jobs%rowtype;
BEGIN
  IF NEW.step_id <> 'release_prep' OR NEW.status <> 'running' THEN RETURN NEW; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = NEW.job_id;
  IF _job.code_review_mode IN ('human', 'independent_ai') AND _job.code_review_status <> 'passed' THEN
    RAISE EXCEPTION 'Configured code review must pass before release preparation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_release_review_policy_gate ON public.builder_job_steps;
CREATE TRIGGER builder_release_review_policy_gate BEFORE UPDATE OF status ON public.builder_job_steps
FOR EACH ROW EXECUTE FUNCTION public.builder_enforce_release_review_policy();

CREATE OR REPLACE FUNCTION public.builder_require_release_approval_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE _required_types text[] := ARRAY['code_implementation','changed_file_manifest','build_logs','security_review','release_notes','rollback_plan','deployment_manifest']; _review_mode text;
BEGIN
  IF NEW.approval_type <> 'release_approval' THEN RETURN NEW; END IF;
  SELECT code_review_mode INTO _review_mode FROM public.builder_jobs WHERE id = NEW.job_id;
  IF _review_mode = 'independent_ai' THEN _required_types := array_append(_required_types, 'code_review'); END IF;
  IF EXISTS (SELECT 1 FROM unnest(_required_types) required_type WHERE NOT EXISTS (
    SELECT 1 FROM public.builder_artifacts artifact WHERE artifact.job_id = NEW.job_id AND artifact.id = ANY(NEW.reviewed_artifact_ids)
      AND artifact.artifact_type = required_type AND artifact.status = 'final'
  )) THEN RAISE EXCEPTION 'Release approval requires the complete verified artifact set'; END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_set_code_review_policy(uuid,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.builder_set_code_review_policy(uuid,text) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_start_code_review(uuid,uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated;
REVOKE EXECUTE ON FUNCTION public.builder_complete_independent_code_review(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_start_code_review(uuid,uuid,uuid[],uuid[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.builder_complete_independent_code_review(uuid,uuid,uuid,uuid,text) TO service_role;
REVOKE EXECUTE ON FUNCTION public.builder_decide_human_code_review(uuid,text,text) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.builder_decide_human_code_review(uuid,text,text) TO authenticated;