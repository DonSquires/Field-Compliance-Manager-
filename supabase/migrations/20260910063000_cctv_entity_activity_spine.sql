CREATE TABLE IF NOT EXISTS public.cctv_entity_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  inference_job_id uuid NOT NULL REFERENCES public.inference_jobs(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  source_event_id text NOT NULL,
  entity_kind text NOT NULL CHECK (entity_kind IN ('person', 'vehicle', 'animal')),
  observed_at timestamptz NOT NULL,
  observed_to timestamptz,
  site_id uuid,
  zone_id uuid,
  canonical_person_id uuid REFERENCES public.person_records(id) ON DELETE SET NULL,
  canonical_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  candidate_label text,
  candidate_plate text,
  animal_type text,
  candidate_embedding jsonb,
  model_confidence real CHECK (model_confidence IS NULL OR model_confidence BETWEEN 0 AND 1),
  frame_sha256 text,
  thumbnail text,
  review_state text NOT NULL DEFAULT 'unreviewed' CHECK (review_state IN ('unreviewed', 'accepted', 'rejected', 'uncertain', 'needs_more_context', 'superseded')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (inference_job_id, source_event_id, entity_kind),
  CHECK (observed_to IS NULL OR observed_to >= observed_at),
  CHECK (candidate_embedding IS NULL OR jsonb_typeof(candidate_embedding) = 'array'),
  CHECK (thumbnail IS NULL OR thumbnail LIKE 'data:image/%')
);

COMMENT ON TABLE public.cctv_entity_observations IS
  'Cross-job CCTV person, vehicle, and animal observations. Similarity remains provisional until a human review link is accepted.';

CREATE INDEX IF NOT EXISTS cctv_entity_observations_period_idx
  ON public.cctv_entity_observations (organization_id, observed_at DESC, entity_kind);
CREATE INDEX IF NOT EXISTS cctv_entity_observations_place_idx
  ON public.cctv_entity_observations (organization_id, site_id, zone_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS cctv_entity_observations_person_idx
  ON public.cctv_entity_observations (organization_id, canonical_person_id, observed_at DESC)
  WHERE canonical_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cctv_entity_observations_vehicle_idx
  ON public.cctv_entity_observations (organization_id, canonical_vehicle_id, observed_at DESC)
  WHERE canonical_vehicle_id IS NOT NULL;

ALTER TABLE public.cctv_entity_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cctv_entity_observations_select ON public.cctv_entity_observations;
CREATE POLICY cctv_entity_observations_select ON public.cctv_entity_observations
  FOR SELECT TO authenticated USING (public.org_access_allowed(organization_id));
REVOKE ALL ON public.cctv_entity_observations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.cctv_entity_observations TO authenticated;
GRANT ALL ON public.cctv_entity_observations TO service_role;

CREATE OR REPLACE FUNCTION public.record_cctv_entity_observations(
  p_job_id uuid,
  p_evidence_id uuid,
  p_organization_id uuid,
  p_observations jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  observation jsonb;
  saved_count integer := 0;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF jsonb_typeof(p_observations) <> 'array' THEN
    RAISE EXCEPTION 'CCTV entity observations must be an array';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.inference_jobs
    WHERE id = p_job_id AND evidence_item_id = p_evidence_id
      AND organization_id = p_organization_id AND domain = 'video_motion'
  ) THEN
    RAISE EXCEPTION 'CCTV inference job is missing or outside the organization';
  END IF;

  FOR observation IN SELECT value FROM jsonb_array_elements(p_observations)
  LOOP
    IF observation->>'entity_kind' NOT IN ('person', 'vehicle', 'animal')
       OR NULLIF(observation->>'source_event_id', '') IS NULL
       OR NULLIF(observation->>'observed_at', '') IS NULL THEN
      CONTINUE;
    END IF;
    INSERT INTO public.cctv_entity_observations (
      organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind,
      observed_at, observed_to, site_id, zone_id, candidate_label, candidate_plate,
      animal_type, candidate_embedding, model_confidence, frame_sha256, thumbnail
    ) VALUES (
      p_organization_id, p_job_id, p_evidence_id, observation->>'source_event_id', observation->>'entity_kind',
      (observation->>'observed_at')::timestamptz, NULLIF(observation->>'observed_to', '')::timestamptz,
      NULLIF(observation->>'site_id', '')::uuid, NULLIF(observation->>'zone_id', '')::uuid,
      NULLIF(observation->>'candidate_label', ''), NULLIF(observation->>'candidate_plate', ''),
      NULLIF(observation->>'animal_type', ''), observation->'candidate_embedding',
      NULLIF(observation->>'model_confidence', '')::real, NULLIF(observation->>'frame_sha256', ''),
      CASE WHEN observation->>'thumbnail' LIKE 'data:image/%' THEN observation->>'thumbnail' ELSE NULL END
    ) ON CONFLICT (inference_job_id, source_event_id, entity_kind) DO NOTHING;
    IF FOUND THEN saved_count := saved_count + 1; END IF;
  END LOOP;
  RETURN saved_count;
END;
$$;

REVOKE ALL ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_entity_observations(uuid, uuid, uuid, jsonb) TO service_role;
