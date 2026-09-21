-- Fix (owner ruling 2026-09-22): review_cctv_entity_observation's plate-accept path seeds a brand-new
-- canonical_vehicles row from cctv_entity_observations.attributes.make/model. Before the vision-LLM hint
-- feature (this same session) those fields were always null, so this path never had real data to leak.
-- Now it can - and confirming a plate's IDENTITY ("yes this is really ABC123") is a different decision
-- to confirming its MAKE/MODEL, which needs its own explicit human action. Recreated with the same
-- signature; only the seed-value computation in the accept/new_vehicle branch changed.
CREATE OR REPLACE FUNCTION "public"."review_cctv_entity_observation"(p_observation_id uuid, p_action text, p_target_id uuid DEFAULT NULL::uuid, p_display_name text DEFAULT NULL::text, p_plate text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS cctv_entity_observations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_obs public.cctv_entity_observations%rowtype; v_person uuid; v_vehicle uuid;
  v_plate text; v_target public.cctv_entity_observations%rowtype; v_n integer := 0;
  v_seed_make text; v_seed_model text;
BEGIN
  SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = p_observation_id FOR UPDATE;
  IF v_obs.id IS NULL THEN RAISE EXCEPTION 'CCTV observation not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_obs.organization_id) THEN RAISE EXCEPTION 'CCTV review access denied'; END IF;
  IF p_action NOT IN ('accept', 'reject', 'link_person', 'new_person', 'link_vehicle', 'new_vehicle', 'merge_portfolio', 'accept_portfolio') THEN
    RAISE EXCEPTION 'Unsupported CCTV review action %', p_action;
  END IF;

  IF p_action = 'reject' THEN
    UPDATE public.cctv_entity_observations
       SET review_state = 'rejected', portfolio_state = 'rejected', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'link_person' THEN
    IF v_obs.entity_kind <> 'person' THEN RAISE EXCEPTION 'Only a person observation can be linked to a person'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.person_records pr WHERE pr.id = p_target_id AND pr.organization_id = v_obs.organization_id) THEN
      RAISE EXCEPTION 'Person record is outside the organization';
    END IF;
    UPDATE public.cctv_entity_observations
       SET person_record_id = p_target_id, canonical_person_id = public.ensure_canonical_person_for_record(p_target_id),
           review_state = 'accepted', portfolio_state = 'linked', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'new_person' THEN
    IF v_obs.entity_kind <> 'person' THEN RAISE EXCEPTION 'Only a person observation can create a person'; END IF;
    IF nullif(trim(coalesce(p_display_name, '')), '') IS NULL THEN RAISE EXCEPTION 'A display name is required for a new person'; END IF;
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (v_obs.organization_id, trim(p_display_name), 'draft',
            jsonb_build_object('created_from', 'cctv_entity_observation', 'observation_id', v_obs.id, 'created_by', v_actor))
    RETURNING id INTO v_person;
    UPDATE public.cctv_entity_observations
       SET person_record_id = v_person, canonical_person_id = public.ensure_canonical_person_for_record(v_person),
           review_state = 'accepted', portfolio_state = 'new_identity', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'link_vehicle' THEN
    IF v_obs.entity_kind <> 'vehicle' THEN RAISE EXCEPTION 'Only a vehicle observation can be linked to a vehicle'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.canonical_vehicles cv WHERE cv.id = p_target_id) THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;
    UPDATE public.cctv_entity_observations
       SET canonical_vehicle_id = p_target_id, review_state = 'accepted', portfolio_state = 'linked',
           reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;
    INSERT INTO public.canonical_vehicle_links (canonical_vehicle_id, source_system, source_table, source_key, metadata)
    VALUES (p_target_id, 'cctv_review', 'cctv_entity_observations', v_obs.id::text, jsonb_build_object('linked_by', v_actor, 'observed_at', v_obs.observed_at))
    ON CONFLICT (source_system, source_table, source_key) DO NOTHING;

  ELSIF p_action IN ('new_vehicle', 'accept') AND v_obs.entity_kind = 'vehicle' AND NULLIF(public.normalize_plate_number(coalesce(p_plate, v_obs.candidate_plate)), '') IS NOT NULL THEN
    v_plate := public.normalize_plate_number(coalesce(p_plate, v_obs.candidate_plate));
    -- Never seed a brand-new canonical vehicle from an unverified vision-LLM guess; see header comment.
    v_seed_make := CASE WHEN v_obs.attributes->>'make_model_source' = 'vision_llm_hint_unverified' THEN NULL ELSE v_obs.attributes->>'make' END;
    v_seed_model := CASE WHEN v_obs.attributes->>'make_model_source' = 'vision_llm_hint_unverified' THEN NULL ELSE v_obs.attributes->>'model' END;
    v_vehicle := public.ensure_canonical_vehicle(v_plate, v_seed_make, v_seed_model, v_obs.attributes->>'colour',
                                                 'cctv_entity_observations', v_obs.id::text, v_obs.observed_at);
    IF v_vehicle IS NULL THEN RAISE EXCEPTION 'Plate % is not a valid vehicle identity', v_plate; END IF;
    UPDATE public.cctv_entity_observations
       SET candidate_plate = v_plate, canonical_vehicle_id = v_vehicle, review_state = 'accepted',
           portfolio_state = CASE WHEN p_action = 'new_vehicle' THEN 'new_identity' ELSE 'linked' END,
           reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'new_vehicle' THEN
    RAISE EXCEPTION 'A readable plate is required to create a vehicle; keep it in its portfolio until one is read';

  ELSIF p_action = 'accept' THEN
    UPDATE public.cctv_entity_observations
       SET review_state = 'accepted', reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = nullif(trim(p_notes), '')
     WHERE id = v_obs.id RETURNING * INTO v_obs;

  ELSIF p_action = 'merge_portfolio' THEN
    SELECT * INTO v_target FROM public.cctv_entity_observations WHERE id = p_target_id AND organization_id = v_obs.organization_id;
    IF v_target.id IS NULL OR v_target.entity_kind <> v_obs.entity_kind THEN RAISE EXCEPTION 'Merge target must be an observation of the same kind in the organization'; END IF;
    IF v_target.portfolio_key IS NULL THEN
      UPDATE public.cctv_entity_observations SET portfolio_key = gen_random_uuid() WHERE id = v_target.id RETURNING * INTO v_target;
    END IF;
    UPDATE public.cctv_entity_observations
       SET portfolio_key = v_target.portfolio_key,
           portfolio_state = CASE WHEN portfolio_state IN ('linked', 'new_identity', 'rejected') THEN portfolio_state ELSE 'candidate' END
     WHERE organization_id = v_obs.organization_id AND (portfolio_key = v_obs.portfolio_key OR id = v_obs.id);
    SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = v_obs.id;

  ELSIF p_action = 'accept_portfolio' THEN
    IF v_obs.person_record_id IS NULL AND v_obs.canonical_vehicle_id IS NULL THEN
      RAISE EXCEPTION 'Link this observation to an identity before applying it to its portfolio';
    END IF;
    UPDATE public.cctv_entity_observations o
       SET person_record_id = v_obs.person_record_id, canonical_person_id = v_obs.canonical_person_id,
           canonical_vehicle_id = v_obs.canonical_vehicle_id, candidate_plate = coalesce(o.candidate_plate, v_obs.candidate_plate),
           review_state = 'accepted', portfolio_state = 'linked', reviewed_by = v_actor, reviewed_at = clock_timestamp(),
           review_notes = coalesce(nullif(trim(p_notes), ''), 'Accepted with portfolio ' || v_obs.portfolio_key::text)
     WHERE o.organization_id = v_obs.organization_id AND o.portfolio_key = v_obs.portfolio_key
       AND o.id <> v_obs.id AND o.review_state = 'unreviewed';
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_obs.organization_id, v_actor, 'cctv_entity_observation_' || p_action, 'cctv_entity_observations', v_obs.id,
          jsonb_strip_nulls(jsonb_build_object('entity_kind', v_obs.entity_kind, 'target_id', p_target_id, 'plate', v_plate,
            'person_record_id', v_obs.person_record_id, 'canonical_vehicle_id', v_obs.canonical_vehicle_id,
            'portfolio_key', v_obs.portfolio_key, 'portfolio_rows_updated', nullif(v_n, 0))));
  -- Biometric templates never leave the database through a review response: matching happens in
  -- find_cctv_portfolio_matches, and the reviewer only needs the decision, labels and thumbnail back.
  v_obs.face_vec := NULL; v_obs.appearance_vec := NULL; v_obs.candidate_embedding := NULL; v_obs.appearance_embedding := NULL;
  RETURN v_obs;
