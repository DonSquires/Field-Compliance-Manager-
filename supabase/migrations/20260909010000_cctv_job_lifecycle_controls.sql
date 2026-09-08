ALTER TABLE public.inference_jobs
  DROP CONSTRAINT IF EXISTS inference_jobs_status_check;

ALTER TABLE public.inference_jobs
  ADD CONSTRAINT inference_jobs_status_check CHECK (
    status = ANY (ARRAY[
      'queued'::text,
      'processing'::text,
      'complete'::text,
      'inconclusive'::text,
      'manual_review_required'::text,
      'failed'::text,
      'cancelled'::text,
      'archived'::text
    ])
  );

CREATE OR REPLACE FUNCTION public.manage_cctv_inference_job(
  p_job_id uuid,
  p_organization_id uuid,
  p_action text
)
RETURNS TABLE (job_id uuid, action text, new_status text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job public.inference_jobs%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'CCTV job access denied';
  END IF;

  SELECT * INTO v_job
    FROM public.inference_jobs
   WHERE id = p_job_id
     AND organization_id = p_organization_id
     AND domain = 'video_motion'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CCTV job not found';
  END IF;

  IF p_action = 'retry' THEN
    IF v_job.status NOT IN ('failed', 'inconclusive', 'manual_review_required') THEN
      RAISE EXCEPTION 'Only failed or reviewable CCTV jobs can be retried';
    END IF;
    UPDATE public.inference_jobs
       SET status = 'queued', completed_at = NULL, created_at = clock_timestamp()
     WHERE id = v_job.id;
    RETURN QUERY SELECT v_job.id, p_action, 'queued'::text;
    RETURN;
  END IF;

  IF p_action = 'cancel' THEN
    IF v_job.status NOT IN ('queued', 'processing') THEN
      RAISE EXCEPTION 'Only queued or processing CCTV jobs can be cancelled';
    END IF;
    UPDATE public.inference_jobs
       SET status = 'cancelled', completed_at = clock_timestamp()
     WHERE id = v_job.id;
    RETURN QUERY SELECT v_job.id, p_action, 'cancelled'::text;
    RETURN;
  END IF;

  IF p_action = 'archive' THEN
    IF v_job.status IN ('queued', 'processing') THEN
      RAISE EXCEPTION 'Running CCTV jobs must be cancelled before archiving';
    END IF;
    UPDATE public.inference_jobs
       SET status = 'archived', completed_at = COALESCE(completed_at, clock_timestamp())
     WHERE id = v_job.id;
    RETURN QUERY SELECT v_job.id, p_action, 'archived'::text;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Unsupported CCTV job action';
END;
$$;

REVOKE ALL ON FUNCTION public.manage_cctv_inference_job(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_cctv_inference_job(uuid, uuid, text) TO authenticated, service_role;
