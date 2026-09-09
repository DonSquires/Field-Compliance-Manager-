CREATE TABLE IF NOT EXISTS public.cctv_camera_scene_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE SET NULL,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE SET NULL,
  camera_key text NOT NULL,
  scene_label text,
  scene_fingerprint jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evidence_count integer NOT NULL DEFAULT 0,
  recidivism_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_state text NOT NULL DEFAULT 'active' CHECK (review_state IN ('active','needs_review','retired')),
  UNIQUE (organization_id, camera_key)
);

ALTER TABLE public.cctv_camera_scene_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cctv_camera_scene_profiles_select ON public.cctv_camera_scene_profiles;
CREATE POLICY cctv_camera_scene_profiles_select ON public.cctv_camera_scene_profiles
  FOR SELECT USING (public.org_access_allowed(organization_id));

CREATE OR REPLACE FUNCTION public.record_cctv_scene_observation(
  p_organization_id uuid,
  p_evidence_id uuid,
  p_inference_job_id uuid,
  p_camera_key text,
  p_scene_fingerprint jsonb,
  p_location_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL
)
RETURNS public.cctv_camera_scene_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile public.cctv_camera_scene_profiles;
  v_result jsonb;
  v_vehicle_count integer := 0;
  v_person_count integer := 0;
  v_review_count integer := 0;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_camera_key IS NULL OR length(trim(p_camera_key)) < 3 THEN
    RAISE EXCEPTION 'camera key is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.evidence_items e
    WHERE e.id = p_evidence_id AND e.organization_id = p_organization_id
  ) THEN RAISE EXCEPTION 'evidence item not found for organization'; END IF;

  SELECT r.result INTO v_result
  FROM public.inference_results r
  WHERE r.inference_job_id = p_inference_job_id AND r.evidence_item_id = p_evidence_id
  ORDER BY r.created_at DESC
  LIMIT 1;

  v_vehicle_count := COALESCE(jsonb_array_length(v_result #> '{consolidated_events,vehicle_events}'), 0);
  v_person_count := COALESCE(jsonb_array_length(v_result #> '{consolidated_events,person_events}'), 0)
    + COALESCE(jsonb_array_length(v_result #> '{consolidated_events,face_events}'), 0);
  v_review_count := COALESCE((v_result #>> '{consolidated_events,quality_summary,review_required_count}')::integer, 0);

  INSERT INTO public.cctv_camera_scene_profiles (
    organization_id, location_id, site_id, zone_id, camera_key, scene_fingerprint,
    first_seen_at, last_seen_at, evidence_count, recidivism_summary
  ) VALUES (
    p_organization_id, p_location_id, p_site_id, p_zone_id, trim(p_camera_key), COALESCE(p_scene_fingerprint, '{}'::jsonb),
    clock_timestamp(), clock_timestamp(), 1,
    jsonb_build_object('vehicle_events', v_vehicle_count, 'person_events', v_person_count, 'review_required', v_review_count)
  )
  ON CONFLICT (organization_id, camera_key) DO UPDATE SET
    location_id = COALESCE(EXCLUDED.location_id, cctv_camera_scene_profiles.location_id),
    site_id = COALESCE(EXCLUDED.site_id, cctv_camera_scene_profiles.site_id),
    zone_id = COALESCE(EXCLUDED.zone_id, cctv_camera_scene_profiles.zone_id),
    scene_fingerprint = EXCLUDED.scene_fingerprint,
    last_seen_at = clock_timestamp(),
    evidence_count = cctv_camera_scene_profiles.evidence_count + 1,
    recidivism_summary = jsonb_build_object(
      'vehicle_events', COALESCE((cctv_camera_scene_profiles.recidivism_summary->>'vehicle_events')::integer, 0) + v_vehicle_count,
      'person_events', COALESCE((cctv_camera_scene_profiles.recidivism_summary->>'person_events')::integer, 0) + v_person_count,
      'review_required', COALESCE((cctv_camera_scene_profiles.recidivism_summary->>'review_required')::integer, 0) + v_review_count
    )
  RETURNING * INTO v_profile;

  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.record_cctv_scene_observation(uuid, uuid, uuid, text, jsonb, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_scene_observation(uuid, uuid, uuid, text, jsonb, uuid, uuid, uuid) TO service_role;
