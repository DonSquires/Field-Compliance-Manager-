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
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    IF auth.uid() IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.face_observations
       WHERE id = p_observation_id AND public.org_access_allowed(organization_id)
    ) THEN
      RAISE EXCEPTION 'Observation access denied';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.face_observations o
    JOIN public.person_records p ON p.organization_id = o.organization_id
   WHERE o.id = p_observation_id AND p.id = p_person_record_id
  ) THEN
    RAISE EXCEPTION 'Person record does not belong to the observation organization';
  END IF;

  IF NULLIF(trim(p_display_name), '') IS NOT NULL THEN
    UPDATE public.person_records
       SET display_name = trim(p_display_name)
     WHERE id = p_person_record_id;
  END IF;

  UPDATE public.face_observations
     SET person_record_id = p_person_record_id, review_state = 'reviewed'
   WHERE id = p_observation_id
   RETURNING * INTO observation;
  RETURN observation;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_face_observation_person(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assign_face_observation_person(uuid, uuid, text) TO authenticated, service_role;