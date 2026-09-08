CREATE TABLE IF NOT EXISTS public.cctv_review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  event_id text,
  event_type text NOT NULL CHECK (event_type IN ('video', 'vehicle', 'person', 'face', 'keyframe')),
  decision text NOT NULL CHECK (decision IN ('confirmed', 'dismissed')),
  reason text NOT NULL CHECK (char_length(trim(reason)) BETWEEN 3 AND 1000),
  decided_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (inference_job_id, event_id)
);

ALTER TABLE public.cctv_review_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cctv_review_decisions_select ON public.cctv_review_decisions FOR SELECT USING (public.org_access_allowed(organization_id));
CREATE POLICY cctv_review_decisions_insert ON public.cctv_review_decisions FOR INSERT WITH CHECK (public.org_access_allowed(organization_id) AND decided_by = auth.uid());

CREATE OR REPLACE FUNCTION public.record_cctv_review_decision(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_event_id text,
  p_event_type text,
  p_decision text,
  p_reason text
)
RETURNS public.cctv_review_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result public.cctv_review_decisions;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN RAISE EXCEPTION 'CCTV review access denied'; END IF;
  IF p_decision NOT IN ('confirmed', 'dismissed') OR p_event_type NOT IN ('video', 'vehicle', 'person', 'face', 'keyframe') THEN RAISE EXCEPTION 'Invalid CCTV review decision'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.inference_jobs WHERE id = p_job_id AND evidence_item_id = p_evidence_id AND organization_id = p_organization_id AND domain = 'video_motion') THEN RAISE EXCEPTION 'CCTV job not found'; END IF;
  INSERT INTO public.cctv_review_decisions (organization_id, inference_job_id, evidence_item_id, event_id, event_type, decision, reason, decided_by)
  VALUES (p_organization_id, p_job_id, p_evidence_id, NULLIF(trim(p_event_id), ''), p_event_type, p_decision, trim(p_reason), auth.uid())
  ON CONFLICT (inference_job_id, event_id) DO UPDATE SET decision = EXCLUDED.decision, reason = EXCLUDED.reason, decided_by = EXCLUDED.decided_by, decided_at = clock_timestamp()
  RETURNING * INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.record_cctv_review_decision(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cctv_review_decision(uuid, uuid, uuid, text, text, text, text) TO authenticated, service_role;