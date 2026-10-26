-- Acceptance belongs to the whole approved job, not to whichever lane emitted a patch.
CREATE OR REPLACE FUNCTION public.builder_implementation_acceptance_identity(_job_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO public AS $$
  SELECT jsonb_build_object(
    'target_sha', j.target_sha,
    'correction', j.code_review_revision,
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'step_id', s.step_id, 'status', s.status) ORDER BY s.id)
      FROM public.builder_job_steps s WHERE s.job_id = j.id
        AND s.step_id IN ('frontend_implementation', 'backend_implementation')
    ), '[]'::jsonb),
    'artifacts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', a.id, 'step_id', a.step_id,
        'artifact_type', a.artifact_type, 'checksum', a.checksum) ORDER BY a.id)
      FROM public.builder_artifacts a WHERE a.job_id = j.id AND a.status = 'final'
        AND a.artifact_type IN ('product_specification', 'code_implementation', 'changed_file_manifest', 'build_logs')
        AND (a.artifact_type = 'product_specification' OR EXISTS (
          SELECT 1 FROM public.builder_job_steps s WHERE s.id = a.step_id AND s.job_id = j.id
            AND s.step_id IN ('frontend_implementation', 'backend_implementation')))
    ), '[]'::jsonb),
    'runs', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'step_id', r.step_id,
        'patch_artifact_id', r.patch_artifact_id, 'output_artifact_ids',
          COALESCE((SELECT jsonb_agg(v ORDER BY v) FROM unnest(r.output_artifact_ids) v), '[]'::jsonb)) ORDER BY r.id)
      FROM public.builder_worker_runs r JOIN public.builder_job_steps s ON s.id = r.step_id AND s.job_id = j.id
      WHERE r.job_id = j.id AND r.status = 'completed' AND r.profile IN ('frontend-verify', 'backend-verify')
        AND s.step_id IN ('frontend_implementation', 'backend_implementation')
        AND EXISTS (SELECT 1 FROM public.builder_artifacts a WHERE a.id = r.patch_artifact_id
          AND a.job_id = j.id AND a.status = 'final')
    ), '[]'::jsonb)
  ) FROM public.builder_jobs j WHERE j.id = _job_id;
