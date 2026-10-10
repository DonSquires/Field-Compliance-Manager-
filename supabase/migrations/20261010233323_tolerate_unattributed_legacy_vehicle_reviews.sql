ALTER FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception(uuid)
  RENAME TO apply_cctv_vehicle_attribute_review_to_perception_unchecked;

REVOKE ALL ON FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception_unchecked(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception(p_observation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_review jsonb;
BEGIN
  SELECT attributes->'make_model_review'
  INTO v_review
  FROM public.cctv_entity_observations
  WHERE id = p_observation_id
    AND entity_kind = 'vehicle';

  IF jsonb_typeof(v_review) IS DISTINCT FROM 'object'
     OR v_review->>'status' NOT IN ('confirmed','corrected','rejected')
     OR nullif(v_review->>'reviewed_by', '') IS NULL THEN
    RETURN;
  END IF;

  PERFORM public.apply_cctv_vehicle_attribute_review_to_perception_unchecked(p_observation_id);
END;
$$;

COMMENT ON FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception(uuid) IS
  'Fail-closed wrapper that ignores absent or unattributed legacy review metadata instead of blocking candidate receipt creation.';
REVOKE ALL ON FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception(uuid)
  FROM PUBLIC, anon, authenticated, service_role;