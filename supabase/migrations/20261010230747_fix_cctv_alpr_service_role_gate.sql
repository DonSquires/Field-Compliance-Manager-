ALTER FUNCTION public.record_cctv_alpr_perception_envelopes(uuid)
  RENAME TO record_cctv_alpr_perception_envelopes_unchecked;

REVOKE ALL ON FUNCTION public.record_cctv_alpr_perception_envelopes_unchecked(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_cctv_alpr_perception_envelopes(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  RETURN public.record_cctv_alpr_perception_envelopes_unchecked(p_job_id);
END;
$$;

COMMENT ON FUNCTION public.record_cctv_alpr_perception_envelopes_unchecked(uuid) IS
  'Internal CCTV ALPR envelope compiler. Invocation is restricted to the service-gated wrapper.';
COMMENT ON FUNCTION public.record_cctv_alpr_perception_envelopes(uuid) IS
  'Service-only replay-safe projection of CCTV ALPR observations and source/enhanced derivative receipts into the shared perception evidence spine.';
REVOKE ALL ON FUNCTION public.record_cctv_alpr_perception_envelopes(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_alpr_perception_envelopes(uuid)
  TO service_role;