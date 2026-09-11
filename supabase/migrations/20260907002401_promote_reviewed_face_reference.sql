CREATE OR REPLACE FUNCTION public.assign_face_observation_person(
  p_observation_id uuid,
  p_person_record_id uuid,
  p_display_name text DEFAULT NULL
)
RETURNS public.face_observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  observation public.face_observations;
  source_metadata jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    IF auth.uid() IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.face_observations
       WHERE id = p_observation_id AND public.org_access_allowed(organization_id)
    ) THEN RAISE EXCEPTION 'Observation access denied'; END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.face_observations o
    JOIN public.person_records p ON p.organization_id = o.organization_id
   WHERE o.id = p_observation_id AND p.id = p_person_record_id
  ) THEN RAISE EXCEPTION 'Person record does not belong to the observation organization'; END IF;

  SELECT metadata INTO source_metadata FROM public.face_observations WHERE id = p_observation_id;
  IF NULLIF(trim(p_display_name), '') IS NOT NULL THEN
    UPDATE public.person_records SET display_name = trim(p_display_name) WHERE id = p_person_record_id;
  END IF;
  UPDATE public.person_records
     SET metadata = jsonb_set(
       metadata,
       '{face_reference}',
       jsonb_build_object(
         'embedding', source_metadata->'embedding',
         'thumbnail', source_metadata->>'original_thumbnail',
         'evidence_item_id', source_metadata->>'evidence_item_id',
         'event_id', source_metadata->>'source_event_id'
       ),
       true
     )
   WHERE id = p_person_record_id
     AND jsonb_typeof(metadata->'face_reference'->'embedding') IS DISTINCT FROM 'array'
     AND jsonb_typeof(source_metadata->'embedding') = 'array';

  UPDATE public.face_observations SET person_record_id = p_person_record_id, review_state = 'reviewed'
   WHERE id = p_observation_id RETURNING * INTO observation;
  RETURN observation;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_face_observation_person(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_face_observation_person(uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_face_observation_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  reference jsonb;
BEGIN
  SELECT metadata->'face_reference' INTO reference
    FROM public.person_records WHERE id = NEW.person_record_id;
  IF jsonb_typeof(NEW.metadata->'embedding') IS DISTINCT FROM 'array'
     AND jsonb_typeof(reference->'embedding') = 'array' THEN
    NEW.metadata := NEW.metadata || jsonb_build_object(
      'embedding', reference->'embedding',
      'original_thumbnail', COALESCE(NEW.metadata->>'original_thumbnail', reference->>'thumbnail')
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS face_observation_reference_sync ON public.face_observations;
CREATE TRIGGER face_observation_reference_sync
  BEFORE INSERT ON public.face_observations
  FOR EACH ROW EXECUTE FUNCTION public.sync_face_observation_reference();