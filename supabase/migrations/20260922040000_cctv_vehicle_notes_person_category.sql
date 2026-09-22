-- Closes a real gap found while reviewing the CCTV workflow: a reviewer could only ever attach a plain
-- name + free-text note to a person, and vehicles had NO reviewer-owned notes capability at all
-- (canonical_vehicles.compliance_source even lists 'manual (officer entry)' as an expected source, but
-- nothing ever built a path for it). Deliberately narrow in scope:
--   - person_records.metadata->'profile_details' is already a flexible jsonb object (merged, not
--     replaced, by update_cctv_person_profile) - no migration needed there. The frontend now also sends
--     a 'category' key alongside 'notes'.
--   - canonical_vehicles gets a genuine notes column plus a small RPC to set it, mirroring
--     confirm_cctv_vehicle_attributes's own resolve-or-create-then-update pattern. Deliberately
--     independent of the observation's accept/reject decision - a reviewer may want to note something
--     about a vehicle without that action deciding whether the sighting itself is accepted.
--   - The dormant platform-canonical `persons` table (welfare/trespass/date_of_birth) is NOT touched
--     here - wiring CCTV into it is a separate, larger decision with its own Privacy Act handling that
--     belongs to whichever workflow currently owns that table, not something to bolt on quietly from here.
ALTER TABLE public.canonical_vehicles ADD COLUMN IF NOT EXISTS notes text;
COMMENT ON COLUMN public.canonical_vehicles.notes IS 'Free-text reviewer note on the vehicle (e.g. "regular contractor", "seen loitering") - manual/officer entry, independent of MotorWeb-sourced fields.';

CREATE OR REPLACE FUNCTION "public"."update_cctv_vehicle_notes"(p_observation_id uuid, p_notes text)
 RETURNS public.cctv_entity_observations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_obs public.cctv_entity_observations%rowtype;
  v_vehicle uuid;
  v_plate text;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
BEGIN
  SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = p_observation_id FOR UPDATE;
  IF v_obs.id IS NULL THEN RAISE EXCEPTION 'CCTV observation not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_obs.organization_id) THEN RAISE EXCEPTION 'CCTV review access denied'; END IF;
  IF v_obs.entity_kind <> 'vehicle' THEN RAISE EXCEPTION 'Only a vehicle observation carries vehicle notes'; END IF;

  v_plate := public.normalize_plate_number(v_obs.candidate_plate);
  IF v_plate IS NULL THEN
    RAISE EXCEPTION 'A read plate is required before a note can be attached to the vehicle record';
  END IF;
  v_vehicle := coalesce(v_obs.canonical_vehicle_id, public.ensure_canonical_vehicle(v_plate, NULL, NULL, v_obs.attributes->>'colour',
                                             'cctv_entity_observations', v_obs.id::text, v_obs.observed_at));
  IF v_vehicle IS NULL THEN RAISE EXCEPTION 'Plate % is not a valid vehicle identity', v_plate; END IF;

  UPDATE public.canonical_vehicles SET notes = v_notes, updated_at = clock_timestamp() WHERE id = v_vehicle;

  UPDATE public.cctv_entity_observations
     SET canonical_vehicle_id = coalesce(canonical_vehicle_id, v_vehicle)
   WHERE id = v_obs.id
   RETURNING * INTO v_obs;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_obs.organization_id, v_actor, 'cctv_vehicle_notes_updated', 'canonical_vehicles', v_vehicle, jsonb_build_object('observation_id', v_obs.id));

  v_obs.face_vec := NULL; v_obs.appearance_vec := NULL; v_obs.candidate_embedding := NULL; v_obs.appearance_embedding := NULL;
  RETURN v_obs;
END;
$$;

COMMENT ON FUNCTION public.update_cctv_vehicle_notes(uuid, text) IS 'Reviewer-owned free-text note on the vehicle behind a plated observation. Independent of accept/reject - resolves or creates the canonical vehicle by plate if not already linked.';
REVOKE ALL ON FUNCTION public.update_cctv_vehicle_notes(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_cctv_vehicle_notes(uuid, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.update_cctv_vehicle_notes(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_cctv_vehicle_notes(uuid, text) TO service_role;
