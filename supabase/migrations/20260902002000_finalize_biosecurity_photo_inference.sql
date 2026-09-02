CREATE OR REPLACE FUNCTION public.finalize_biosecurity_photo_inference(
  p_assessment_id uuid,
  p_actor_user_id uuid,
  p_photo jsonb,
  p_species_id text,
  p_confidence real,
  p_recommendation text,
  p_checklist jsonb
)
RETURNS public.biosecurity_assessments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_assessment public.biosecurity_assessments%rowtype;
  v_actor public.user_profiles%rowtype;
  v_storage_path text := p_photo ->> 'storage_path';
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO v_actor
  FROM public.user_profiles
  WHERE id = p_actor_user_id;

  IF NOT FOUND OR v_actor.role::text NOT IN ('grand_master', 'master', 'admin', 'admin_officer', 'officer') THEN
    RAISE EXCEPTION 'Authorized actor required';
  END IF;

  SELECT * INTO v_assessment
  FROM public.biosecurity_assessments
  WHERE id = p_assessment_id
  FOR UPDATE;

  IF NOT FOUND OR v_assessment.organization_id IS DISTINCT FROM v_actor.organization_id THEN
    RAISE EXCEPTION 'Assessment not found';
  END IF;
  IF v_actor.role::text = 'officer'
     AND v_assessment.officer_user_id IS DISTINCT FROM p_actor_user_id
     AND v_assessment.officer_id IS DISTINCT FROM p_actor_user_id THEN
    RAISE EXCEPTION 'Officer does not own assessment';
  END IF;
  IF jsonb_typeof(p_photo) IS DISTINCT FROM 'object'
     OR COALESCE(p_photo ->> 'id', '') = ''
     OR COALESCE(p_photo ->> 'storage_bucket', '') <> 'scans'
     OR v_storage_path NOT LIKE 'org/' || v_assessment.organization_id::text || '/biosecurity/' || v_assessment.id::text || '/%' THEN
    RAISE EXCEPTION 'Invalid evidence reference';
  END IF;
  IF p_confidence < 0 OR p_confidence > 1 OR p_confidence IS NULL THEN
    RAISE EXCEPTION 'Invalid inference confidence';
  END IF;
  IF jsonb_typeof(p_checklist) IS DISTINCT FROM 'object'
     OR COALESCE(p_checklist ->> 'photo_id', '') <> p_photo ->> 'id' THEN
    RAISE EXCEPTION 'Invalid inference checklist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_assessment.photo_urls, '[]'::jsonb)) AS existing_photo
    WHERE existing_photo ->> 'id' = p_photo ->> 'id'
  ) THEN
    RETURN v_assessment;
  END IF;

  UPDATE public.biosecurity_assessments
  SET photo_url = v_storage_path,
      photo_urls = COALESCE(photo_urls, '[]'::jsonb) || jsonb_build_array(p_photo),
      bob_species_id = NULLIF(BTRIM(p_species_id), ''),
      bob_confidence = p_confidence,
      bob_species_confirmed = false,
      bob_recommendation = NULLIF(BTRIM(p_recommendation), ''),
      bob_checklist = p_checklist
  WHERE id = v_assessment.id
  RETURNING * INTO v_assessment;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_assessment.organization_id,
    p_actor_user_id,
    'biosecurity.photo_classified',
    'biosecurity_assessments',
    v_assessment.id,
    jsonb_build_object(
      'photo_id', p_photo ->> 'id',
      'model', p_checklist ->> 'model',
      'confidence', p_confidence,
      'manual_review_required', COALESCE((p_checklist ->> 'manual_review_required')::boolean, true)
    )
  );

  RETURN v_assessment;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_biosecurity_photo_inference(uuid, uuid, jsonb, text, real, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_biosecurity_photo_inference(uuid, uuid, jsonb, text, real, text, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.finalize_biosecurity_photo_inference(uuid, uuid, jsonb, text, real, text, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_biosecurity_photo_inference(uuid, uuid, jsonb, text, real, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.finalize_biosecurity_photo_inference(uuid, uuid, jsonb, text, real, text, jsonb)
IS 'Atomically appends tenant-scoped biosecurity photo evidence, stores advisory inference, and writes its audit event. Service identity only; never confirms species.';