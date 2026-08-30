-- Private artifact storage and atomic model-run finalization for Builder.

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
VALUES (
  'builder-artifacts',
  'builder-artifacts',
  false,
  10485760,
  ARRAY['application/json', 'text/markdown', 'text/plain']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE OR REPLACE FUNCTION public.builder_finalize_model_artifact(
  _model_run_id uuid,
  _artifact_type text,
  _content_type text,
  _object_path text,
  _sha256 text,
  _size_bytes integer,
  _model_name text,
  _usage_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS public.builder_artifacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _run public.builder_model_runs%rowtype;
  _artifact public.builder_artifacts%rowtype;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  IF _object_path IS NULL OR _object_path = '' OR _object_path LIKE '../%' OR _object_path LIKE '%/../%' THEN
    RAISE EXCEPTION 'Invalid artifact object path';
  END IF;
  IF _sha256 !~ '^[a-f0-9]{64}$' OR _size_bytes < 0 OR _size_bytes > 10485760 THEN
    RAISE EXCEPTION 'Invalid artifact integrity metadata';
  END IF;
  IF _content_type NOT IN ('application/json', 'text/markdown', 'text/plain') THEN
    RAISE EXCEPTION 'Unsupported artifact content type';
  END IF;

  SELECT * INTO _run
  FROM public.builder_model_runs
  WHERE id = _model_run_id
  FOR UPDATE;

  IF NOT FOUND OR _run.status <> 'running' THEN
    RAISE EXCEPTION 'Model run is missing or not running';
  END IF;

  INSERT INTO public.builder_artifacts (
    job_id,
    step_id,
    artifact_type,
    content_type,
    content_size_bytes,
    storage_location,
    checksum,
    produced_by_model,
    status
  )
  VALUES (
    _run.job_id,
    _run.step_id,
    _artifact_type,
    _content_type,
    _size_bytes,
    'supabase_storage://builder-artifacts/' || _object_path,
    _sha256,
    _run.provider,
    'final'
  )
  RETURNING * INTO _artifact;

  IF _run.step_id IS NOT NULL THEN
    UPDATE public.builder_job_steps
    SET artifact_ids = array_append(COALESCE(artifact_ids, '{}'), _artifact.id),
        updated_at = now()
    WHERE id = _run.step_id AND job_id = _run.job_id;
  END IF;

  INSERT INTO public.builder_audit_events (
    organization_id,
    job_id,
    event_type,
    actor_type,
    new_value,
    change_summary,
    related_artifact_ids
  )
  VALUES (
    _run.organization_id,
    _run.job_id,
    'artifact_created',
    'builder_mode',
    jsonb_build_object(
      'model_run_id', _run.id,
      'artifact_type', _artifact_type,
      'checksum', _sha256,
      'size_bytes', _size_bytes
    ),
    'Builder model output artifact verified and registered',
    ARRAY[_artifact.id]
  );

  UPDATE public.builder_model_runs
  SET status = 'completed',
      completed_at = now(),
      output_artifact_ids = array_append(COALESCE(output_artifact_ids, '{}'), _artifact.id),
      usage_metadata = COALESCE(_usage_metadata, '{}'::jsonb),
      model_name = COALESCE(NULLIF(_model_name, ''), model_name),
      error = NULL,
      updated_at = now()
  WHERE id = _run.id;

  INSERT INTO public.builder_audit_events (
    organization_id,
    job_id,
    event_type,
    actor_type,
    previous_value,
    new_value,
    change_summary,
    related_artifact_ids
  )
  VALUES (
    _run.organization_id,
    _run.job_id,
    'model_run_completed',
    'builder_mode',
    jsonb_build_object('status', _run.status),
    jsonb_build_object('status', 'completed', 'model_run_id', _run.id),
    'Builder model run completed with verified artifact',
    ARRAY[_artifact.id]
  );

  RETURN _artifact;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.builder_finalize_model_artifact(
  uuid, text, text, text, text, integer, text, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_finalize_model_artifact(
  uuid, text, text, text, text, integer, text, jsonb
) TO service_role;