CREATE TABLE IF NOT EXISTS public.bob_generated_document_outputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE RESTRICT,
  document_version_id uuid NOT NULL REFERENCES public.document_versions(id) ON DELETE RESTRICT,
  output_format text NOT NULL CHECK (output_format IN ('pdf', 'docx', 'print')),
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'generating', 'ready', 'failed', 'revoked')),
  storage_bucket text,
  storage_path text,
  sha256 text,
  requested_by uuid NOT NULL REFERENCES public.user_profiles(id),
  approved_by uuid REFERENCES public.user_profiles(id),
  approved_at timestamptz,
  generated_at timestamptz,
  failure_reason text,
  delivery_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS bob_generated_document_outputs_org_status_idx
  ON public.bob_generated_document_outputs (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS bob_generated_document_outputs_version_idx
  ON public.bob_generated_document_outputs (document_version_id, created_at DESC);

ALTER TABLE public.bob_generated_document_outputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY bob_generated_document_outputs_select ON public.bob_generated_document_outputs
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE INSERT, UPDATE, DELETE ON public.bob_generated_document_outputs FROM anon, authenticated;
GRANT SELECT ON public.bob_generated_document_outputs TO authenticated;
GRANT ALL ON public.bob_generated_document_outputs TO service_role;

CREATE OR REPLACE FUNCTION public.request_bob_document_output(
  p_document_id uuid,
  p_document_version_id uuid,
  p_output_format text
)
RETURNS public.bob_generated_document_outputs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org_id uuid;
  v_status text;
  v_output public.bob_generated_document_outputs;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_output_format NOT IN ('pdf', 'docx', 'print') THEN RAISE EXCEPTION 'Unsupported output format'; END IF;

  SELECT d.organization_id, coalesce(dv.metadata_json->>'authoring_status', '')
  INTO v_org_id, v_status
  FROM public.documents d JOIN public.document_versions dv ON dv.document_id = d.id
  WHERE d.id = p_document_id AND dv.id = p_document_version_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Document version not found'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Document output request denied'; END IF;
  IF v_status <> 'approved' THEN RAISE EXCEPTION 'Only approved document versions can produce outputs'; END IF;

  INSERT INTO public.bob_generated_document_outputs (
    organization_id, document_id, document_version_id, output_format, requested_by, approved_by, approved_at
  ) VALUES (v_org_id, p_document_id, p_document_version_id, p_output_format, v_actor, v_actor, clock_timestamp())
  RETURNING * INTO v_output;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_actor, 'bob_document_output_requested', 'bob_generated_document_outputs', v_output.id,
    jsonb_build_object('document_id', p_document_id, 'document_version_id', p_document_version_id, 'output_format', p_output_format));
  RETURN v_output;
END;
$$;

REVOKE ALL ON FUNCTION public.request_bob_document_output(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_bob_document_output(uuid, uuid, text) TO authenticated, service_role;
