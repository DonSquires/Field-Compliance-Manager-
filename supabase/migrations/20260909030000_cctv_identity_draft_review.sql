CREATE TABLE IF NOT EXISTS public.cctv_identity_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  event_id text,
  event_type text NOT NULL CHECK (event_type IN ('video', 'vehicle', 'person', 'face', 'keyframe')),
  subject_kind text NOT NULL CHECK (subject_kind IN ('person', 'vehicle', 'location', 'entity', 'case')),
  proposed_person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  proposed_display_name text,
  candidate_matches jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('proposed', 'draft', 'approved', 'relocated', 'rejected', 'unresolved', 'escalated')) DEFAULT 'proposed',
  authority_level text NOT NULL CHECK (authority_level IN ('provisional', 'draft', 'approved')) DEFAULT 'provisional',
  final_action text CHECK (final_action IN ('approve_draft', 'create_new_record', 'match_existing', 'reject', 'relocate', 'manual_review')),
  final_person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  reason text CHECK (char_length(trim(reason)) BETWEEN 3 AND 2000),
  review_notes text CHECK (char_length(trim(review_notes)) BETWEEN 0 AND 2000),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  UNIQUE (inference_job_id, event_id, subject_kind)
);

ALTER TABLE public.cctv_identity_drafts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_identity_drafts_select ON public.cctv_identity_drafts;
DROP POLICY IF EXISTS cctv_identity_drafts_insert ON public.cctv_identity_drafts;
DROP POLICY IF EXISTS cctv_identity_drafts_update ON public.cctv_identity_drafts;

CREATE POLICY cctv_identity_drafts_select ON public.cctv_identity_drafts
  FOR SELECT USING (public.org_access_allowed(organization_id));

CREATE POLICY cctv_identity_drafts_insert ON public.cctv_identity_drafts
  FOR INSERT WITH CHECK (
    public.org_access_allowed(organization_id)
    AND created_by = auth.uid()
  );

CREATE POLICY cctv_identity_drafts_update ON public.cctv_identity_drafts
  FOR UPDATE USING (public.org_access_allowed(organization_id))
  WITH CHECK (public.org_access_allowed(organization_id));

