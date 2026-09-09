CREATE TABLE IF NOT EXISTS public.cctv_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  source_event_id text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('video', 'vehicle', 'person', 'face', 'keyframe')),
  observed_from_seconds numeric,
  observed_to_seconds numeric,
  model_confidence real CHECK (model_confidence IS NULL OR (model_confidence >= 0 AND model_confidence <= 1)),
  confidence_override real CHECK (confidence_override IS NULL OR (confidence_override >= 0 AND confidence_override <= 1)),
  candidate_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_state text NOT NULL CHECK (review_state IN ('unreviewed', 'accepted', 'rejected', 'uncertain', 'needs_more_context', 'superseded')) DEFAULT 'unreviewed',
  reviewer_notes text,
  linked_person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  linked_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  linked_incident_id uuid REFERENCES public.incidents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (inference_job_id, source_event_id, event_type),
  CHECK (observed_to_seconds IS NULL OR observed_from_seconds IS NULL OR observed_to_seconds >= observed_from_seconds)
);

COMMENT ON TABLE public.cctv_review_events IS
  'Canonical human review state for CCTV inference events. Model output remains non-authoritative until an accepted state and explicit link are recorded.';

CREATE TABLE IF NOT EXISTS public.cctv_review_event_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  review_event_id uuid NOT NULL REFERENCES public.cctv_review_events(id) ON DELETE CASCADE,
  previous_state text,
  next_state text NOT NULL CHECK (next_state IN ('unreviewed', 'accepted', 'rejected', 'uncertain', 'needs_more_context', 'superseded')),
  reviewer_notes text,
  confidence_override real CHECK (confidence_override IS NULL OR (confidence_override >= 0 AND confidence_override <= 1)),
  linked_person_record_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  linked_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  linked_incident_id uuid REFERENCES public.incidents(id) ON DELETE SET NULL,
  decided_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.cctv_review_event_decisions IS
  'Append-only history of CCTV human review decisions and canonical links.';

CREATE INDEX IF NOT EXISTS idx_cctv_review_events_scope_state
  ON public.cctv_review_events (organization_id, review_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cctv_review_events_source
  ON public.cctv_review_events (organization_id, evidence_item_id, source_event_id);
CREATE INDEX IF NOT EXISTS idx_cctv_review_event_decisions_event
  ON public.cctv_review_event_decisions (organization_id, review_event_id, decided_at DESC);

ALTER TABLE public.cctv_review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cctv_review_event_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cctv_review_events_select ON public.cctv_review_events;
CREATE POLICY cctv_review_events_select ON public.cctv_review_events
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
DROP POLICY IF EXISTS cctv_review_event_decisions_select ON public.cctv_review_event_decisions;
CREATE POLICY cctv_review_event_decisions_select ON public.cctv_review_event_decisions
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.cctv_review_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cctv_review_events TO authenticated;
GRANT ALL ON TABLE public.cctv_review_events TO service_role;
REVOKE ALL ON TABLE public.cctv_review_event_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.cctv_review_event_decisions TO authenticated;
GRANT ALL ON TABLE public.cctv_review_event_decisions TO service_role;

CREATE OR REPLACE FUNCTION public.record_cctv_review_event(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_source_event_id text,
  p_event_type text,
  p_review_state text,
  p_reviewer_notes text DEFAULT NULL,
  p_confidence_override real DEFAULT NULL,
  p_person_record_id uuid DEFAULT NULL,
  p_vehicle_id uuid DEFAULT NULL,
  p_incident_id uuid DEFAULT NULL
)
RETURNS public.cctv_review_events
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  current_event public.cctv_review_events;
  saved_event public.cctv_review_events;
BEGIN
  IF actor_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'CCTV review access denied';
  END IF;
  IF p_source_event_id IS NULL OR trim(p_source_event_id) = '' THEN
    RAISE EXCEPTION 'Source event ID is required';
  END IF;
  IF p_event_type NOT IN ('video', 'vehicle', 'person', 'face', 'keyframe')
     OR p_review_state NOT IN ('unreviewed', 'accepted', 'rejected', 'uncertain', 'needs_more_context', 'superseded') THEN
    RAISE EXCEPTION 'Invalid CCTV review event type or state';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
    WHERE id = p_job_id AND evidence_item_id = p_evidence_id
      AND organization_id = p_organization_id AND domain IN ('video_motion', 'vehicle', 'face')
  ) THEN
    RAISE EXCEPTION 'CCTV inference job is missing or outside the organization';
  END IF;
  IF p_person_record_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.person_records WHERE id = p_person_record_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'Person record is outside the organization';
  END IF;
  IF p_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.vehicles WHERE id = p_vehicle_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'Vehicle record is outside the organization';
  END IF;
  IF p_incident_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.incidents WHERE id = p_incident_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'Incident is outside the organization';
  END IF;
  IF p_review_state = 'accepted' AND p_event_type IN ('face', 'person') AND p_person_record_id IS NULL THEN
    RAISE EXCEPTION 'Accepted person events require an explicit person record link';
  END IF;
  IF p_review_state = 'accepted' AND p_event_type = 'vehicle' AND p_vehicle_id IS NULL THEN
    RAISE EXCEPTION 'Accepted vehicle events require an explicit vehicle record link';
  END IF;

  SELECT * INTO current_event
    FROM public.cctv_review_events
   WHERE inference_job_id = p_job_id AND source_event_id = trim(p_source_event_id) AND event_type = p_event_type
   FOR UPDATE;

  INSERT INTO public.cctv_review_events (
    organization_id, inference_job_id, evidence_item_id, source_event_id, event_type,
    review_state, reviewer_notes, confidence_override,
    linked_person_record_id, linked_vehicle_id, linked_incident_id
  ) VALUES (
    p_organization_id, p_job_id, p_evidence_id, trim(p_source_event_id), p_event_type,
    p_review_state, NULLIF(trim(p_reviewer_notes), ''), p_confidence_override,
    p_person_record_id, p_vehicle_id, p_incident_id
  )
  ON CONFLICT (inference_job_id, source_event_id, event_type)
  DO UPDATE SET
    review_state = EXCLUDED.review_state,
    reviewer_notes = EXCLUDED.reviewer_notes,
    confidence_override = EXCLUDED.confidence_override,
    linked_person_record_id = EXCLUDED.linked_person_record_id,
    linked_vehicle_id = EXCLUDED.linked_vehicle_id,
    linked_incident_id = EXCLUDED.linked_incident_id,
    updated_at = clock_timestamp()
  RETURNING * INTO saved_event;

  INSERT INTO public.cctv_review_event_decisions (
    organization_id, review_event_id, previous_state, next_state, reviewer_notes,
    confidence_override, linked_person_record_id, linked_vehicle_id, linked_incident_id, decided_by
  ) VALUES (
    p_organization_id, saved_event.id, current_event.review_state, p_review_state,
    NULLIF(trim(p_reviewer_notes), ''), p_confidence_override,
    p_person_record_id, p_vehicle_id, p_incident_id, actor_id
  );

  RETURN saved_event;
END;
$$;

REVOKE ALL ON FUNCTION public.record_cctv_review_event(uuid, uuid, uuid, text, text, text, text, real, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_cctv_review_event(uuid, uuid, uuid, text, text, text, text, real, uuid, uuid, uuid) TO authenticated, service_role;
