ALTER FUNCTION public.record_biosecurity_photo_perception_envelope(uuid, jsonb)
  RENAME TO record_biosecurity_photo_perception_envelope_v1_unchecked;

REVOKE ALL ON FUNCTION public.record_biosecurity_photo_perception_envelope_v1_unchecked(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_biosecurity_photo_perception_envelope(
  p_assessment_id uuid,
  p_classification jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_source_hash text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.biosecurity_assessments
    WHERE id = p_assessment_id
  ) THEN
    RAISE EXCEPTION 'Biosecurity assessment is missing';
  END IF;

  SELECT lower(coalesce(
    nullif(evidence.sha256_hash, ''),
    nullif(evidence.metadata->>'watermarked_sha256', '')
  ))
  INTO v_source_hash
  FROM public.biosecurity_assessment_evidence link
  JOIN public.evidence_items evidence
    ON evidence.id = link.evidence_item_id
   AND evidence.organization_id = link.organization_id
  WHERE link.biosecurity_assessment_id = p_assessment_id
  ORDER BY
    CASE WHEN link.purpose = 'primary_evidence' THEN 0 ELSE 1 END,
    link.ordinal,
    link.id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_evidence_link');
  END IF;
  IF (v_source_hash ~ '^[0-9a-f]{64}$') IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_source_hash');
  END IF;

  RETURN public.record_biosecurity_photo_perception_envelope_v1_unchecked(
    p_assessment_id,
    p_classification
  );
END;
$$;

COMMENT ON FUNCTION public.record_biosecurity_photo_perception_envelope(uuid, jsonb) IS
  'Service-only fail-closed custody gate for replay-safe biosecurity photo perception evidence.';

REVOKE ALL ON FUNCTION public.record_biosecurity_photo_perception_envelope(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_biosecurity_photo_perception_envelope(uuid, jsonb)
  TO service_role;