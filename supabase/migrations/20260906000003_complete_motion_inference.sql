CREATE OR REPLACE FUNCTION public.complete_motion_inference(
  p_job_id uuid,
  p_evidence_id uuid,
  p_org_id uuid,
  p_motion_result jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result_id uuid;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_job_id IS NULL OR p_evidence_id IS NULL OR p_org_id IS NULL OR p_motion_result IS NULL THEN
    RAISE EXCEPTION 'Job, evidence, organization, and motion result are required';
  END IF;
  IF jsonb_typeof(p_motion_result) <> 'object'
     OR jsonb_typeof(p_motion_result->'motion_segments') <> 'array' THEN
    RAISE EXCEPTION 'Motion result must contain a motion_segments array';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.inference_jobs
     WHERE id = p_job_id
       AND evidence_item_id = p_evidence_id
       AND organization_id = p_org_id
       AND domain = 'video_motion'
       AND status = 'processing'
  ) THEN
    RAISE EXCEPTION 'Inference job is missing, mismatched, or not processing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.evidence_items
     WHERE id = p_evidence_id
       AND organization_id = p_org_id
       AND evidence_kind = 'video'
  ) THEN
    RAISE EXCEPTION 'Video evidence is missing or belongs to another organization';
  END IF;

  INSERT INTO public.inference_results (
    inference_job_id,
    evidence_item_id,
    domain,
    status,
    result
  ) VALUES (
    p_job_id,
    p_evidence_id,
    'video_motion',
    'complete',
    p_motion_result
  ) RETURNING id INTO result_id;

  UPDATE public.inference_jobs
     SET status = 'complete', completed_at = clock_timestamp()
   WHERE id = p_job_id
     AND status = 'processing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inference job changed before completion';
  END IF;
  RETURN result_id;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_motion_inference(uuid, uuid, uuid, jsonb) TO service_role;