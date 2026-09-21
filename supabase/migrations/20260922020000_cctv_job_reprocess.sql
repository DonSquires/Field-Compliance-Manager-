-- Adds the ability to reprocess a COMPLETED CCTV job with the current inference code, distinct from
-- 'retry' (which only ever applied to failed/inconclusive/manual_review_required jobs - see the guard
-- below, unchanged). Requested after a live false-positive vehicle detection (an archery target and a
-- bin misread as "red truck"/"red car" at 74-92% confidence) prompted "did this run before a recent
-- detector fix, and would re-running with today's code do better".
--
-- Safety: only observations the AI produced that no human has yet acted on (review_state = 'unreviewed')
-- are cleared before the job re-runs. Anything a reviewer already accepted, rejected, linked, or
-- confirmed/corrected is left completely alone - re-running inference must never silently undo a human
-- decision. cctv_scene_synopsis already upserts onto the same evidence_id + generated_mode while
-- generated_review_status IS NULL, so a fresh synopsis naturally replaces the old one without any
-- cleanup needed here.
CREATE OR REPLACE FUNCTION "public"."manage_cctv_inference_job"(p_job_id uuid, p_organization_id uuid, p_action text)
 RETURNS TABLE(job_id uuid, action text, new_status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  IF p_action = 'reprocess' THEN
    IF v_job.status <> 'complete' THEN
      RAISE EXCEPTION 'Only a completed CCTV job can be reprocessed';
    END IF;
    DELETE FROM public.cctv_entity_observations
     WHERE inference_job_id = v_job.id AND review_state = 'unreviewed';
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

  IF p_action = 'close' THEN
    IF v_job.status NOT IN ('failed', 'inconclusive', 'manual_review_required') THEN
      RAISE EXCEPTION 'Only failed or reviewable CCTV jobs can be closed';
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

  IF p_action = 'delete' THEN
    IF v_job.status NOT IN ('failed', 'inconclusive', 'cancelled', 'archived') THEN
      RAISE EXCEPTION 'Only terminal CCTV jobs can be deleted';
    END IF;
    DELETE FROM public.inference_jobs WHERE id = v_job.id;
    RETURN QUERY SELECT v_job.id, p_action, 'deleted'::text;
    RETURN;
  END IF;

  RAISE EXCEPTION 'Unsupported CCTV job action';
END;
$function$;
REVOKE ALL ON FUNCTION "public"."manage_cctv_inference_job"(p_job_id uuid, p_organization_id uuid, p_action text) FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."manage_cctv_inference_job"(p_job_id uuid, p_organization_id uuid, p_action text) TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."manage_cctv_inference_job"(p_job_id uuid, p_organization_id uuid, p_action text) TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."manage_cctv_inference_job"(p_job_id uuid, p_organization_id uuid, p_action text) TO "service_role";