END $function$;

-- New: the dedicated, explicit action for confirming/correcting/rejecting a vehicle's vision-LLM make/model
-- hint. Confirming or correcting writes to the cross-org canonical_vehicles registry (make/model only,
-- never overwriting an unrelated column) - this is the "a human looked at THIS and confirmed it" moment,
-- deliberately separate from merely accepting a plate's identity (see fix above). Plateless/unconfirmed
-- vehicles have no canonical_vehicle_id to attach a correction to yet; the human decision is still recorded
-- on the observation itself so it isn't asked again, and can reach the registry once a plate is read.
CREATE OR REPLACE FUNCTION "public"."confirm_cctv_vehicle_attributes"(
  p_observation_id uuid,
  p_action text,
  p_make text DEFAULT NULL::text,
  p_model text DEFAULT NULL::text,
  p_notes text DEFAULT NULL::text
)
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
  v_final_make text;
  v_final_model text;
  v_review jsonb;
BEGIN
  SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = p_observation_id FOR UPDATE;
  IF v_obs.id IS NULL THEN RAISE EXCEPTION 'CCTV observation not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_obs.organization_id) THEN RAISE EXCEPTION 'CCTV review access denied'; END IF;
  IF v_obs.entity_kind <> 'vehicle' THEN RAISE EXCEPTION 'Only a vehicle observation carries a make/model suggestion'; END IF;
  IF p_action NOT IN ('confirm', 'correct', 'reject') THEN RAISE EXCEPTION 'Unsupported vehicle attribute action %', p_action; END IF;

  IF p_action = 'confirm' THEN
    v_final_make := v_obs.attributes->>'make';
    v_final_model := v_obs.attributes->>'model';
  ELSIF p_action = 'correct' THEN
    IF nullif(trim(coalesce(p_make, '')), '') IS NULL AND nullif(trim(coalesce(p_model, '')), '') IS NULL THEN
      RAISE EXCEPTION 'A corrected make or model is required';
    END IF;
    v_final_make := nullif(trim(p_make), '');
    v_final_model := nullif(trim(p_model), '');
  END IF;

  IF p_action IN ('confirm', 'correct') THEN
    v_plate := public.normalize_plate_number(v_obs.candidate_plate);
    IF v_plate IS NOT NULL THEN
      v_vehicle := coalesce(v_obs.canonical_vehicle_id, public.ensure_canonical_vehicle(v_plate, NULL, NULL, v_obs.attributes->>'colour',
                                                 'cctv_entity_observations', v_obs.id::text, v_obs.observed_at));
      IF v_vehicle IS NOT NULL THEN
        UPDATE public.canonical_vehicles
           SET make = coalesce(v_final_make, make), model = coalesce(v_final_model, model), updated_at = clock_timestamp()
         WHERE id = v_vehicle;
      END IF;
    END IF;
  END IF;

  v_review := jsonb_build_object(
    'status', CASE p_action WHEN 'confirm' THEN 'confirmed' WHEN 'correct' THEN 'corrected' ELSE 'rejected' END,
    'reviewed_by', v_actor, 'reviewed_at', clock_timestamp(), 'notes', nullif(trim(p_notes), '')
  );

  UPDATE public.cctv_entity_observations
     SET attributes = attributes
       || jsonb_build_object('make_model_review', v_review)
       || CASE WHEN p_action = 'correct' THEN jsonb_build_object('make', v_final_make, 'model', v_final_model, 'make_model_source', 'human_confirmed')
               WHEN p_action = 'confirm' THEN jsonb_build_object('make_model_source', 'human_confirmed')
               ELSE '{}'::jsonb END,
         canonical_vehicle_id = coalesce(canonical_vehicle_id, v_vehicle)
   WHERE id = v_obs.id
   RETURNING * INTO v_obs;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_obs.organization_id, v_actor, 'cctv_vehicle_attributes_' || p_action, 'cctv_entity_observations', v_obs.id,
          jsonb_strip_nulls(jsonb_build_object('make', v_final_make, 'model', v_final_model, 'canonical_vehicle_id', v_vehicle)));

  v_obs.face_vec := NULL; v_obs.appearance_vec := NULL; v_obs.candidate_embedding := NULL; v_obs.appearance_embedding := NULL;
  RETURN v_obs;
