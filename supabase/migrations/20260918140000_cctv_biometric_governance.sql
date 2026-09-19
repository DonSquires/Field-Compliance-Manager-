-- CCTV biometric governance: templates stay inside the database, are held only as long as they are useful,
-- and every expiry is audited.
--
-- Facts this rests on (live schema, 2026-09-18): cctv_entity_observations carries face_vec vector(128),
-- appearance_vec vector(256), candidate_embedding jsonb and appearance_embedding jsonb. The table had a plain
-- GRANT SELECT to authenticated, so any signed-in member of the organisation could bulk-read every biometric
-- template through PostgREST even though no screen needs one — matching is done inside
-- find_cctv_portfolio_matches (SECURITY DEFINER) and the console selects an explicit column list. Nothing
-- ever expired a template: a rejected sighting kept its face template for ever.
--
-- What changes:
--   * Column-level privileges: browser roles keep SELECT on every non-biometric column of
--     cctv_entity_observations and lose it on the four template columns. Service and definer paths are
--     unaffected. (PostgreSQL has no "revoke one column" — table SELECT is revoked and the allowed columns
--     are granted back explicitly; a future column added to the table must be granted here too.)
--   * review_cctv_entity_observation and update_cctv_person_profile are re-issued from their live bodies
--     with one change: the returned row has its template columns nulled.
--   * expire_cctv_biometric_templates (service): nulls the four template columns on observations that are
--     rejected, or that have stayed unreviewed / undecided past the retention window (default 90 days, the
--     window is a parameter so an organisation policy can shorten it). The sighting itself, its thumbnail
--     and its review decision remain. Records attributes.biometric_templates_expired_at and one audit_log
--     row per organisation with counts only — never per-person detail.
--   * cctv_biometric_governance (authenticated, org-scoped): what a reviewer or auditor can see about the
--     organisation’s biometric holdings: how many live templates, oldest, how many expired, the window.

-- ── column-level read privileges ──
REVOKE SELECT ON TABLE public.cctv_entity_observations FROM anon, authenticated;
GRANT SELECT (id, organization_id, inference_job_id, evidence_item_id, source_event_id, entity_kind, observed_at, observed_to,
              site_id, zone_id, canonical_person_id, canonical_vehicle_id, candidate_label, candidate_plate, animal_type,
              model_confidence, frame_sha256, thumbnail, review_state, created_at, person_record_id, cctv_import_id,
              location_id, canonical_place_id, quality_state, species_confidence, is_pest, attributes,
              portfolio_key, portfolio_state, portfolio_candidates, reviewed_by, reviewed_at, review_notes)
  ON TABLE public.cctv_entity_observations TO authenticated;
COMMENT ON COLUMN public.cctv_entity_observations.face_vec IS 'Biometric face template (128-d). Service/definer paths only; not readable by browser roles. Expired by expire_cctv_biometric_templates.';
COMMENT ON COLUMN public.cctv_entity_observations.appearance_vec IS 'Appearance (re-identification) template (256-d). Service/definer paths only; not readable by browser roles. Expired by expire_cctv_biometric_templates.';
COMMENT ON COLUMN public.cctv_entity_observations.candidate_embedding IS 'Raw model embedding for the sighting. Service/definer paths only; not readable by browser roles. Expired by expire_cctv_biometric_templates.';
COMMENT ON COLUMN public.cctv_entity_observations.appearance_embedding IS 'Raw appearance embedding for the sighting. Service/definer paths only; not readable by browser roles. Expired by expire_cctv_biometric_templates.';

