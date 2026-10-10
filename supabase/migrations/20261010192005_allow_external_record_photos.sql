BEGIN;

CREATE OR REPLACE FUNCTION public.tg_seal_verified_photo_evidence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_raw_hash text := new.metadata->>'raw_sha256';
  v_watermarked_hash text := new.metadata->>'watermarked_sha256';
BEGIN
  IF new.evidence_kind <> 'photo' OR new.module_key = 'cctv_review' THEN
    RETURN new;
  END IF;

  IF new.module_key = 'record_review'
     AND new.metadata->>'provenance' = 'external' THEN
    new.is_court_ready := false;
    new.locked_at := NULL;
    RETURN new;
  END IF;

  IF coalesce(new.metadata->>'watermark_text', '') = ''
    OR coalesce(new.metadata->>'watermark_service', '') <> 'inference'
    OR v_raw_hash !~ '^[0-9a-f]{64}$'
    OR v_watermarked_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Court photo evidence requires inference watermark provenance and SHA-256 hashes';
  END IF;

  new.sha256_hash := v_watermarked_hash;
  new.is_court_ready := true;
  new.locked_at := coalesce(new.locked_at, clock_timestamp());
  RETURN new;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_seal_verified_photo_evidence()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tg_seal_verified_photo_evidence()
  TO postgres;

COMMIT;