CREATE TABLE IF NOT EXISTS public.cctv_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE RESTRICT,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE RESTRICT,
  purpose text NOT NULL CHECK (char_length(trim(purpose)) BETWEEN 3 AND 500),
  recipient_scope text NOT NULL CHECK (char_length(trim(recipient_scope)) BETWEEN 3 AND 500),
  legal_hold boolean NOT NULL DEFAULT false,
  approval_state text NOT NULL CHECK (approval_state IN ('draft', 'submitted', 'approved', 'rejected', 'sealed', 'issued')) DEFAULT 'draft',
  selected_event_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest jsonb NOT NULL,
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  generated_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  generated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_at timestamptz,
  sealed_at timestamptz,
  issued_at timestamptz
);

COMMENT ON TABLE public.cctv_exports IS
  'Immutable CCTV evidence package manifests. Approval and sealing are separate from report printing.';

CREATE INDEX IF NOT EXISTS idx_cctv_exports_scope
  ON public.cctv_exports (organization_id, approval_state, generated_at DESC);

ALTER TABLE public.cctv_exports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_exports_select ON public.cctv_exports;
CREATE POLICY cctv_exports_select ON public.cctv_exports
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.cctv_exports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cctv_exports TO authenticated;
GRANT ALL ON TABLE public.cctv_exports TO service_role;

CREATE OR REPLACE FUNCTION public.create_cctv_export_draft(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_purpose text,
  p_recipient_scope text,
  p_legal_hold boolean,
  p_selected_event_ids jsonb,
  p_manifest jsonb
)
RETURNS public.cctv_exports
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  actor_id uuid := auth.uid();
  export_row public.cctv_exports;
  manifest_hash text;
BEGIN
  IF actor_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'CCTV export access denied';
  END IF;
  IF p_purpose IS NULL OR char_length(trim(p_purpose)) < 3 OR p_recipient_scope IS NULL OR char_length(trim(p_recipient_scope)) < 3 THEN
    RAISE EXCEPTION 'Export purpose and recipient scope are required';
  END IF;
  IF jsonb_typeof(p_selected_event_ids) <> 'array' OR jsonb_typeof(p_manifest) <> 'object' THEN
    RAISE EXCEPTION 'Export event selection and manifest shapes are invalid';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
    WHERE id = p_job_id AND evidence_item_id = p_evidence_id AND organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'CCTV evidence is missing or outside the organization';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p_selected_event_ids) selected_id
    WHERE NOT EXISTS (
      SELECT 1 FROM public.cctv_review_events event
      WHERE event.id = selected_id::uuid
        AND event.organization_id = p_organization_id
        AND event.inference_job_id = p_job_id
        AND event.evidence_item_id = p_evidence_id
        AND event.review_state = 'accepted'
    )
  ) THEN
    RAISE EXCEPTION 'Only accepted CCTV review events may be exported';
  END IF;

  manifest_hash := encode(digest(convert_to(p_manifest::text, 'UTF8'), 'sha256'), 'hex');
  INSERT INTO public.cctv_exports (
    organization_id, inference_job_id, evidence_item_id, purpose, recipient_scope,
    legal_hold, selected_event_ids, manifest, manifest_sha256, generated_by
  ) VALUES (
    p_organization_id, p_job_id, p_evidence_id, trim(p_purpose), trim(p_recipient_scope),
    coalesce(p_legal_hold, false), p_selected_event_ids, p_manifest, manifest_hash, actor_id
  ) RETURNING * INTO export_row;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, actor_id, 'cctv_export_draft_created', 'cctv_exports', export_row.id,
    jsonb_build_object('purpose', p_purpose, 'recipient_scope', p_recipient_scope, 'legal_hold', p_legal_hold, 'manifest_sha256', manifest_hash));

  RETURN export_row;
END;
$$;

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
BEGIN
  IF actor_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_approval_state NOT IN ('submitted', 'approved', 'rejected') THEN RAISE EXCEPTION 'Invalid export approval state'; END IF;
  SELECT * INTO export_row FROM public.cctv_exports WHERE id = p_export_id FOR UPDATE;
  IF NOT FOUND OR NOT public.org_access_allowed(export_row.organization_id) THEN RAISE EXCEPTION 'CCTV export not found or access denied'; END IF;
  IF export_row.approval_state IN ('sealed', 'issued') THEN RAISE EXCEPTION 'Sealed exports cannot be changed'; END IF;

  UPDATE public.cctv_exports
     SET approval_state = p_approval_state,
         approved_by = CASE WHEN p_approval_state = 'approved' THEN actor_id ELSE NULL END,
         approved_at = CASE WHEN p_approval_state = 'approved' THEN clock_timestamp() ELSE NULL END
   WHERE id = p_export_id
   RETURNING * INTO export_row;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (export_row.organization_id, actor_id, 'cctv_export_approval_changed', 'cctv_exports', p_export_id,
    jsonb_build_object('approval_state', p_approval_state));
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
  IF actor_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO export_row FROM public.cctv_exports WHERE id = p_export_id FOR UPDATE;
  IF NOT FOUND OR NOT public.org_access_allowed(export_row.organization_id) THEN RAISE EXCEPTION 'CCTV export not found or access denied'; END IF;
  IF export_row.approval_state <> 'approved' THEN RAISE EXCEPTION 'Only approved exports may be sealed'; END IF;
  UPDATE public.cctv_exports SET approval_state = 'sealed', sealed_at = clock_timestamp() WHERE id = p_export_id RETURNING * INTO export_row;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (export_row.organization_id, actor_id, 'cctv_export_sealed', 'cctv_exports', p_export_id, jsonb_build_object('manifest_sha256', export_row.manifest_sha256));
  RETURN export_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_cctv_export_draft(uuid,uuid,uuid,text,text,boolean,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cctv_export_draft(uuid,uuid,uuid,text,text,boolean,jsonb,jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_cctv_export(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_cctv_export(uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.seal_cctv_export(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seal_cctv_export(uuid) TO authenticated, service_role;
