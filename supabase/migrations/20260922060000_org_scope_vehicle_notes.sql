-- Corrects a design flaw in the vehicle-notes feature shipped earlier this session
-- (migration 20260922040000), caught before any real data existed (verified live: 0 rows
-- had a note set).
--
-- Two problems, both from treating "notes" as a single flat column on the GLOBAL
-- canonical_vehicles record:
--   1. Cross-org leak: a reviewer's note ("regular contractor", "seen loitering") is
--      context specific to the org that wrote it, not a fact about the vehicle itself -
--      unlike homeless_status, which is deliberately a shared cross-org safety signal.
--      A flat column would let every org see every other org's notes about a shared plate.
--      This is the same principle that already keeps registered_owner_name/homeless_notes
--      off canonical_vehicle_public and keeps entity_flags' narrative with the raising org.
--   2. Two orgs writing a note about the same plate would silently overwrite each other,
--      since there was only one value to hold it.
--   3. (Found while fixing the above) canonical_vehicles only carries a bob_full_read RLS
--      policy - the canonical_vehicles(notes) embed added to OBSERVATION_SELECT in the same
--      commit is therefore silently non-functional for every real (non-Bob) user; PostgREST
--      embeds enforce RLS on the embedded table. Fixed by reading through a governed RPC
--      instead of embedding the table directly.
ALTER TABLE public.canonical_vehicles DROP COLUMN IF EXISTS notes;
ALTER TABLE public.canonical_vehicles ADD COLUMN IF NOT EXISTS org_notes jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN public.canonical_vehicles.org_notes IS 'Reviewer notes on the vehicle, keyed by organization_id (text) -> {text, updated_at, updated_by}. Org-scoped by design: a note is this org''s context about a shared plate, not a fact about the vehicle. Never exposed via canonical_vehicle_public; read only through get_cctv_vehicle_note (returns the calling org''s own slice).';

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
  v_org_key text;
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

  v_org_key := v_obs.organization_id::text;
  IF v_notes IS NULL THEN
    UPDATE public.canonical_vehicles SET org_notes = org_notes - v_org_key, updated_at = clock_timestamp() WHERE id = v_vehicle;
  ELSE
    UPDATE public.canonical_vehicles
       SET org_notes = org_notes || jsonb_build_object(v_org_key, jsonb_build_object('text', v_notes, 'updated_at', clock_timestamp(), 'updated_by', v_actor)),
           updated_at = clock_timestamp()
     WHERE id = v_vehicle;
  END IF;

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

CREATE OR REPLACE FUNCTION "public"."get_cctv_vehicle_note"(p_observation_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path = public, extensions
AS $$
DECLARE
  v_obs public.cctv_entity_observations%rowtype;
BEGIN
  SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = p_observation_id;
  IF v_obs.id IS NULL THEN RETURN NULL; END IF;
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(v_obs.organization_id) THEN RETURN NULL; END IF;
  IF v_obs.canonical_vehicle_id IS NULL THEN RETURN NULL; END IF;
  RETURN (SELECT org_notes -> v_obs.organization_id::text ->> 'text' FROM public.canonical_vehicles WHERE id = v_obs.canonical_vehicle_id);
END;
$$;

COMMENT ON FUNCTION public.get_cctv_vehicle_note(uuid) IS 'Returns only the calling organisation''s own note for the vehicle behind this observation - never another org''s note. Definer read, since canonical_vehicles stays Bob-only at the table.';

REVOKE ALL ON FUNCTION public.get_cctv_vehicle_note(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_cctv_vehicle_note(uuid) TO postgres, authenticated, service_role;
