ALTER TABLE public.cctv_exports
  ADD COLUMN IF NOT EXISTS artifact_bucket text,
  ADD COLUMN IF NOT EXISTS artifact_path text;

COMMENT ON COLUMN public.cctv_exports.artifact_path IS
  'Private storage object for the sealed export package. Access requires an audited signed URL path.';

CREATE OR REPLACE FUNCTION public.issue_cctv_export(
  p_export_id uuid,
  p_artifact_bucket text,
  p_artifact_path text
)
RETURNS public.cctv_exports
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  export_row public.cctv_exports;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_artifact_bucket IS NULL OR trim(p_artifact_bucket) = ''
     OR p_artifact_path IS NULL OR trim(p_artifact_path) = '' THEN
    RAISE EXCEPTION 'Private artifact bucket and path are required';
  END IF;

  SELECT * INTO export_row
    FROM public.cctv_exports
   WHERE id = p_export_id
   FOR UPDATE;

  IF NOT FOUND OR NOT public.org_access_allowed(export_row.organization_id) THEN
    RAISE EXCEPTION 'CCTV export not found or access denied';
  END IF;
  IF export_row.approval_state <> 'sealed' THEN
    RAISE EXCEPTION 'Only sealed exports may be issued';
  END IF;

  UPDATE public.cctv_exports
     SET approval_state = 'issued',
         artifact_bucket = trim(p_artifact_bucket),
         artifact_path = trim(p_artifact_path),
         issued_at = clock_timestamp()
   WHERE id = p_export_id
   RETURNING * INTO export_row;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    export_row.organization_id,
    actor_id,
    'cctv_export_issued',
    'cctv_exports',
    p_export_id,
    jsonb_build_object(
      'artifact_bucket', p_artifact_bucket,
      'artifact_path', p_artifact_path,
      'manifest_sha256', export_row.manifest_sha256
    )
  );

  RETURN export_row;
END;
$$;

REVOKE ALL ON FUNCTION public.issue_cctv_export(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_cctv_export(uuid, text, text) TO authenticated, service_role;
