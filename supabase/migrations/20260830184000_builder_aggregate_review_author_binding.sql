-- Bind an independent reviewer to every exact patch and every author model in
-- an aggregate frontend/backend evidence snapshot.

CREATE OR REPLACE FUNCTION public.builder_complete_independent_code_review(
  _job_id uuid, _step_id uuid, _reviewer_model_run_id uuid, _review_artifact_id uuid, _verdict text
)
RETURNS public.builder_jobs LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype;
  reviewer_run public.builder_model_runs%rowtype; _expected_inputs uuid[]; _reviewed_patch_ids uuid[];
  _author_identities jsonb; _passed boolean;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF _verdict NOT IN ('passed', 'blocked') THEN RAISE EXCEPTION 'Independent review verdict is invalid'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  SELECT * INTO _step FROM public.builder_job_steps WHERE id = _step_id AND job_id = _job_id FOR UPDATE;
  SELECT * INTO reviewer_run FROM public.builder_model_runs WHERE id = _reviewer_model_run_id AND job_id = _job_id AND step_id = _step_id;
  IF _job.id IS NULL OR _job.status <> 'security_review' OR _job.code_review_mode <> 'independent_ai' THEN RAISE EXCEPTION 'Independent code review is not configured'; END IF;
  IF _step.id IS NULL OR _step.status <> 'running' OR _step.builder_mode <> 'code_reviewer' THEN RAISE EXCEPTION 'Independent code review step is not running'; END IF;

  SELECT COALESCE(array_agg(value::uuid), '{}') INTO _expected_inputs
  FROM jsonb_array_elements_text(COALESCE(_step.input_context->'reviewed_artifact_ids', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(artifact.id ORDER BY artifact.id), '{}') INTO _reviewed_patch_ids
  FROM public.builder_artifacts artifact
  WHERE artifact.job_id = _job.id AND artifact.id = ANY(_expected_inputs)
    AND artifact.artifact_type = 'code_implementation' AND artifact.status = 'final';

  IF reviewer_run.id IS NULL OR reviewer_run.status <> 'completed' OR NOT (_review_artifact_id = ANY(reviewer_run.output_artifact_ids)) THEN RAISE EXCEPTION 'Independent reviewer model evidence is incomplete'; END IF;
  IF cardinality(_expected_inputs) < 4 OR NOT (reviewer_run.input_artifact_ids @> _expected_inputs)
     OR cardinality(reviewer_run.input_artifact_ids) <> cardinality(_expected_inputs) THEN
    RAISE EXCEPTION 'Independent reviewer inputs do not match the approved evidence snapshot';
  END IF;
  IF cardinality(_reviewed_patch_ids) NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'Reviewed patch evidence is incomplete'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(_reviewed_patch_ids) reviewed_patch_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.builder_model_runs author_run
      JOIN public.builder_job_steps author_step ON author_step.id = author_run.step_id
      WHERE author_run.job_id = _job.id AND author_step.builder_mode IN ('frontend_engineer', 'backend_engineer')
        AND author_run.status = 'completed' AND reviewed_patch_id = ANY(author_run.output_artifact_ids)
    )
  ) THEN RAISE EXCEPTION 'Reviewed patch author provenance is missing'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.builder_model_runs author_run
    JOIN public.builder_job_steps author_step ON author_step.id = author_run.step_id
    WHERE author_run.job_id = _job.id AND author_step.builder_mode IN ('frontend_engineer', 'backend_engineer')
      AND author_run.status = 'completed' AND author_run.output_artifact_ids && _reviewed_patch_ids
      AND reviewer_run.provider = author_run.provider AND reviewer_run.model_name = author_run.model_name
  ) THEN RAISE EXCEPTION 'Independent reviewer must use a different provider or model identity from every patch author'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('provider', author_run.provider, 'model', author_run.model_name,
    'builder_mode', author_step.builder_mode)), '[]'::jsonb) INTO _author_identities
  FROM public.builder_model_runs author_run
  JOIN public.builder_job_steps author_step ON author_step.id = author_run.step_id
  WHERE author_run.job_id = _job.id AND author_step.builder_mode IN ('frontend_engineer', 'backend_engineer')
    AND author_run.status = 'completed' AND author_run.output_artifact_ids && _reviewed_patch_ids;
  IF NOT EXISTS (SELECT 1 FROM public.builder_artifacts WHERE id = _review_artifact_id AND job_id = _job.id
    AND step_id = _step.id AND artifact_type = 'code_review' AND status = 'final') THEN RAISE EXCEPTION 'Independent code review artifact is invalid'; END IF;

  _passed := _verdict = 'passed';
  UPDATE public.builder_job_steps SET status = CASE WHEN _passed THEN 'completed' ELSE 'failed' END,
    completed_at = now(), retryable = false, artifact_ids = ARRAY[_review_artifact_id],
    result_summary = CASE WHEN _passed THEN 'Independent AI code review passed' ELSE 'Independent AI code review blocked release' END,
    error = CASE WHEN _passed THEN NULL ELSE 'Independent AI code review found blocking defects' END, updated_at = now()
  WHERE id = _step.id;
  UPDATE public.builder_jobs SET code_review_status = CASE WHEN _passed THEN 'passed' ELSE 'blocked' END,
    code_review_artifact_id = _review_artifact_id, status = CASE WHEN _passed THEN 'security_review' ELSE 'failed' END,
    last_error = CASE WHEN _passed THEN NULL ELSE 'Independent AI code review found blocking defects' END, updated_at = now()
  WHERE id = _job.id RETURNING * INTO _job;
  INSERT INTO public.builder_audit_events (organization_id, job_id, event_type, actor_type, new_value, change_summary, related_artifact_ids)
  VALUES (_job.organization_id, _job.id, CASE WHEN _passed THEN 'step_completed' ELSE 'step_failed' END, 'builder_mode',
    jsonb_build_object('code_review_status', _job.code_review_status, 'reviewer_provider', reviewer_run.provider,
      'reviewer_model', reviewer_run.model_name, 'author_identities', _author_identities,
      'reviewed_patch_ids', _reviewed_patch_ids),
    CASE WHEN _passed THEN 'Independent AI code review passed' ELSE 'Independent AI code review blocked release' END,
    ARRAY[_review_artifact_id]);
  RETURN _job;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_complete_independent_code_review(uuid,uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.builder_complete_independent_code_review(uuid,uuid,uuid,uuid,text) TO service_role;