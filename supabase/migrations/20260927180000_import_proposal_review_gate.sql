-- Batch approval is the final review acknowledgement, not an apply action.
-- It must not bypass unresolved column mappings or consequential row proposals.
CREATE OR REPLACE FUNCTION public.review_file_import_batch(
  p_batch_id uuid,
  p_decision text,
  p_reason text
) RETURNS public.file_import_batches
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_batch public.file_import_batches%rowtype;
  v_expected_proposals integer;
  v_actual_proposals integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Decision must be approved or rejected'; END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Review reason is required'; END IF;

  SELECT * INTO v_batch FROM public.file_import_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import batch not found'; END IF;
  IF NOT public.is_admin_for_org(v_batch.organization_id) AND NOT public.is_grand_master() THEN RAISE EXCEPTION 'Import batch review denied'; END IF;
  IF v_batch.status NOT IN ('preview', 'needs_review') THEN RAISE EXCEPTION 'Only preview batches can be reviewed'; END IF;

  IF p_decision = 'approved' THEN
    IF EXISTS (
      SELECT 1 FROM public.file_import_mapping_reviews
      WHERE batch_id = v_batch.id AND decision = 'proposed'
    ) THEN
      RAISE EXCEPTION 'Every proposed column mapping must be confirmed or rejected before batch approval';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.file_import_row_proposals
      WHERE batch_id = v_batch.id AND status = 'proposed'
    ) THEN
      RAISE EXCEPTION 'Every row proposal must be approved or rejected before batch approval';
    END IF;

    IF v_batch.manifest_json->'receipt' ? 'proposal_candidates' THEN
      v_expected_proposals := (v_batch.manifest_json->'receipt'->>'proposal_candidates')::integer;
      SELECT count(*)::integer INTO v_actual_proposals
      FROM public.file_import_row_proposals
      WHERE batch_id = v_batch.id;
      IF v_actual_proposals <> v_expected_proposals THEN
        RAISE EXCEPTION 'Proposal staging is incomplete: expected %, found %', v_expected_proposals, v_actual_proposals;
      END IF;
    END IF;
  END IF;

  UPDATE public.file_import_batches
  SET status = p_decision,
      reviewed_by = v_actor,
      reviewed_at = clock_timestamp(),
      review_reason = trim(p_reason),
      updated_at = clock_timestamp()
  WHERE id = v_batch.id
  RETURNING * INTO v_batch;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_batch.organization_id,
    v_actor,
    'file_import_batch_reviewed',
    'file_import_batches',
    v_batch.id,
    jsonb_build_object('decision', p_decision, 'reason', trim(p_reason), 'source_file', v_batch.source_file)
  );
  RETURN v_batch;
END;
$function$;

REVOKE ALL ON FUNCTION public.review_file_import_batch(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_file_import_batch(uuid, text, text) TO postgres, authenticated, service_role;
;