END;
$$;

COMMENT ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text) IS
  'Reviewer confirm/correct/reject of a vehicle vision-LLM make/model suggestion. Confirm or correct writes to canonical_vehicles (cross-org); reject only records the dismissal on the observation. Never called for anything but entity_kind = vehicle.';

REVOKE ALL ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text) TO service_role;

-- New: the reviewer's confirm/dismiss decision on a person observation's weapon vision-LLM hint. There is
-- no equivalent cross-org "canonical firearm registry" to write to (unlike vehicles), so this only ever
-- records a human's assessment on the observation itself. This is deliberately NOT an alerting or
-- escalation mechanism - it never notifies anyone or changes any other table; it exists purely so a
-- reviewer's "yes/no, I looked at this" decision replaces the "unverified" label and the item stops
-- reappearing as an open suggestion. Any real escalation stays a separate, human-initiated action outside
-- this RPC.
CREATE OR REPLACE FUNCTION "public"."confirm_cctv_weapon_hint"(
  p_observation_id uuid,
  p_status text,
  p_notes text DEFAULT NULL::text
)
RETURNS public.cctv_entity_observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_obs public.cctv_entity_observations%rowtype;
  v_review jsonb;
BEGIN
  SELECT * INTO v_obs FROM public.cctv_entity_observations WHERE id = p_observation_id FOR UPDATE;
  IF v_obs.id IS NULL THEN RAISE EXCEPTION 'CCTV observation not found'; END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_obs.organization_id) THEN RAISE EXCEPTION 'CCTV review access denied'; END IF;
  IF v_obs.entity_kind <> 'person' THEN RAISE EXCEPTION 'Only a person observation carries a weapon hint'; END IF;
  IF v_obs.attributes->'weapon_hint' IS NULL THEN RAISE EXCEPTION 'This observation has no weapon hint to review'; END IF;
  IF p_status NOT IN ('confirmed', 'dismissed') THEN RAISE EXCEPTION 'Unsupported weapon hint status %', p_status; END IF;

  v_review := jsonb_build_object('status', p_status, 'reviewed_by', v_actor, 'reviewed_at', clock_timestamp(), 'notes', nullif(trim(p_notes), ''));

  UPDATE public.cctv_entity_observations
     SET attributes = jsonb_set(attributes, '{weapon_hint,review}', v_review, true)
   WHERE id = v_obs.id
   RETURNING * INTO v_obs;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_obs.organization_id, v_actor, 'cctv_weapon_hint_' || p_status, 'cctv_entity_observations', v_obs.id, '{}'::jsonb);

  v_obs.face_vec := NULL; v_obs.appearance_vec := NULL; v_obs.candidate_embedding := NULL; v_obs.appearance_embedding := NULL;
  RETURN v_obs;
END;
$$;

COMMENT ON FUNCTION public.confirm_cctv_weapon_hint(uuid, text, text) IS
  'Reviewer confirm/dismiss of a person observation weapon vision-LLM hint. Records the human decision only - never writes any other table, never triggers alerting/escalation.';

REVOKE ALL ON FUNCTION public.confirm_cctv_weapon_hint(uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_cctv_weapon_hint(uuid, text, text) TO postgres;
GRANT EXECUTE ON FUNCTION public.confirm_cctv_weapon_hint(uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_cctv_weapon_hint(uuid, text, text) TO service_role;