-- ── review RPCs re-issued from their live bodies; templates redacted from the returned row ──
CREATE OR REPLACE FUNCTION "public"."review_cctv_entity_observation"(p_observation_id uuid, p_action text, p_target_id uuid DEFAULT NULL::uuid, p_display_name text DEFAULT NULL::text, p_plate text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS cctv_entity_observations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_obs public.cctv_entity_observations%rowtype; v_person uuid; v_vehicle uuid;
  v_plate text; v_target public.cctv_entity_observations%rowtype; v_n integer := 0;
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
    v_vehicle := public.ensure_canonical_vehicle(v_plate, v_obs.attributes->>'make', v_obs.attributes->>'model', v_obs.attributes->>'colour',
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

CREATE OR REPLACE FUNCTION "public"."update_cctv_person_profile"(p_observation_id uuid, p_display_name text, p_profile_details jsonb DEFAULT '{}'::jsonb, p_notes text DEFAULT NULL::text)
 RETURNS cctv_entity_observations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_observation public.cctv_entity_observations%rowtype;
  v_person public.person_records%rowtype;
  v_canonical_id uuid;
  v_display_name text := nullif(trim(coalesce(p_display_name, '')), '');
  v_detail_keys jsonb;
BEGIN
  SELECT * INTO v_observation
    FROM public.cctv_entity_observations
   WHERE id = p_observation_id
   FOR UPDATE;
  IF v_observation.id IS NULL THEN
    RAISE EXCEPTION 'CCTV observation not found';
  END IF;
  IF v_actor IS NULL OR NOT public.org_access_allowed(v_observation.organization_id) THEN
    RAISE EXCEPTION 'CCTV person profile access denied';
  END IF;
  IF v_observation.entity_kind <> 'person' THEN
    RAISE EXCEPTION 'Only a person observation can update a person profile';
  END IF;
  IF v_display_name IS NULL OR char_length(v_display_name) > 200 THEN
    RAISE EXCEPTION 'A person name between 1 and 200 characters is required';
  END IF;
  IF jsonb_typeof(coalesce(p_profile_details, '{}'::jsonb)) <> 'object'
     OR octet_length(coalesce(p_profile_details, '{}'::jsonb)::text) > 16384 THEN
    RAISE EXCEPTION 'Person profile details must be an object no larger than 16 KB';
  END IF;
  SELECT * INTO v_person
    FROM public.person_records
   WHERE id = v_observation.person_record_id
     AND organization_id = v_observation.organization_id
   FOR UPDATE;
  IF v_person.id IS NULL THEN
    RAISE EXCEPTION 'No inference person profile is attached to this observation';
  END IF;
  v_canonical_id := COALESCE(
    v_observation.canonical_person_id,
    (SELECT link.canonical_person_id FROM public.canonical_person_links AS link WHERE link.source_table = 'person_records' AND link.source_id = v_person.id LIMIT 1),
    public.ensure_canonical_person_for_record(v_person.id)
  );

  UPDATE public.person_records
     SET display_name = v_display_name,
         review_state = 'manual_review_required',
         metadata = metadata || jsonb_build_object(
           'identity_status', 'named_by_human_review',
           'named_at', clock_timestamp(),
           'named_by', v_actor,
          'profile_details', coalesce(metadata->'profile_details', '{}'::jsonb) || coalesce(p_profile_details, '{}'::jsonb)
         )
   WHERE id = v_person.id;
  UPDATE public.canonical_people
     SET display_name = v_display_name,
         normalized_name = regexp_replace(lower(v_display_name), '[^a-z0-9]+', '', 'g'),
         review_state = 'manual_review_required',
         metadata = metadata || jsonb_build_object(
           'identity_status', 'named_by_human_review',
           'named_at', clock_timestamp(),
           'named_by', v_actor
         ),
         updated_at = clock_timestamp()
   WHERE id = v_canonical_id;
  UPDATE public.cctv_entity_observations
     SET person_record_id = v_person.id,
         canonical_person_id = v_canonical_id,
         review_state = 'accepted',
         portfolio_state = 'linked',
         reviewed_by = v_actor,
         reviewed_at = clock_timestamp(),
         review_notes = nullif(trim(p_notes), '')
   WHERE id = v_observation.id
   RETURNING * INTO v_observation;
  SELECT COALESCE(jsonb_agg(key ORDER BY key), '[]'::jsonb)
    INTO v_detail_keys
    FROM jsonb_object_keys(coalesce(p_profile_details, '{}'::jsonb)) AS key;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_observation.organization_id,
    v_actor,
    'cctv_person_profile_updated',
    'person_records',
    v_person.id,
    jsonb_build_object(
      'observation_id', v_observation.id,
      'canonical_person_id', v_canonical_id,
      'profile_detail_keys', v_detail_keys,
      'profile_name_changed', true
    )
  );
  -- Biometric templates never leave the database through a review response: matching happens in
  -- find_cctv_portfolio_matches, and the reviewer only needs the decision, labels and thumbnail back.
  v_observation.face_vec := NULL; v_observation.appearance_vec := NULL; v_observation.candidate_embedding := NULL; v_observation.appearance_embedding := NULL;
  RETURN v_observation;
END;
$function$;

-- ── template retention ──
CREATE OR REPLACE FUNCTION public.expire_cctv_biometric_templates(p_retention interval DEFAULT interval '90 days', p_organization_id uuid DEFAULT NULL, p_limit integer DEFAULT 5000)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now timestamptz := clock_timestamp();
  v_total integer := 0;
  v_org record;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF p_retention IS NULL OR p_retention < interval '1 day' THEN RAISE EXCEPTION 'Biometric retention must be at least one day'; END IF;

  FOR v_org IN
    WITH due AS (
      SELECT o.id, o.organization_id
        FROM public.cctv_entity_observations o
       WHERE (p_organization_id IS NULL OR o.organization_id = p_organization_id)
         AND (o.face_vec IS NOT NULL OR o.appearance_vec IS NOT NULL OR o.candidate_embedding IS NOT NULL OR o.appearance_embedding IS NOT NULL)
         AND (
           o.review_state = 'rejected'
           OR (o.review_state IN ('unreviewed', 'uncertain', 'needs_more_context', 'superseded') AND o.created_at < v_now - p_retention)
         )
       ORDER BY o.created_at
       LIMIT p_limit
    ), expired AS (
      UPDATE public.cctv_entity_observations o
         SET face_vec = NULL, appearance_vec = NULL, candidate_embedding = NULL, appearance_embedding = NULL,
             attributes = coalesce(o.attributes, '{}'::jsonb) || jsonb_build_object('biometric_templates_expired_at', v_now, 'biometric_templates_expiry_reason',
               CASE WHEN o.review_state = 'rejected' THEN 'rejected' ELSE 'retention_window' END)
        FROM due
       WHERE o.id = due.id
      RETURNING o.organization_id, (o.attributes->>'biometric_templates_expiry_reason') AS reason
    )
    SELECT organization_id, count(*) FILTER (WHERE reason = 'rejected') AS rejected, count(*) FILTER (WHERE reason = 'retention_window') AS aged, count(*) AS total
      FROM expired GROUP BY organization_id
  LOOP
    v_total := v_total + v_org.total;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_org.organization_id, NULL, 'cctv_biometric_templates_expired', 'cctv_entity_observations', NULL,
            jsonb_build_object('expired', v_org.total, 'rejected', v_org.rejected, 'aged_out', v_org.aged, 'retention', p_retention::text, 'expired_at', v_now));
  END LOOP;

  RETURN jsonb_build_object('expired', v_total, 'retention', p_retention::text, 'expired_at', v_now);