$$;
REVOKE ALL ON FUNCTION public.builder_implementation_acceptance_identity(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.builder_record_implementation_acceptance(
  _job_id uuid, _expected_identity jsonb, _report jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE _job public.builder_jobs%rowtype; _step public.builder_job_steps%rowtype; _receipt jsonb;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  SELECT * INTO _job FROM public.builder_jobs WHERE id = _job_id FOR UPDATE;
  IF _job.id IS NULL OR _job.status <> 'security_review' THEN
    RAISE EXCEPTION 'Job is not ready for whole-job acceptance';
  END IF;
  PERFORM 1 FROM public.builder_job_steps WHERE job_id = _job_id FOR UPDATE;
  IF _expected_identity IS DISTINCT FROM public.builder_implementation_acceptance_identity(_job_id)
    OR EXISTS (SELECT 1 FROM public.builder_worker_runs WHERE job_id = _job_id AND status = 'running')
    OR EXISTS (SELECT 1 FROM public.builder_model_runs WHERE job_id = _job_id AND status = 'running')
  THEN RAISE EXCEPTION 'Acceptance evidence changed or work is active'; END IF;
  IF _report IS NULL OR jsonb_typeof(_report) <> 'object' OR octet_length(_report::text) > 262144
    OR (_report->>'version') IS DISTINCT FROM '1'
    OR jsonb_typeof(_report->'passed') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(_report->'requirements') IS DISTINCT FROM 'array'
    OR jsonb_typeof(_report->'blockers') IS DISTINCT FROM 'array'
  THEN RAISE EXCEPTION 'Invalid whole-job acceptance report'; END IF;
  IF _report->>'passed' = 'true' AND (
    jsonb_array_length(_report->'requirements') NOT BETWEEN 1 AND 100
    OR jsonb_array_length(_report->'blockers') <> 0
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(_report->'requirements') r
      WHERE r->>'status' IS DISTINCT FROM 'covered' OR COALESCE(btrim(r->>'requirement_id'), '') = '')
    OR (SELECT count(DISTINCT r->>'requirement_id') FROM jsonb_array_elements(_report->'requirements') r)
      <> jsonb_array_length(_report->'requirements')
  ) THEN RAISE EXCEPTION 'Passing acceptance report has unresolved requirements'; END IF;
  SELECT * INTO _step FROM public.builder_job_steps WHERE job_id = _job_id AND step_id = 'test_suite';
  IF _step.id IS NULL THEN RAISE EXCEPTION 'Acceptance test step is missing'; END IF;
  _receipt := jsonb_build_object('identity', _expected_identity, 'report', _report);
  IF _step.input_context->'implementation_acceptance' IS NOT DISTINCT FROM _receipt THEN RETURN; END IF;
  UPDATE public.builder_job_steps SET input_context = COALESCE(input_context, '{}'::jsonb)
    || jsonb_build_object('implementation_acceptance', _receipt),
    result_summary = CASE WHEN _report->>'passed' = 'true'
      THEN 'Whole-job acceptance coverage reconciled; semantic and human review still required'
      ELSE 'Whole-job acceptance incomplete: ' || left((
        SELECT string_agg(value, ' ') FROM jsonb_array_elements_text(_report->'blockers')
      ), 3000) END, updated_at = now() WHERE id = _step.id;
  INSERT INTO public.builder_audit_events(organization_id, job_id, event_type, actor_type,
    new_value, change_summary)
  VALUES (_job.organization_id, _job.id, 'step_completed', 'bot', _receipt,
    CASE WHEN _report->>'passed' = 'true' THEN 'Whole-job acceptance coverage reconciled; human/semantic review still required'
      ELSE 'Whole-job acceptance incomplete; correction required before approval or release' END);
END;
$$;
REVOKE ALL ON FUNCTION public.builder_record_implementation_acceptance(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.builder_record_implementation_acceptance(uuid, jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.builder_require_implementation_acceptance(_job_id uuid, _require_passed boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
DECLARE _receipt jsonb;
BEGIN
  SELECT input_context->'implementation_acceptance' INTO _receipt FROM public.builder_job_steps
    WHERE job_id = _job_id AND step_id = 'test_suite';
  IF _receipt IS NULL OR (_require_passed AND (_receipt->'report'->>'passed') IS DISTINCT FROM 'true')
    OR _receipt->'identity' IS DISTINCT FROM public.builder_implementation_acceptance_identity(_job_id)
  THEN RAISE EXCEPTION 'Whole-job acceptance incomplete or stale; reconcile every approved delivery requirement before review or release'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_require_implementation_acceptance(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.builder_enforce_implementation_acceptance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public AS $$
BEGIN
  IF TG_TABLE_NAME = 'builder_job_steps' THEN
    IF (NEW.step_id = 'code_review' AND NEW.status IN ('running', 'blocked', 'skipped', 'completed')
        OR NEW.step_id = 'release_prep' AND NEW.status IN ('running', 'completed'))
      AND NEW.status IS DISTINCT FROM OLD.status
    THEN PERFORM public.builder_require_implementation_acceptance(NEW.job_id,
      NOT (NEW.step_id = 'code_review' AND NEW.status = 'blocked' AND EXISTS (
        SELECT 1 FROM public.builder_jobs WHERE id = NEW.job_id AND code_review_mode = 'human'
      ))); END IF;
  ELSIF TG_TABLE_NAME = 'builder_approvals' THEN
    IF NEW.approval_type = 'implementation_review' AND NEW.status = 'approved' AND OLD.status <> 'approved'
      THEN PERFORM public.builder_require_implementation_acceptance(NEW.job_id); END IF;
  ELSIF NEW.status = 'release_ready' AND OLD.status <> 'release_ready' THEN
    PERFORM public.builder_require_implementation_acceptance(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.builder_enforce_implementation_acceptance() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER builder_whole_job_acceptance_step BEFORE UPDATE OF status ON public.builder_job_steps
  FOR EACH ROW EXECUTE FUNCTION public.builder_enforce_implementation_acceptance();
CREATE TRIGGER builder_whole_job_acceptance_approval BEFORE UPDATE OF status ON public.builder_approvals
  FOR EACH ROW EXECUTE FUNCTION public.builder_enforce_implementation_acceptance();
CREATE TRIGGER builder_whole_job_acceptance_release BEFORE UPDATE OF status ON public.builder_jobs
  FOR EACH ROW EXECUTE FUNCTION public.builder_enforce_implementation_acceptance();
