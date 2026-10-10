ALTER FUNCTION public.record_perception_evidence_envelope(uuid, text, jsonb)
  RENAME TO record_perception_evidence_envelope_unchecked;

REVOKE ALL ON FUNCTION public.record_perception_evidence_envelope_unchecked(uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_perception_evidence_envelope(
  p_attachment_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_payload->'fields') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_payload->'fields') = 0 THEN
    RAISE EXCEPTION 'Perception payload requires a non-empty fields array';
  END IF;
  RETURN public.record_perception_evidence_envelope_unchecked(
    p_attachment_id,
    p_idempotency_key,
    p_payload
  );
END;
$$;

COMMENT ON FUNCTION public.record_perception_evidence_envelope_unchecked(uuid,text,jsonb) IS
  'Internal service-gated implementation. Invoke record_perception_evidence_envelope so payload shape is validated first.';
COMMENT ON FUNCTION public.record_perception_evidence_envelope(uuid,text,jsonb) IS
  'Service-only replay-safe writer. Rejects missing or empty field candidates before invoking the internal recorder.';

REVOKE ALL ON FUNCTION public.record_perception_evidence_envelope(uuid,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_perception_evidence_envelope(uuid,text,jsonb)
  TO service_role;