-- Service-only writer for AI-generated CCTV scene synopses (self-hosted vision-LLM, unverified draft).
-- Reuses evidence_summary_approvals rather than adding a parallel table: that table has existed in schema
-- since before this session but was never wired to any writer (owner ruling 2026-09-22 - the "AI draft
-- pending human review" approval lifecycle it already models is exactly this shape). One synopsis per
-- evidence item; a re-run replaces the draft only while it remains unreviewed (generated_review_status IS
-- NULL), same "don't clobber a human decision" guard record_cctv_entity_observations already uses.
CREATE OR REPLACE FUNCTION public.record_cctv_scene_synopsis(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_summary text,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_id uuid;
  v_metadata jsonb := CASE WHEN jsonb_typeof(p_metadata) = 'object' THEN p_metadata ELSE '{}'::jsonb END;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF NULLIF(trim(p_summary), '') IS NULL THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
     WHERE id = p_job_id AND evidence_item_id = p_evidence_id AND organization_id = p_organization_id AND domain = 'video_motion'
  ) THEN
    RAISE EXCEPTION 'CCTV inference job is missing or outside the organization';
  END IF;

  SELECT id INTO v_id
    FROM public.evidence_summary_approvals
   WHERE evidence_id = p_evidence_id
     AND generated_mode = 'cctv_vision_llm_scene_synopsis'
     AND generated_review_status IS NULL
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    UPDATE public.evidence_summary_approvals
       SET generated_summary = trim(p_summary),
           generated_metadata = v_metadata,
           generated_at = clock_timestamp()
     WHERE id = v_id;
  ELSE
    INSERT INTO public.evidence_summary_approvals (
      organization_id, evidence_id, approval_status, generated_summary, generated_mode, generated_metadata, generated_at
    ) VALUES (
      p_organization_id, p_evidence_id, 'pending', trim(p_summary), 'cctv_vision_llm_scene_synopsis', v_metadata, clock_timestamp()
    ) RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.record_cctv_scene_synopsis(uuid, uuid, uuid, text, jsonb) IS
  'Service-only CCTV writer. Stores an unverified vision-LLM scene synopsis as a pending evidence_summary_approvals row (generated_mode = cctv_vision_llm_scene_synopsis); a human must review it before it is relied on as fact.';

REVOKE ALL ON FUNCTION public.record_cctv_scene_synopsis(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_cctv_scene_synopsis(uuid, uuid, uuid, text, jsonb) TO postgres;
GRANT EXECUTE ON FUNCTION public.record_cctv_scene_synopsis(uuid, uuid, uuid, text, jsonb) TO service_role;

-- Read path: an org member may see the draft/approval row for evidence in their own organization. Writes to
-- approval_status/generated_review_status stay a separate follow-up RPC (out of scope for this migration).
DROP POLICY IF EXISTS esa_org_select ON public.evidence_summary_approvals;
CREATE POLICY esa_org_select ON public.evidence_summary_approvals
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));
