-- Authenticated read boundary for Builder approval activity.

CREATE OR REPLACE FUNCTION public.get_builder_approvals_activity(
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_statuses text[] DEFAULT NULL,
  p_approval_types text[] DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  approval_type text,
  status text,
  job_id uuid,
  job_title text,
  project_name text,
  repository text,
  target_sha text,
  organization_id uuid,
  org_name text,
  requested_at timestamptz,
  responded_at timestamptz,
  approval_comment text,
  decided_by uuid,
  decided_by_name text,
  reviewed_artifacts jsonb,
  can_decide boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
BEGIN
  IF auth.role() <> 'authenticated' OR v_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT up.role INTO v_role
  FROM public.user_profiles up
  WHERE up.id = v_user_id;

  IF v_role IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.approval_type,
    a.status,
    a.job_id,
    j.title,
    p.name,
    p.gitea_owner || '/' || p.gitea_repo,
    a.requested_target_sha,
    a.organization_id,
    o.name,
    a.requested_at,
    a.responded_at,
    a.approval_comment,
    a.decided_by,
    decider.display_name,
    COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', artifact.id,
          'artifact_type', artifact.artifact_type,
          'content_type', artifact.content_type,
          'content_size_bytes', artifact.content_size_bytes,
          'checksum', artifact.checksum,
          'status', artifact.status,
          'version_number', artifact.version_number
        )
        ORDER BY artifact.created_at
      )
      FROM public.builder_artifacts artifact
      WHERE artifact.id = ANY(a.reviewed_artifact_ids)
        AND artifact.job_id = a.job_id
    ), '[]'::jsonb),
    (
      a.status = 'pending'
      AND public.can_approve_action(v_user_id, a.organization_id)
      AND (
        cardinality(a.requested_from_users) = 0
        OR v_user_id = ANY(a.requested_from_users)
      )
    )
  FROM public.builder_approvals a
  JOIN public.builder_jobs j ON j.id = a.job_id
  JOIN public.builder_projects p ON p.id = j.project_id
  JOIN public.organizations o ON o.id = a.organization_id
  LEFT JOIN public.user_profiles decider ON decider.id = a.decided_by
  WHERE (
    v_role = 'grand_master'
    OR (
      v_role IN ('master', 'admin')
      AND public.can_approve_action(v_user_id, a.organization_id)
    )
    OR v_user_id = ANY(a.requested_from_users)
  )
  AND (p_statuses IS NULL OR a.status = ANY(p_statuses))
  AND (p_approval_types IS NULL OR a.approval_type = ANY(p_approval_types))
  ORDER BY
    CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
    a.requested_at DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100)
  OFFSET GREATEST(COALESCE(p_offset, 0), 0);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.get_builder_approvals_activity(integer, integer, text[], text[])
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_builder_approvals_activity(integer, integer, text[], text[])
  TO authenticated;