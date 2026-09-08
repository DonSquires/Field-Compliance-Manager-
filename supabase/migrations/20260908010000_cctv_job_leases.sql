ALTER TABLE public.inference_jobs
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS error_message text;

CREATE INDEX IF NOT EXISTS inference_jobs_video_motion_queue_idx
  ON public.inference_jobs (domain, status, created_at);

CREATE OR REPLACE FUNCTION public.claim_cctv_inference_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer DEFAULT 900
)
RETURNS TABLE (id uuid, organization_id uuid, evidence_item_id uuid, domain text, status text, lease_token uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_lease_seconds NOT BETWEEN 60 AND 7200 THEN
    RAISE EXCEPTION 'Valid job, lease, and lease duration are required';
  END IF;

  RETURN QUERY
  UPDATE public.inference_jobs j
     SET status = 'processing', stage = 'claimed', attempt_count = j.attempt_count + 1,
         lease_token = p_lease_token, lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         heartbeat_at = clock_timestamp(), error_message = NULL
   WHERE j.id = p_job_id AND j.domain = 'video_motion' AND j.status = 'queued'
   RETURNING j.id, j.organization_id, j.evidence_item_id, j.domain, j.status, j.lease_token;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_stale_cctv_inference_jobs()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE recovered integer;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  UPDATE public.inference_jobs
     SET status = 'queued', stage = 'queued', lease_token = NULL,
         lease_expires_at = NULL, heartbeat_at = NULL,
         error_message = 'Recovered after worker lease expiry'
   WHERE domain = 'video_motion'
     AND status = 'processing'
     AND lease_expires_at IS NOT NULL
     AND lease_expires_at < clock_timestamp();
  GET DIAGNOSTICS recovered = ROW_COUNT;
  RETURN recovered;
END;
$$;

CREATE OR REPLACE FUNCTION public.heartbeat_cctv_inference_job(
  p_job_id uuid,
  p_lease_token uuid,
  p_stage text,
  p_lease_seconds integer DEFAULT 900
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  UPDATE public.inference_jobs
     SET stage = COALESCE(NULLIF(trim(p_stage), ''), stage), heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   WHERE id = p_job_id AND status = 'processing' AND lease_token = p_lease_token;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_cctv_inference_job(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recover_stale_cctv_inference_jobs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_cctv_inference_job(uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_cctv_inference_job(uuid, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.recover_stale_cctv_inference_jobs() TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_cctv_inference_job(uuid, uuid, text, integer) TO service_role;

COMMENT ON COLUMN public.inference_jobs.stage IS 'Durable CCTV processing stage for operator progress and recovery.';
COMMENT ON COLUMN public.inference_jobs.error_message IS 'Last bounded worker error for retry triage.';