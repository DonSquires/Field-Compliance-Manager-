BEGIN;

CREATE OR REPLACE FUNCTION public.approve_cctv_export(
  p_export_id uuid,
  p_approval_state text
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
  previous_state text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_approval_state NOT IN ('submitted', 'approved', 'rejected') THEN
    RAISE EXCEPTION 'Invalid export approval state';
  END IF;

  SELECT *
    INTO export_row
    FROM public.cctv_exports
   WHERE id = p_export_id
   FOR UPDATE;

  IF NOT FOUND OR NOT public.org_access_allowed(export_row.organization_id) THEN
    RAISE EXCEPTION 'CCTV export not found or access denied';
  END IF;

  previous_state := export_row.approval_state;

  IF p_approval_state = 'submitted' THEN
    IF previous_state <> 'draft' THEN
      RAISE EXCEPTION 'Only draft exports may be submitted';
    END IF;
    IF export_row.generated_by <> actor_id
       AND NOT public.is_admin_for_org(export_row.organization_id) THEN
      RAISE EXCEPTION 'Only the export author or an organization administrator may submit this draft';
    END IF;
  ELSE
    IF NOT public.is_admin_for_org(export_row.organization_id) THEN
      RAISE EXCEPTION 'Organization administrator authority is required to approve or reject CCTV exports';
    END IF;
    IF previous_state <> 'submitted' THEN
      RAISE EXCEPTION 'Only submitted exports may be approved or rejected';
    END IF;
  END IF;

  UPDATE public.cctv_exports
     SET approval_state = p_approval_state,
         approved_by = CASE WHEN p_approval_state = 'approved' THEN actor_id ELSE NULL END,
         approved_at = CASE WHEN p_approval_state = 'approved' THEN clock_timestamp() ELSE NULL END
   WHERE id = p_export_id
   RETURNING * INTO export_row;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    export_row.organization_id,
    actor_id,
    'cctv_export_approval_changed',
    'cctv_exports',
    p_export_id,
    jsonb_build_object(
      'previous_state', previous_state,
      'approval_state', p_approval_state,
      'manifest_sha256', export_row.manifest_sha256
    )
  );

  RETURN export_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.seal_cctv_export(p_export_id uuid)
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

  SELECT *
    INTO export_row
    FROM public.cctv_exports
   WHERE id = p_export_id
   FOR UPDATE;

  IF NOT FOUND OR NOT public.is_admin_for_org(export_row.organization_id) THEN
    RAISE EXCEPTION 'CCTV export not found or administrator access denied';
  END IF;
  IF export_row.approval_state <> 'approved' THEN
    RAISE EXCEPTION 'Only approved exports may be sealed';
  END IF;

  UPDATE public.cctv_exports
     SET approval_state = 'sealed',
         sealed_at = clock_timestamp()
   WHERE id = p_export_id
   RETURNING * INTO export_row;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    export_row.organization_id,
    actor_id,
    'cctv_export_sealed',
    'cctv_exports',
    p_export_id,
    jsonb_build_object(
      'previous_state', 'approved',
      'manifest_sha256', export_row.manifest_sha256
    )
  );

  RETURN export_row;
END;
$$;

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
  expected_path text;
BEGIN
  IF actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT *
    INTO export_row
    FROM public.cctv_exports
   WHERE id = p_export_id
   FOR UPDATE;

  IF NOT FOUND OR NOT public.is_admin_for_org(export_row.organization_id) THEN
    RAISE EXCEPTION 'CCTV export not found or administrator access denied';
  END IF;
  IF export_row.approval_state <> 'sealed' THEN
    RAISE EXCEPTION 'Only sealed exports may be issued';
  END IF;

  expected_path := format(
    'cctv-exports/%s/%s/manifest-%s.json',
    export_row.organization_id,
    export_row.id,
    export_row.manifest_sha256
  );
  IF p_artifact_bucket <> 'bob-uploads' OR p_artifact_path <> expected_path THEN
    RAISE EXCEPTION 'CCTV export artifact must use its governed private manifest path';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM storage.objects object
    WHERE object.bucket_id = p_artifact_bucket
      AND object.name = p_artifact_path
  ) THEN
    RAISE EXCEPTION 'CCTV export artifact has not been uploaded';
  END IF;

  UPDATE public.cctv_exports
     SET approval_state = 'issued',
         artifact_bucket = p_artifact_bucket,
         artifact_path = p_artifact_path,
         issued_at = clock_timestamp()
   WHERE id = p_export_id
   RETURNING * INTO export_row;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    export_row.organization_id,
    actor_id,
    'cctv_export_issued',
    'cctv_exports',
    p_export_id,
    jsonb_build_object(
      'previous_state', 'sealed',
      'artifact_bucket', p_artifact_bucket,
      'artifact_path', p_artifact_path,
      'manifest_sha256', export_row.manifest_sha256
    )
  );

  RETURN export_row;
END;
$$;

COMMIT;