END $$;
REVOKE ALL ON FUNCTION public.expire_cctv_biometric_templates(interval, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_cctv_biometric_templates(interval, uuid, integer) TO service_role;
COMMENT ON FUNCTION public.expire_cctv_biometric_templates(interval, uuid, integer) IS
  'Service-only: nulls the biometric template columns on rejected sightings and on undecided sightings older than the retention window (default 90 days). Keeps the sighting, thumbnail and decision. One audit_log row per organisation with counts only.';

-- ── governance readout ──
CREATE OR REPLACE FUNCTION public.cctv_biometric_governance(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_result jsonb;
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.org_access_allowed(p_organization_id) THEN RAISE EXCEPTION 'CCTV governance access denied'; END IF;
  SELECT jsonb_build_object(
    'organization_id', p_organization_id,
    'live_templates', count(*) FILTER (WHERE o.face_vec IS NOT NULL OR o.appearance_vec IS NOT NULL),
    'live_face_templates', count(*) FILTER (WHERE o.face_vec IS NOT NULL),
    'oldest_live_template_at', min(o.created_at) FILTER (WHERE o.face_vec IS NOT NULL OR o.appearance_vec IS NOT NULL),
    'expired_templates', count(*) FILTER (WHERE o.attributes ? 'biometric_templates_expired_at'),
    'rejected_still_holding_templates', count(*) FILTER (WHERE o.review_state = 'rejected' AND (o.face_vec IS NOT NULL OR o.appearance_vec IS NOT NULL)),
    'last_expiry_run_at', (SELECT max(a.created_at) FROM public.audit_log a WHERE a.organization_id = p_organization_id AND a.action = 'cctv_biometric_templates_expired'),
    'purpose', 'Templates are used only to suggest same-or-similar sightings within this organisation; identity is always a reviewer decision.',
    'default_retention', '90 days'
  ) INTO v_result
  FROM public.cctv_entity_observations o
  WHERE o.organization_id = p_organization_id AND o.entity_kind = 'person';
  RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.cctv_biometric_governance(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cctv_biometric_governance(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.cctv_biometric_governance(uuid) IS
  'Org-scoped biometric holdings readout: live/expired template counts, oldest live template, rejected sightings still holding templates, last expiry run, stated purpose and default retention.';

-- ── schedule: daily expiry, in-database (no HTTP hop needed for a pure SQL function) ──
DO $$
DECLARE v_job_id bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN RAISE NOTICE 'pg_cron not present; biometric expiry must be scheduled by the operator'; RETURN; END IF;
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'cctv-biometric-template-expiry-daily' LIMIT 1;
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
  PERFORM cron.schedule_in_database(
    'cctv-biometric-template-expiry-daily',
    '41 3 * * *',
    'select public.expire_cctv_biometric_templates();',
    'postgres',
    null,
    true
  );
END $$;
