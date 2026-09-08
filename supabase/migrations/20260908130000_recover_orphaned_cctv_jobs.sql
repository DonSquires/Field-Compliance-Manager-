-- Processing rows without a lease are orphaned claims from pre-lease workers.
-- Treat them as recoverable so one stale worker cannot block the queue forever.
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
         error_message = 'Recovered after orphaned worker claim'
   WHERE domain = 'video_motion'
     AND status = 'processing'
     AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < clock_timestamp());
  GET DIAGNOSTICS recovered = ROW_COUNT;
  RETURN recovered;
END;
$$;