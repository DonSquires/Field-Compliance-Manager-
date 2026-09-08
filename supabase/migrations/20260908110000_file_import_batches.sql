-- Persist staged CSV/XLSX previews as review-only import batches.
-- Domain tables remain untouched until a later approved command applies a batch.

CREATE TABLE IF NOT EXISTS public.file_import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  batch_name text NOT NULL,
  source_file text NOT NULL,
  source_sha256 text,
  duplicate_of_batch_id uuid REFERENCES public.file_import_batches(id) ON DELETE SET NULL,
  parser text NOT NULL,
  status text NOT NULL DEFAULT 'preview',
  manifest_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  row_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  unresolved_count integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT file_import_batches_status_check CHECK (status IN ('preview','needs_review','approved','rejected','applied','failed')),
  CONSTRAINT file_import_batches_counts_check CHECK (row_count >= 0 AND duplicate_count >= 0 AND unresolved_count >= 0)
);

CREATE INDEX IF NOT EXISTS file_import_batches_org_status
  ON public.file_import_batches (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS file_import_batches_source_hash
  ON public.file_import_batches (organization_id, source_sha256)
  WHERE source_sha256 IS NOT NULL;

ALTER TABLE public.file_import_batches ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_import_batches_select ON public.file_import_batches
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());
REVOKE INSERT, UPDATE, DELETE ON public.file_import_batches FROM anon, authenticated;
GRANT SELECT ON public.file_import_batches TO authenticated;

CREATE OR REPLACE FUNCTION public.create_file_import_batch(
  p_batch_name text,
  p_source_file text,
  p_source_sha256 text,
  p_parser text,
  p_manifest_json jsonb DEFAULT '{}'::jsonb,
  p_schema_json jsonb DEFAULT '{}'::jsonb,
  p_row_count integer DEFAULT 0,
  p_duplicate_count integer DEFAULT 0,
  p_unresolved_count integer DEFAULT 0,
  p_organization_id uuid DEFAULT NULL
) RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org_id uuid := p_organization_id;
  v_batch public.file_import_batches%rowtype;
  v_duplicate_of uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Organisation is required'; END IF;
  IF NOT public.is_admin_for_org(v_org_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Import batch creation denied'; END IF;
  IF nullif(trim(coalesce(p_batch_name, '')), '') IS NULL OR nullif(trim(coalesce(p_source_file, '')), '') IS NULL THEN RAISE EXCEPTION 'Batch name and source file are required'; END IF;
  IF p_row_count < 0 OR p_duplicate_count < 0 OR p_unresolved_count < 0 THEN RAISE EXCEPTION 'Import counts cannot be negative'; END IF;
  IF nullif(trim(coalesce(p_source_sha256, '')), '') IS NOT NULL THEN
    SELECT id INTO v_duplicate_of
    FROM public.file_import_batches
    WHERE organization_id = v_org_id AND source_sha256 = trim(p_source_sha256)
    ORDER BY created_at ASC
    LIMIT 1;
  END IF;
  INSERT INTO public.file_import_batches (
    organization_id, batch_name, source_file, source_sha256, duplicate_of_batch_id, parser,
    manifest_json, schema_json, row_count, duplicate_count, unresolved_count, created_by
  ) VALUES (
    v_org_id, trim(p_batch_name), trim(p_source_file), nullif(trim(coalesce(p_source_sha256, '')), ''), v_duplicate_of, trim(p_parser),
    coalesce(p_manifest_json, '{}'::jsonb), coalesce(p_schema_json, '{}'::jsonb),
    p_row_count, p_duplicate_count, p_unresolved_count, v_actor
  ) RETURNING * INTO v_batch;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_actor, 'file_import_batch_created', 'file_import_batches', v_batch.id,
    jsonb_build_object('source_file', v_batch.source_file, 'parser', v_batch.parser, 'row_count', v_batch.row_count, 'duplicate_count', v_batch.duplicate_count, 'unresolved_count', v_batch.unresolved_count, 'duplicate_of_batch_id', v_batch.duplicate_of_batch_id));
  RETURN v_batch;
END;
$$;

REVOKE ALL ON FUNCTION public.create_file_import_batch(text, text, text, text, jsonb, jsonb, integer, integer, integer, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_file_import_batch(text, text, text, text, jsonb, jsonb, integer, integer, integer, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_file_import_batch(
  p_batch_id uuid,
  p_decision text,
  p_reason text
) RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_batch public.file_import_batches%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import batch not found'; END IF;
  IF NOT public.is_admin_for_org(v_batch.organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Import batch review denied'; END IF;
  IF v_batch.status NOT IN ('preview', 'needs_review') THEN RAISE EXCEPTION 'Only preview batches can be reviewed'; END IF;
  UPDATE public.file_import_batches
  SET status = p_decision, reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_reason = trim(p_reason), updated_at = clock_timestamp()
  WHERE id = v_batch.id
  RETURNING * INTO v_batch;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_batch.organization_id, v_actor, 'file_import_batch_reviewed', 'file_import_batches', v_batch.id,
    jsonb_build_object('decision', p_decision, 'reason', trim(p_reason), 'source_file', v_batch.source_file));
  RETURN v_batch;
END;
$$;

REVOKE ALL ON FUNCTION public.review_file_import_batch(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_file_import_batch(uuid, text, text) TO authenticated, service_role;