CREATE OR REPLACE FUNCTION public.record_cctv_identity_draft(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_event_id text,
  p_event_type text,
  p_subject_kind text,
  p_proposed_person_record_id uuid,
  p_proposed_display_name text,
  p_candidate_matches jsonb DEFAULT '[]'::jsonb,
  p_reason text DEFAULT NULL
)
RETURNS public.cctv_identity_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  draft_row public.cctv_identity_drafts;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'CCTV identity draft access denied';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
    WHERE id = p_job_id
      AND evidence_item_id = p_evidence_id
      AND organization_id = p_organization_id
      AND domain IN ('video_motion', 'vehicle', 'face')
  ) THEN
    RAISE EXCEPTION 'CCTV inference job is missing or outside the organization';
  END IF;

  IF jsonb_typeof(COALESCE(p_candidate_matches, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Candidate matches must be an array';
  END IF;

  IF p_event_type NOT IN ('video', 'vehicle', 'person', 'face', 'keyframe') THEN
    RAISE EXCEPTION 'Invalid CCTV event type';
  END IF;

  IF p_subject_kind NOT IN ('person', 'vehicle', 'location', 'entity', 'case') THEN
    RAISE EXCEPTION 'Invalid subject kind';
  END IF;

  IF p_proposed_person_record_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.person_records pr
      WHERE pr.id = p_proposed_person_record_id AND pr.organization_id = p_organization_id
    ) THEN
      RAISE EXCEPTION 'Proposed person record is not in the organization';
    END IF;
  END IF;

  INSERT INTO public.cctv_identity_drafts (
    organization_id,
    inference_job_id,
    evidence_item_id,
    event_id,
    event_type,
    subject_kind,
    proposed_person_record_id,
    proposed_display_name,
    candidate_matches,
    status,
    authority_level,
    reason,
    created_by,
    updated_at
  ) VALUES (
    p_organization_id,
    p_job_id,
    p_evidence_id,
    NULLIF(trim(p_event_id), ''),
    p_event_type,
    p_subject_kind,
    p_proposed_person_record_id,
    NULLIF(trim(p_proposed_display_name), ''),
    COALESCE(p_candidate_matches, '[]'::jsonb),
    'draft',
    'draft',
    NULLIF(trim(p_reason), ''),
    auth.uid(),
    clock_timestamp()
  )
  ON CONFLICT (inference_job_id, event_id, subject_kind)
  DO UPDATE SET
    proposed_person_record_id = EXCLUDED.proposed_person_record_id,
    proposed_display_name = EXCLUDED.proposed_display_name,
    candidate_matches = EXCLUDED.candidate_matches,
    status = 'draft',
    authority_level = 'draft',
    reason = EXCLUDED.reason,
    updated_at = clock_timestamp(),
    approved_by = NULL,
    approved_at = NULL
  RETURNING * INTO draft_row;

  RETURN draft_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_cctv_identity_draft(
  p_draft_id uuid,
  p_final_action text,
  p_final_person_record_id uuid DEFAULT NULL,
  p_review_notes text DEFAULT NULL
)
RETURNS public.cctv_identity_drafts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  draft_row public.cctv_identity_drafts;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'User must be authenticated to approve a draft identity';
  END IF;

  SELECT * INTO draft_row
    FROM public.cctv_identity_drafts
   WHERE id = p_draft_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Identity draft not found';
  END IF;

  IF NOT public.org_access_allowed(draft_row.organization_id) THEN
    RAISE EXCEPTION 'Identity draft access denied';
  END IF;

  IF p_final_action NOT IN ('approve_draft', 'create_new_record', 'match_existing', 'reject', 'relocate', 'manual_review') THEN
    RAISE EXCEPTION 'Invalid final action';
  END IF;

  IF p_final_action IN ('match_existing', 'relocate', 'approve_draft') AND p_final_person_record_id IS NULL THEN
    RAISE EXCEPTION 'Final person record is required for an identity action';
  END IF;

  IF p_final_person_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.person_records
    WHERE id = p_final_person_record_id
      AND organization_id = draft_row.organization_id
  ) THEN
    RAISE EXCEPTION 'Final person record is not in the draft organization';
  END IF;

  IF p_final_action = 'create_new_record' THEN
    RAISE EXCEPTION 'Create the new canonical record before approving this draft';
  END IF;

  UPDATE public.cctv_identity_drafts
     SET status = CASE
       WHEN p_final_action = 'reject' THEN 'rejected'
       WHEN p_final_action = 'manual_review' THEN 'escalated'
       WHEN p_final_action = 'relocate' THEN 'relocated'
       WHEN p_final_action = 'create_new_record' THEN 'approved'
       WHEN p_final_action = 'match_existing' THEN 'approved'
       WHEN p_final_action = 'approve_draft' THEN 'approved'
       ELSE 'draft'
     END,
     authority_level = CASE
       WHEN p_final_action = 'reject' THEN 'provisional'
       ELSE 'approved'
     END,
     final_action = p_final_action,
     final_person_record_id = p_final_person_record_id,
     review_notes = NULLIF(trim(p_review_notes), ''),
     approved_by = auth.uid(),
     approved_at = clock_timestamp(),
     updated_at = clock_timestamp()
   WHERE id = p_draft_id
   RETURNING * INTO draft_row;

  RETURN draft_row;
END;
$$;

REVOKE ALL ON FUNCTION public.record_cctv_identity_draft(uuid, uuid, uuid, text, text, text, uuid, text, jsonb, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_identity_draft(uuid, uuid, uuid, text, text, text, uuid, text, jsonb, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.approve_cctv_identity_draft(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_cctv_identity_draft(uuid, text, uuid, text) TO authenticated, service_role;
