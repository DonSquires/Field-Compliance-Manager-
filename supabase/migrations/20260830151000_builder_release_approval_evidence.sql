-- Release approval requests must snapshot the complete verified evidence set.

CREATE OR REPLACE FUNCTION public.builder_require_release_approval_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _required_types text[] := ARRAY[
    'code_implementation',
    'changed_file_manifest',
    'build_logs',
    'security_review',
    'release_notes',
    'rollback_plan',
    'deployment_manifest'
  ];
BEGIN
  IF NEW.approval_type <> 'release_approval' THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(_required_types) required_type
    WHERE NOT EXISTS (
      SELECT 1 FROM public.builder_artifacts artifact
      WHERE artifact.job_id = NEW.job_id
        AND artifact.id = ANY(NEW.reviewed_artifact_ids)
        AND artifact.artifact_type = required_type
        AND artifact.status = 'final'
    )
  ) THEN RAISE EXCEPTION 'Release approval requires the complete verified artifact set'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS builder_release_approval_evidence_gate ON public.builder_approvals;
CREATE TRIGGER builder_release_approval_evidence_gate
BEFORE INSERT OR UPDATE OF reviewed_artifact_ids, approval_type
ON public.builder_approvals
FOR EACH ROW
EXECUTE FUNCTION public.builder_require_release_approval_evidence();

REVOKE EXECUTE ON FUNCTION public.builder_require_release_approval_evidence()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.builder_require_release_approval_evidence()
  TO service_role;