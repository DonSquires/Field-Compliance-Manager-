CREATE TABLE IF NOT EXISTS public.file_import_mapping_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES public.file_import_batches(id) ON DELETE CASCADE,
  source_column text NOT NULL,
  target_entity text,
  target_field text,
  decision text NOT NULL DEFAULT 'proposed' CHECK (decision IN ('proposed','confirmed','rejected')),
  review_reason text,
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, source_column)
);

ALTER TABLE public.file_import_mapping_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY file_import_mapping_reviews_select ON public.file_import_mapping_reviews
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());
REVOKE INSERT, UPDATE, DELETE ON public.file_import_mapping_reviews FROM anon, authenticated;
GRANT SELECT ON public.file_import_mapping_reviews TO authenticated;

CREATE OR REPLACE FUNCTION public.review_file_import_mapping(
  p_batch_id uuid,
  p_source_column text,
  p_target_entity text,
  p_target_field text,
  p_decision text,
  p_review_reason text
) RETURNS public.file_import_mapping_reviews
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_review public.file_import_mapping_reviews%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('proposed','confirmed','rejected') THEN RAISE EXCEPTION 'Invalid mapping decision'; END IF;
  IF nullif(trim(coalesce(p_source_column, '')), '') IS NULL THEN RAISE EXCEPTION 'Source column is required'; END IF;
  IF p_decision = 'confirmed' AND nullif(trim(coalesce(p_target_entity, '')), '') IS NULL THEN RAISE EXCEPTION 'Confirmed mappings require a target entity'; END IF;
  SELECT * INTO v_batch FROM public.file_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import batch not found'; END IF;
  IF NOT public.is_admin_for_org(v_batch.organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Mapping review denied'; END IF;
  INSERT INTO public.file_import_mapping_reviews(organization_id,batch_id,source_column,target_entity,target_field,decision,review_reason,reviewed_by,reviewed_at,updated_at)
  VALUES(v_batch.organization_id,p_batch_id,trim(p_source_column),nullif(trim(coalesce(p_target_entity,'')),''),nullif(trim(coalesce(p_target_field,'')),''),p_decision,nullif(trim(coalesce(p_review_reason,'')),''),v_actor,clock_timestamp(),clock_timestamp())
  ON CONFLICT(batch_id,source_column) DO UPDATE SET target_entity=excluded.target_entity,target_field=excluded.target_field,decision=excluded.decision,review_reason=excluded.review_reason,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at,updated_at=clock_timestamp()
  RETURNING * INTO v_review;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_batch.organization_id,v_actor,'file_import_mapping_reviewed','file_import_mapping_reviews',v_review.id,jsonb_build_object('batch_id',p_batch_id,'source_column',v_review.source_column,'target_entity',v_review.target_entity,'target_field',v_review.target_field,'decision',v_review.decision));
  RETURN v_review;
END;
$$;

REVOKE ALL ON FUNCTION public.review_file_import_mapping(uuid,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_file_import_mapping(uuid,text,text,text,text,text) TO authenticated, service_role;
