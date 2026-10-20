-- Person identity resolution: duplicates, aliases (AKA), merges, face matches,
-- people mentioned at a sighting, and ID evidence submitted by any member.
--
-- Owner ruling 2026-10-21: anyone in the organisation can record a person and
-- submit their ID evidence; an administrator still approves the evidence before
-- the person becomes verified. The system must avoid creating a second profile
-- for someone already known, must let one person carry several names (a
-- preferred name, a legal name, a married name - "also known as"), and must let
-- an administrator merge two profiles that turn out to be the same person,
-- including the "Unknown Person #N" profiles that CCTV face recognition creates.
-- A person mentioned in an observation is added to it as UNCONFIRMED; only a
-- verified person confirmed by an administrator becomes the observation's
-- identity of record (link_observation_entities stays the only path).
--
-- Builds on the existing identity system: person_records, canonical_people,
-- person_identity_documents, review_identity_evidence and
-- resolve_identity_document_person (whose repointing logic merge_person_records
-- generalises).

-- 1. Names -------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_person_name(p_name text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $function$ SELECT nullif(regexp_replace(lower(trim(coalesce(p_name, ''))), '[^a-z0-9]+', '', 'g'), '') $function$;
GRANT EXECUTE ON FUNCTION public.normalize_person_name(text) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.person_record_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  person_record_id uuid NOT NULL REFERENCES public.person_records(id) ON DELETE CASCADE,
  alias text NOT NULL CHECK (length(trim(alias)) BETWEEN 1 AND 200),
  alias_norm text NOT NULL,
  alias_kind text NOT NULL DEFAULT 'aka'
    CHECK (alias_kind IN ('aka', 'preferred_name', 'legal_name', 'previous_name', 'maiden_name', 'nickname', 'merged_record')),
  source text NOT NULL DEFAULT 'user_entered' CHECK (source IN ('user_entered', 'identity_document', 'merge', 'import')),
  notes text,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  retired_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  retired_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_record_aliases_active
  ON public.person_record_aliases (person_record_id, alias_norm) WHERE active;
CREATE INDEX IF NOT EXISTS idx_person_record_aliases_org_norm
  ON public.person_record_aliases (organization_id, alias_norm) WHERE active;
ALTER TABLE public.person_record_aliases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS person_record_aliases_select ON public.person_record_aliases;
CREATE POLICY person_record_aliases_select ON public.person_record_aliases FOR SELECT
  USING (public.org_access_allowed(organization_id));
REVOKE INSERT, UPDATE, DELETE ON public.person_record_aliases FROM anon, authenticated;
COMMENT ON TABLE public.person_record_aliases IS
  'Other names one person is known by (AKA, preferred, legal, previous/maiden name, merged-record names). Written only through add_person_alias, retire_person_alias and merge_person_records.';

CREATE OR REPLACE FUNCTION public.add_person_alias(
  p_person_record_id uuid, p_alias text, p_alias_kind text DEFAULT 'aka', p_notes text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_person public.person_records%rowtype;
  v_norm text := public.normalize_person_name(p_alias);
  v_id uuid;
BEGIN
  SELECT * INTO v_person FROM public.person_records WHERE id = p_person_record_id;
  IF v_actor IS NULL OR v_person.id IS NULL OR NOT public.org_access_allowed(v_person.organization_id) THEN
    RAISE EXCEPTION 'Person record not found in your authorised scope';
  END IF;
  IF v_person.metadata ? 'merged_into_person_record_id' THEN RAISE EXCEPTION 'This person has been merged into another record'; END IF;
  IF v_norm IS NULL THEN RAISE EXCEPTION 'Enter the other name'; END IF;
  IF coalesce(p_alias_kind, 'aka') NOT IN ('aka', 'preferred_name', 'legal_name', 'previous_name', 'maiden_name', 'nickname') THEN
    RAISE EXCEPTION 'Choose what kind of name this is';
  END IF;
  IF v_norm = public.normalize_person_name(v_person.display_name) THEN RAISE EXCEPTION 'That is already the main name of this person'; END IF;
  INSERT INTO public.person_record_aliases (organization_id, person_record_id, alias, alias_norm, alias_kind, source, notes, created_by)
  VALUES (v_person.organization_id, v_person.id, trim(p_alias), v_norm, coalesce(p_alias_kind, 'aka'), 'user_entered', nullif(trim(p_notes), ''), v_actor)
  ON CONFLICT (person_record_id, alias_norm) WHERE active DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'This person already has that name recorded'; END IF;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_person.organization_id, v_actor, 'person_alias_added', 'person_record_aliases', v_id,
    jsonb_build_object('person_record_id', v_person.id, 'alias_kind', coalesce(p_alias_kind, 'aka')));
  RETURN jsonb_build_object('alias_id', v_id, 'person_record_id', v_person.id);
END;
$function$;
REVOKE ALL ON FUNCTION public.add_person_alias(uuid,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_person_alias(uuid,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.retire_person_alias(p_alias_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_alias public.person_record_aliases%rowtype;
BEGIN
  SELECT * INTO v_alias FROM public.person_record_aliases WHERE id = p_alias_id AND active FOR UPDATE;
  IF v_actor IS NULL OR v_alias.id IS NULL OR NOT public.org_access_allowed(v_alias.organization_id) THEN
    RAISE EXCEPTION 'Name not found in your authorised scope';
  END IF;
  IF v_alias.created_by IS DISTINCT FROM v_actor AND NOT public.is_admin_for_org(v_alias.organization_id) THEN
    RAISE EXCEPTION 'Only the person who added this name or an administrator can remove it';
  END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  UPDATE public.person_record_aliases SET active = false, retired_at = clock_timestamp(), retired_by = v_actor, retired_reason = trim(p_reason)
  WHERE id = v_alias.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_alias.organization_id, v_actor, 'person_alias_retired', 'person_record_aliases', v_alias.id,
    jsonb_build_object('person_record_id', v_alias.person_record_id, 'reason', trim(p_reason)));
END;
$function$;
REVOKE ALL ON FUNCTION public.retire_person_alias(uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retire_person_alias(uuid,text) TO authenticated;

-- 2. Duplicate finder ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.find_person_matches(
  p_organization_id uuid,
  p_name text DEFAULT NULL,
  p_date_of_birth date DEFAULT NULL,
  p_licence_number text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_exclude_person_record_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 8
) RETURNS TABLE(
  person_record_id uuid, display_name text, review_state text, matched_name text, match_basis text,
  score real, strength text, aliases text[], locality text, origin text, sighting_count bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_norm text := public.normalize_person_name(p_name);
  v_lower text := nullif(lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g')), '');
  v_first text;
  v_last text;
  v_licence text := nullif(upper(regexp_replace(coalesce(p_licence_number, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN RETURN; END IF;
  IF v_norm IS NULL AND v_licence IS NULL AND (v_phone IS NULL OR length(v_phone) < 7) AND v_email IS NULL THEN RETURN; END IF;
  IF v_lower IS NOT NULL THEN
    v_first := split_part(v_lower, ' ', 1);
    v_last := CASE WHEN position(' ' IN v_lower) > 0 THEN regexp_replace(v_lower, '^.* ', '') END;
  END IF;
  IF v_phone IS NOT NULL AND length(v_phone) < 7 THEN v_phone := NULL; END IF;

  RETURN QUERY
  WITH people AS (
    SELECT pr.id, pr.display_name, pr.review_state, pr.metadata,
      coalesce(pr.metadata->'profile_details', '{}'::jsonb) AS details
    FROM public.person_records pr
    WHERE pr.organization_id = p_organization_id
      AND pr.id IS DISTINCT FROM p_exclude_person_record_id
      AND NOT (pr.metadata ? 'merged_into_person_record_id')
      AND NOT (pr.metadata ? 'resolved_into_person_record_id')
  ), names AS (
    SELECT p.id, p.display_name AS name, 'display_name'::text AS name_kind FROM people p WHERE p.display_name IS NOT NULL
    UNION ALL
    SELECT a.person_record_id, a.alias, 'alias' FROM public.person_record_aliases a
    JOIN people p ON p.id = a.person_record_id WHERE a.active
  ), name_hits AS (
    SELECT n.id, n.name,
      CASE
        WHEN public.normalize_person_name(n.name) = v_norm THEN
          CASE WHEN n.name_kind = 'alias' THEN 'alias_exact' ELSE 'name_exact' END
        WHEN v_last IS NOT NULL AND lower(regexp_replace(trim(n.name), '^.* ', '')) = v_last
          AND length(v_first) >= 2 AND length(split_part(lower(trim(n.name)), ' ', 1)) >= 2
          AND (position(v_first IN split_part(lower(trim(n.name)), ' ', 1)) > 0
               OR position(split_part(lower(trim(n.name)), ' ', 1) IN v_first) > 0) THEN 'name_variant'
        ELSE 'name_similar'
      END AS basis,
      CASE
        WHEN public.normalize_person_name(n.name) = v_norm THEN 0.85
        WHEN v_last IS NOT NULL AND lower(regexp_replace(trim(n.name), '^.* ', '')) = v_last
          AND length(v_first) >= 2 AND length(split_part(lower(trim(n.name)), ' ', 1)) >= 2
          AND (position(v_first IN split_part(lower(trim(n.name)), ' ', 1)) > 0
               OR position(split_part(lower(trim(n.name)), ' ', 1) IN v_first) > 0) THEN 0.72
        ELSE 0.40 + 0.40 * extensions.similarity(lower(n.name), v_lower)
      END::real AS score
    FROM names n
    WHERE v_norm IS NOT NULL AND (
      public.normalize_person_name(n.name) = v_norm
      OR extensions.similarity(lower(n.name), v_lower) >= 0.45
      OR (v_last IS NOT NULL AND lower(regexp_replace(trim(n.name), '^.* ', '')) = v_last
          AND length(v_first) >= 2 AND length(split_part(lower(trim(n.name)), ' ', 1)) >= 2
          AND (position(v_first IN split_part(lower(trim(n.name)), ' ', 1)) > 0
               OR position(split_part(lower(trim(n.name)), ' ', 1) IN v_first) > 0))
    )
  ), detail_hits AS (
    SELECT p.id, p.display_name AS name,
      CASE
        WHEN v_licence IS NOT NULL AND v_licence IN (
          upper(regexp_replace(coalesce(p.details->>'driver_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'firearms_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'security_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'document_number', ''), '[^A-Za-z0-9]', '', 'g'))) THEN 'credential_number_exact'
        WHEN v_phone IS NOT NULL AND regexp_replace(coalesce(p.details->>'phone', ''), '[^0-9]', '', 'g') = v_phone THEN 'phone_exact'
        ELSE 'email_exact'
      END AS basis,
      CASE
        WHEN v_licence IS NOT NULL AND v_licence IN (
          upper(regexp_replace(coalesce(p.details->>'driver_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'firearms_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'security_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'document_number', ''), '[^A-Za-z0-9]', '', 'g'))) THEN 1.0
        ELSE 0.90
      END::real AS score
    FROM people p
    WHERE (v_licence IS NOT NULL AND v_licence IN (
          upper(regexp_replace(coalesce(p.details->>'driver_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'firearms_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'security_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
          upper(regexp_replace(coalesce(p.details->>'document_number', ''), '[^A-Za-z0-9]', '', 'g'))))
      OR (v_phone IS NOT NULL AND regexp_replace(coalesce(p.details->>'phone', ''), '[^0-9]', '', 'g') = v_phone)
      OR (v_email IS NOT NULL AND lower(trim(coalesce(p.details->>'email', ''))) = v_email)
  ), hits AS (
    SELECT h.id, h.name, h.basis,
      -- A matching date of birth turns a name match into a strong match.
      CASE WHEN p_date_of_birth IS NOT NULL AND nullif(p.details->>'date_of_birth', '')::date = p_date_of_birth
        THEN greatest(h.score, 0.97)::real ELSE h.score END AS score,
      (p_date_of_birth IS NOT NULL AND nullif(p.details->>'date_of_birth', '')::date = p_date_of_birth) AS dob_match
    FROM (SELECT * FROM name_hits UNION ALL SELECT * FROM detail_hits) h
    JOIN people p ON p.id = h.id
  ), ranked AS (
    SELECT DISTINCT ON (h.id) h.id, h.name, h.basis || CASE WHEN h.dob_match THEN '+date_of_birth' ELSE '' END AS basis, h.score
    FROM hits h ORDER BY h.id, h.score DESC
  )
  SELECT p.id, p.display_name, p.review_state, r.name, r.basis, r.score,
    CASE WHEN r.score >= 0.95 THEN 'strong' WHEN r.score >= 0.80 THEN 'likely' ELSE 'possible' END,
    coalesce(ARRAY(SELECT a.alias FROM public.person_record_aliases a WHERE a.person_record_id = p.id AND a.active ORDER BY a.created_at), ARRAY[]::text[]),
    public.vehicle_owner_locality(p.details),
    coalesce(p.metadata->>'origin', p.metadata->>'created_from'),
    (SELECT count(*) FROM public.cctv_entity_observations c WHERE c.person_record_id = p.id)
      + (SELECT count(*) FROM public.observations o WHERE o.person_record_id = p.id)
  FROM ranked r JOIN people p ON p.id = r.id
  ORDER BY r.score DESC, p.review_state = 'verified' DESC, p.display_name
  LIMIT least(greatest(coalesce(p_limit, 8), 1), 25);
END;
$function$;
REVOKE ALL ON FUNCTION public.find_person_matches(uuid,text,date,text,text,text,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.find_person_matches(uuid,text,date,text,text,text,uuid,integer) TO authenticated;
COMMENT ON FUNCTION public.find_person_matches(uuid,text,date,text,text,text,uuid,integer) IS
  'Possible existing people for a name/date of birth/licence/phone/email, including other names (AKA) and name variants (Don / Adonijah Squires). Used before creating a person so the organisation does not hold two profiles for one person. Returns locality only, never the address.';

-- Refuses an obviously duplicate new person unless the caller confirmed it is new.
CREATE OR REPLACE FUNCTION public.assert_new_person_not_duplicate(p_organization_id uuid, p_fields jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_names text;
BEGIN
  IF coalesce((p_fields->>'confirm_new_person')::boolean, false) THEN RETURN; END IF;
  SELECT string_agg(m.display_name, ', ') INTO v_names
  FROM public.find_person_matches(p_organization_id, p_fields->>'display_name', nullif(p_fields->>'date_of_birth', '')::date,
    p_fields->>'licence_number', p_fields->>'phone', p_fields->>'email', NULL, 5) m
  WHERE m.score >= 0.85;
  IF v_names IS NOT NULL THEN
    RAISE EXCEPTION 'POSSIBLE_DUPLICATE: % may already be recorded. Choose the existing person, or confirm this is a different person.', v_names;
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.assert_new_person_not_duplicate(uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- 3. Face similarity suggestions (administrators; biometric) -------------------
CREATE OR REPLACE FUNCTION public.get_person_face_matches(p_person_record_id uuid, p_limit integer DEFAULT 10)
RETURNS TABLE(person_record_id uuid, display_name text, review_state text, score real, sighting_count bigint, last_seen_at timestamptz, thumbnail text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_person public.person_records%rowtype;
BEGIN
  SELECT * INTO v_person FROM public.person_records WHERE id = p_person_record_id;
  IF auth.uid() IS NULL OR v_person.id IS NULL OR NOT public.is_admin_for_org(v_person.organization_id) THEN RETURN; END IF;
  RETURN QUERY
  WITH mine AS (
    SELECT t.face_vec FROM public.person_face_templates t WHERE t.person_record_id = v_person.id
    UNION ALL
    SELECT c.face_vec FROM public.cctv_entity_observations c WHERE c.person_record_id = v_person.id AND c.face_vec IS NOT NULL
  ), theirs AS (
    SELECT c.person_record_id AS pid, c.face_vec, c.observed_at, c.thumbnail FROM public.cctv_entity_observations c
    WHERE c.organization_id = v_person.organization_id AND c.entity_kind = 'person' AND c.face_vec IS NOT NULL
      AND c.person_record_id IS NOT NULL AND c.person_record_id <> v_person.id
    UNION ALL
    SELECT t.person_record_id, t.face_vec, t.approved_at, NULL FROM public.person_face_templates t
    WHERE t.organization_id = v_person.organization_id AND t.person_record_id <> v_person.id
  ), scored AS (
    SELECT th.pid, max((1 - (th.face_vec OPERATOR(public.<=>) m.face_vec))::real) AS score,
      max(th.observed_at) AS seen, (array_agg(th.thumbnail ORDER BY th.observed_at DESC) FILTER (WHERE th.thumbnail IS NOT NULL))[1] AS thumb
    FROM theirs th CROSS JOIN mine m GROUP BY th.pid
  )
  SELECT p.id, p.display_name, p.review_state, s.score,
    (SELECT count(*) FROM public.cctv_entity_observations c WHERE c.person_record_id = p.id), s.seen, s.thumb
  FROM scored s JOIN public.person_records p ON p.id = s.pid
  WHERE s.score >= 0.65 AND NOT (p.metadata ? 'merged_into_person_record_id') AND NOT (p.metadata ? 'resolved_into_person_record_id')
  ORDER BY s.score DESC LIMIT least(greatest(coalesce(p_limit, 10), 1), 25);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_person_face_matches(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_person_face_matches(uuid,integer) TO authenticated;
COMMENT ON FUNCTION public.get_person_face_matches(uuid,integer) IS
  'Other profiles (for example CCTV "Unknown Person #N") whose faces resemble this person, at the 0.65 face threshold used by find_cctv_portfolio_matches. Administrators only; a suggestion for human review, never an identification.';

-- 4. People mentioned at a sighting ------------------------------------------
CREATE TABLE IF NOT EXISTS public.observation_person_mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES public.observations(id) ON DELETE CASCADE,
  person_record_id uuid NOT NULL REFERENCES public.person_records(id) ON DELETE CASCADE,
  mention_role text NOT NULL DEFAULT 'mentioned'
    CHECK (mention_role IN ('mentioned', 'driver', 'passenger', 'occupant', 'witness', 'other')),
  status text NOT NULL DEFAULT 'unconfirmed' CHECK (status IN ('unconfirmed', 'confirmed', 'dismissed')),
  basis text NOT NULL,
  mention_text text,
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_notes text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_observation_person_mentions_open
  ON public.observation_person_mentions (observation_id, person_record_id) WHERE status <> 'dismissed';
CREATE INDEX IF NOT EXISTS idx_observation_person_mentions_person ON public.observation_person_mentions (person_record_id);
ALTER TABLE public.observation_person_mentions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS observation_person_mentions_select ON public.observation_person_mentions;
CREATE POLICY observation_person_mentions_select ON public.observation_person_mentions FOR SELECT
  USING (public.org_access_allowed(organization_id));
REVOKE INSERT, UPDATE, DELETE ON public.observation_person_mentions FROM anon, authenticated;
COMMENT ON TABLE public.observation_person_mentions IS
  'People mentioned at a sighting. Unconfirmed until an administrator confirms a verified person; observations.person_record_id remains the identity of record.';

CREATE OR REPLACE FUNCTION public.record_observation_person_mention(
  p_observation_id uuid,
  p_person_record_id uuid DEFAULT NULL,
  p_person_fields jsonb DEFAULT NULL,
  p_mention_role text DEFAULT 'mentioned',
  p_basis text DEFAULT NULL,
  p_mention_text text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_obs_org uuid;
  v_person_id uuid := p_person_record_id;
  v_person_org uuid;
  v_name text := nullif(trim(p_person_fields->>'display_name'), '');
  v_details jsonb;
  v_id uuid;
BEGIN
  SELECT o.organization_id INTO v_obs_org FROM public.observations o WHERE o.id = p_observation_id;
  IF v_actor IS NULL OR v_obs_org IS NULL OR NOT public.org_access_allowed(v_obs_org) THEN
    RAISE EXCEPTION 'Observation not found in your authorised scope';
  END IF;
  IF coalesce(p_mention_role, 'mentioned') NOT IN ('mentioned', 'driver', 'passenger', 'occupant', 'witness', 'other') THEN
    RAISE EXCEPTION 'Choose how this person relates to the sighting';
  END IF;
  IF coalesce(trim(p_basis), '') = '' THEN RAISE EXCEPTION 'Say how this person came up at the sighting'; END IF;

  IF v_person_id IS NULL THEN
    IF v_name IS NULL THEN RAISE EXCEPTION 'Choose an existing person or enter their name'; END IF;
    PERFORM public.assert_new_person_not_duplicate(v_obs_org, p_person_fields);
    v_details := jsonb_strip_nulls(jsonb_build_object(
      'date_of_birth', nullif(p_person_fields->>'date_of_birth', ''),
      'phone', nullif(trim(p_person_fields->>'phone'), ''),
      'email', nullif(trim(p_person_fields->>'email'), ''),
      'suburb', nullif(trim(p_person_fields->>'suburb'), ''),
      'city', nullif(trim(p_person_fields->>'city'), ''),
      'notes', nullif(trim(p_person_fields->>'notes'), '')));
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (v_obs_org, v_name, 'manual_review_required',
      jsonb_build_object('profile_details', v_details, 'created_from', 'observation_mention', 'created_by', v_actor,
        'first_observation_id', p_observation_id))
    RETURNING id INTO v_person_id;
    PERFORM public.ensure_canonical_person_for_record(v_person_id);
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_obs_org, v_actor, 'identity_person_create', 'person_records', v_person_id,
      jsonb_build_object('reason', 'Mentioned at sighting: ' || trim(p_basis), 'observation_id', p_observation_id,
        'fields', array(SELECT jsonb_object_keys(v_details))));
  ELSE
    SELECT pr.organization_id INTO v_person_org FROM public.person_records pr WHERE pr.id = v_person_id;
    IF v_person_org IS NULL OR NOT public.org_access_allowed(v_person_org) THEN RAISE EXCEPTION 'Person record not found in your authorised scope'; END IF;
    IF EXISTS (SELECT 1 FROM public.person_records pr WHERE pr.id = v_person_id AND pr.metadata ? 'merged_into_person_record_id') THEN
      RAISE EXCEPTION 'This person has been merged into another record';
    END IF;
  END IF;

  INSERT INTO public.observation_person_mentions (organization_id, observation_id, person_record_id, mention_role, basis, mention_text, created_by)
  VALUES (v_obs_org, p_observation_id, v_person_id, coalesce(p_mention_role, 'mentioned'), trim(p_basis), nullif(trim(p_mention_text), ''), v_actor)
  ON CONFLICT (observation_id, person_record_id) WHERE status <> 'dismissed' DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RAISE EXCEPTION 'This person is already recorded at this sighting'; END IF;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_obs_org, v_actor, 'observation_person_mentioned', 'observation_person_mentions', v_id,
    jsonb_build_object('observation_id', p_observation_id, 'person_record_id', v_person_id, 'mention_role', coalesce(p_mention_role, 'mentioned')));
  RETURN jsonb_build_object('mention_id', v_id, 'person_record_id', v_person_id, 'status', 'unconfirmed');
END;
$function$;
REVOKE ALL ON FUNCTION public.record_observation_person_mention(uuid,uuid,jsonb,text,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_observation_person_mention(uuid,uuid,jsonb,text,text,text) TO authenticated;

CREATE OR REPLACE FUNCTION public.review_observation_person_mention(
  p_mention_id uuid, p_action text, p_notes text DEFAULT NULL, p_set_identity_of_record boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_mention public.observation_person_mentions%rowtype;
  v_person public.person_records%rowtype;
BEGIN
  SELECT * INTO v_mention FROM public.observation_person_mentions WHERE id = p_mention_id FOR UPDATE;
  IF v_actor IS NULL OR v_mention.id IS NULL OR NOT public.org_access_allowed(v_mention.organization_id) THEN
    RAISE EXCEPTION 'Mention not found in your authorised scope';
  END IF;
  IF p_action NOT IN ('confirm', 'dismiss') THEN RAISE EXCEPTION 'Unsupported action'; END IF;
  IF v_mention.status <> 'unconfirmed' AND NOT (p_action = 'confirm' AND p_set_identity_of_record AND v_mention.status = 'confirmed') THEN
    RAISE EXCEPTION 'This mention has already been reviewed';
  END IF;
  IF coalesce(trim(p_notes), '') = '' THEN RAISE EXCEPTION 'Review notes are required'; END IF;
  IF p_action = 'dismiss' THEN
    IF v_mention.created_by IS DISTINCT FROM v_actor AND NOT public.is_admin_for_org(v_mention.organization_id) THEN
      RAISE EXCEPTION 'Only the person who recorded this mention or an administrator can dismiss it';
    END IF;
  ELSE
    IF NOT public.is_admin_for_org(v_mention.organization_id) THEN RAISE EXCEPTION 'An administrator confirms people at a sighting'; END IF;
    SELECT * INTO v_person FROM public.person_records WHERE id = v_mention.person_record_id;
    IF v_person.review_state <> 'verified' THEN
      RAISE EXCEPTION 'Verify this person''s identity (approved ID evidence) before confirming them at the sighting';
    END IF;
    IF p_set_identity_of_record THEN
      -- The existing governed path enforces administrator, verified person and verified canonical identity.
      PERFORM public.link_observation_entities(v_mention.observation_id, v_mention.organization_id, NULL, v_mention.person_record_id,
        NULL, NULL, NULL, NULL, trim(p_notes));
    END IF;
  END IF;
  UPDATE public.observation_person_mentions
  SET status = CASE WHEN p_action = 'confirm' THEN 'confirmed' ELSE 'dismissed' END,
      reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = trim(p_notes)
  WHERE id = v_mention.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_mention.organization_id, v_actor,
    CASE WHEN p_action = 'confirm' THEN 'observation_person_confirmed' ELSE 'observation_person_dismissed' END,
    'observation_person_mentions', v_mention.id,
    jsonb_build_object('observation_id', v_mention.observation_id, 'person_record_id', v_mention.person_record_id,
      'identity_of_record', p_action = 'confirm' AND p_set_identity_of_record, 'notes', trim(p_notes)));
  RETURN jsonb_build_object('mention_id', v_mention.id, 'status', CASE WHEN p_action = 'confirm' THEN 'confirmed' ELSE 'dismissed' END,
    'identity_of_record', p_action = 'confirm' AND p_set_identity_of_record);
END;
$function$;
REVOKE ALL ON FUNCTION public.review_observation_person_mention(uuid,text,text,boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_observation_person_mention(uuid,text,text,boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_observation_people(p_observation_id uuid)
RETURNS TABLE(
  mention_id uuid, person_record_id uuid, display_name text, review_state text, aliases text[],
  mention_role text, status text, basis text, mention_text text, is_identity_of_record boolean,
  recorded_by_name text, recorded_at timestamptz, reviewed_at timestamptz, review_notes text, can_dismiss boolean
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_obs public.observations%rowtype;
  v_admin boolean;
BEGIN
  SELECT * INTO v_obs FROM public.observations WHERE id = p_observation_id;
  IF auth.uid() IS NULL OR v_obs.id IS NULL OR NOT public.org_access_allowed(v_obs.organization_id) THEN RETURN; END IF;
  v_admin := public.is_admin_for_org(v_obs.organization_id);
  RETURN QUERY
  SELECT m.id, p.id, p.display_name, p.review_state,
    coalesce(ARRAY(SELECT a.alias FROM public.person_record_aliases a WHERE a.person_record_id = p.id AND a.active ORDER BY a.created_at), ARRAY[]::text[]),
    m.mention_role, m.status, m.basis, m.mention_text, p.id = v_obs.person_record_id,
    u.display_name, m.created_at, m.reviewed_at, m.review_notes,
    m.status = 'unconfirmed' AND (v_admin OR m.created_by = auth.uid())
  FROM public.observation_person_mentions m
  JOIN public.person_records p ON p.id = m.person_record_id
  LEFT JOIN public.user_profiles u ON u.id = m.created_by
  WHERE m.observation_id = v_obs.id AND m.status <> 'dismissed'
  UNION ALL
  SELECT NULL::uuid, p.id, p.display_name, p.review_state,
    coalesce(ARRAY(SELECT a.alias FROM public.person_record_aliases a WHERE a.person_record_id = p.id AND a.active ORDER BY a.created_at), ARRAY[]::text[]),
    'identity_of_record', 'confirmed', NULL, NULL, true, NULL, NULL, NULL, NULL, false
  FROM public.person_records p
  WHERE p.id = v_obs.person_record_id
    AND NOT EXISTS (SELECT 1 FROM public.observation_person_mentions m WHERE m.observation_id = v_obs.id AND m.person_record_id = p.id AND m.status <> 'dismissed');
END;
$function$;
REVOKE ALL ON FUNCTION public.get_observation_people(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_observation_people(uuid) TO authenticated;

-- 5. Person identity summary (any member; counts only, no document content) ---
CREATE OR REPLACE FUNCTION public.get_person_identity_summary(p_person_record_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_person public.person_records%rowtype;
  v_admin boolean;
BEGIN
  SELECT * INTO v_person FROM public.person_records WHERE id = p_person_record_id;
  IF auth.uid() IS NULL OR v_person.id IS NULL OR NOT public.org_access_allowed(v_person.organization_id) THEN RETURN NULL; END IF;
  v_admin := public.is_admin_for_org(v_person.organization_id);
  RETURN jsonb_build_object(
    'person_record_id', v_person.id,
    'organization_id', v_person.organization_id,
    'display_name', v_person.display_name,
    'review_state', v_person.review_state,
    'verified', v_person.review_state = 'verified',
    'verified_at', v_person.metadata->>'identity_verified_at',
    'origin', coalesce(v_person.metadata->>'origin', v_person.metadata->>'created_from'),
    'merged_into_person_record_id', coalesce(v_person.metadata->>'merged_into_person_record_id', v_person.metadata->>'resolved_into_person_record_id'),
    'pending_documents', (SELECT count(*) FROM public.person_identity_documents d WHERE d.person_record_id = v_person.id AND d.review_state = 'manual_review_required'),
    'approved_documents', (SELECT count(*) FROM public.person_identity_documents d WHERE d.person_record_id = v_person.id AND d.review_state = 'approved'),
    'has_face_reference', EXISTS (SELECT 1 FROM public.person_face_templates t WHERE t.person_record_id = v_person.id)
      OR EXISTS (SELECT 1 FROM public.cctv_entity_observations c WHERE c.person_record_id = v_person.id AND c.face_vec IS NOT NULL),
    'sighting_count', (SELECT count(*) FROM public.cctv_entity_observations c WHERE c.person_record_id = v_person.id)
      + (SELECT count(*) FROM public.observations o WHERE o.person_record_id = v_person.id)
      + (SELECT count(*) FROM public.observation_person_mentions m WHERE m.person_record_id = v_person.id AND m.status <> 'dismissed'),
    'aliases', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'alias', a.alias, 'alias_kind', a.alias_kind, 'source', a.source,
        'can_remove', a.created_by = auth.uid() OR v_admin) ORDER BY a.created_at)
      FROM public.person_record_aliases a WHERE a.person_record_id = v_person.id AND a.active), '[]'::jsonb),
    'can_review', v_admin,
    'can_merge', v_admin);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_person_identity_summary(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_person_identity_summary(uuid) TO authenticated;

-- 6. Merge two profiles of the same person -------------------------------------
CREATE OR REPLACE FUNCTION public.merge_person_records(
  p_organization_id uuid, p_source_person_record_id uuid, p_target_person_record_id uuid,
  p_reason text, p_display_name text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_source public.person_records%rowtype;
  v_target public.person_records%rowtype;
  v_source_canonical uuid;
  v_target_canonical uuid;
  v_link record;
  v_incident_link public.incident_person_links%rowtype;
  v_name text;
  v_counts jsonb := '{}'::jsonb;
  v_n integer;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'An administrator merges person records'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'Say why these are the same person'; END IF;
  SELECT * INTO v_source FROM public.person_records WHERE id = p_source_person_record_id AND organization_id = p_organization_id FOR UPDATE;
  SELECT * INTO v_target FROM public.person_records WHERE id = p_target_person_record_id AND organization_id = p_organization_id FOR UPDATE;
  IF v_source.id IS NULL OR v_target.id IS NULL OR v_source.id = v_target.id THEN RAISE EXCEPTION 'Choose two different people in this organisation'; END IF;
  IF v_source.metadata ? 'merged_into_person_record_id' OR v_target.metadata ? 'merged_into_person_record_id'
     OR v_source.metadata ? 'resolved_into_person_record_id' OR v_target.metadata ? 'resolved_into_person_record_id' THEN
    RAISE EXCEPTION 'One of these records has already been merged';
  END IF;
  IF v_source.review_state = 'verified' AND v_target.review_state <> 'verified' THEN
    RAISE EXCEPTION 'Keep the verified record: merge the unverified profile into the verified one';
  END IF;
  IF nullif(v_source.metadata->'profile_details'->>'staff_profile_id', '') IS NOT NULL
     AND nullif(v_target.metadata->'profile_details'->>'staff_profile_id', '') IS NOT NULL
     AND v_source.metadata->'profile_details'->>'staff_profile_id' <> v_target.metadata->'profile_details'->>'staff_profile_id' THEN
    RAISE EXCEPTION 'Both records belong to different staff members';
  END IF;
  v_source_canonical := public.ensure_canonical_person_for_record(v_source.id);
  v_target_canonical := public.ensure_canonical_person_for_record(v_target.id);

  -- Identity evidence and biometrics follow the person.
  UPDATE public.person_identity_documents SET person_record_id = v_target.id, updated_at = clock_timestamp() WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('identity_documents', v_n);
  UPDATE public.person_identity_face_proposals SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  DELETE FROM public.person_face_templates s WHERE s.person_record_id = v_source.id AND EXISTS (
    SELECT 1 FROM public.person_face_templates t WHERE t.person_record_id = v_target.id AND t.organization_id = s.organization_id
      AND t.source_kind = s.source_kind AND t.source_ref = s.source_ref);
  UPDATE public.person_face_templates SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('face_templates', v_n);

  -- Incidents (unique per incident, canonical person and role).
  FOR v_incident_link IN SELECT * FROM public.incident_person_links WHERE person_record_id = v_source.id LOOP
    INSERT INTO public.incident_person_links(organization_id, incident_id, canonical_person_id, person_record_id, staff_profile_id, identity_document_id,
      involvement_role, source_kind, notes, recorded_by, created_at, updated_at)
    VALUES (v_incident_link.organization_id, v_incident_link.incident_id, v_target_canonical, v_target.id,
      coalesce(nullif(v_target.metadata->'profile_details'->>'staff_profile_id', '')::uuid, v_incident_link.staff_profile_id),
      v_incident_link.identity_document_id, v_incident_link.involvement_role, v_incident_link.source_kind, v_incident_link.notes,
      v_actor, v_incident_link.created_at, clock_timestamp())
    ON CONFLICT (incident_id, canonical_person_id, involvement_role) DO UPDATE SET
      person_record_id = excluded.person_record_id,
      identity_document_id = coalesce(incident_person_links.identity_document_id, excluded.identity_document_id),
      updated_at = clock_timestamp();
  END LOOP;
  DELETE FROM public.incident_person_links WHERE person_record_id = v_source.id;

  -- Sightings, CCTV and reviews.
  UPDATE public.cctv_entity_observations SET person_record_id = v_target.id, canonical_person_id = v_target_canonical WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('cctv_sightings', v_n);
  UPDATE public.face_observations SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  UPDATE public.observations SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('observations', v_n);
  UPDATE public.cctv_identity_drafts SET proposed_person_record_id = v_target.id WHERE proposed_person_record_id = v_source.id;
  UPDATE public.cctv_identity_drafts SET final_person_record_id = v_target.id WHERE final_person_record_id = v_source.id;
  UPDATE public.cctv_review_event_decisions SET linked_person_record_id = v_target.id WHERE linked_person_record_id = v_source.id;
  UPDATE public.cctv_review_events SET linked_person_record_id = v_target.id WHERE linked_person_record_id = v_source.id;
  UPDATE public.vehicle_identity_checks SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  DELETE FROM public.observation_person_mentions s WHERE s.person_record_id = v_source.id AND s.status <> 'dismissed' AND EXISTS (
    SELECT 1 FROM public.observation_person_mentions t WHERE t.person_record_id = v_target.id AND t.observation_id = s.observation_id AND t.status <> 'dismissed');
  UPDATE public.observation_person_mentions SET person_record_id = v_target.id WHERE person_record_id = v_source.id;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_counts := v_counts || jsonb_build_object('sighting_mentions', v_n);

  -- Vehicle people and other graph edges keyed by canonical person.
  FOR v_link IN SELECT * FROM public.entity_links WHERE from_type = 'person' AND from_id = v_source_canonical AND active LOOP
    IF EXISTS (SELECT 1 FROM public.entity_links t WHERE t.organization_id = v_link.organization_id AND t.from_type = 'person'
        AND t.from_id = v_target_canonical AND t.to_type = v_link.to_type AND t.to_id = v_link.to_id AND t.relationship = v_link.relationship AND t.active) THEN
      UPDATE public.entity_links t SET evidence = t.evidence || jsonb_build_object('observation_ids', (
          SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(t.evidence->'observation_ids', '[]'::jsonb) || coalesce(v_link.evidence->'observation_ids', '[]'::jsonb)) item)),
        updated_at = clock_timestamp()
      WHERE t.organization_id = v_link.organization_id AND t.from_type = 'person' AND t.from_id = v_target_canonical
        AND t.to_type = v_link.to_type AND t.to_id = v_link.to_id AND t.relationship = v_link.relationship AND t.active;
      UPDATE public.entity_links SET active = false, ends_at = clock_timestamp(), updated_at = clock_timestamp(),
        evidence = evidence || jsonb_build_object('merged_into_canonical_person_id', v_target_canonical)
      WHERE id = v_link.id;
    ELSE
      UPDATE public.entity_links SET from_id = v_target_canonical, updated_at = clock_timestamp(),
        evidence = evidence || jsonb_build_object('person_record_id', v_target.id, 'merged_from_person_record_id', v_source.id)
      WHERE id = v_link.id;
    END IF;
  END LOOP;
  UPDATE public.entity_links SET from_id = v_target_canonical, updated_at = clock_timestamp()
  WHERE from_type = 'person' AND from_id = v_source_canonical AND NOT active;
  UPDATE public.entity_links SET to_id = v_target_canonical, updated_at = clock_timestamp()
  WHERE to_type = 'person' AND to_id = v_source_canonical;
  UPDATE public.entity_flags SET entity_id = v_target_canonical WHERE entity_type = 'person' AND entity_id = v_source_canonical;

  -- Names: the other profile's name becomes an AKA of the kept person.
  v_name := coalesce(nullif(trim(p_display_name), ''), v_target.display_name);
  IF public.normalize_person_name(v_name) IS NULL THEN RAISE EXCEPTION 'The kept person needs a name'; END IF;
  UPDATE public.person_record_aliases s SET active = false, retired_at = clock_timestamp(), retired_by = v_actor, retired_reason = 'Duplicate after merge'
  WHERE s.person_record_id = v_source.id AND s.active AND EXISTS (
    SELECT 1 FROM public.person_record_aliases t WHERE t.person_record_id = v_target.id AND t.active AND t.alias_norm = s.alias_norm);
  UPDATE public.person_record_aliases SET person_record_id = v_target.id, organization_id = p_organization_id WHERE person_record_id = v_source.id;
  INSERT INTO public.person_record_aliases (organization_id, person_record_id, alias, alias_norm, alias_kind, source, notes, created_by)
  SELECT p_organization_id, v_target.id, n.name, public.normalize_person_name(n.name), 'merged_record', 'merge', trim(p_reason), v_actor
  FROM (VALUES (v_source.display_name), (v_target.display_name)) n(name)
  WHERE public.normalize_person_name(n.name) IS NOT NULL AND public.normalize_person_name(n.name) <> public.normalize_person_name(v_name)
  ON CONFLICT (person_record_id, alias_norm) WHERE active DO NOTHING;
  -- Kept name is no longer an alias of itself.
  UPDATE public.person_record_aliases SET active = false, retired_at = clock_timestamp(), retired_by = v_actor, retired_reason = 'Now the main name'
  WHERE person_record_id = v_target.id AND active AND alias_norm = public.normalize_person_name(v_name);

  UPDATE public.person_records SET
    display_name = v_name,
    metadata = metadata
      || jsonb_build_object('profile_details', coalesce(v_source.metadata->'profile_details', '{}'::jsonb) || coalesce(metadata->'profile_details', '{}'::jsonb))
      || CASE WHEN NOT (metadata ? 'face_reference') AND v_source.metadata ? 'face_reference'
           THEN jsonb_build_object('face_reference', v_source.metadata->'face_reference') ELSE '{}'::jsonb END
      || jsonb_build_object('merged_from_person_record_ids',
           coalesce(metadata->'merged_from_person_record_ids', '[]'::jsonb) || jsonb_build_array(v_source.id))
  WHERE id = v_target.id;
  UPDATE public.canonical_people SET display_name = v_name, normalized_name = public.normalize_person_name(v_name), updated_at = clock_timestamp()
  WHERE id = v_target_canonical;

  UPDATE public.canonical_person_links SET canonical_person_id = v_target_canonical,
    metadata = metadata || jsonb_build_object('merged_from_canonical_person_id', v_source_canonical, 'merged_by', v_actor, 'merged_at', clock_timestamp())
  WHERE source_table = 'person_records' AND source_id = v_source.id;
  IF NOT EXISTS (SELECT 1 FROM public.canonical_person_links WHERE canonical_person_id = v_source_canonical) THEN
    UPDATE public.canonical_people SET status = 'merged', merged_into_id = v_target_canonical, updated_at = clock_timestamp() WHERE id = v_source_canonical;
  END IF;
  UPDATE public.person_records SET review_state = 'rejected',
    metadata = metadata || jsonb_build_object('merged_into_person_record_id', v_target.id, 'merged_at', clock_timestamp(),
      'merged_by', v_actor, 'merge_reason', trim(p_reason))
  WHERE id = v_source.id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'person_records_merged', 'person_records', v_target.id, jsonb_build_object(
    'source_person_record_id', v_source.id, 'source_display_name', v_source.display_name,
    'target_person_record_id', v_target.id, 'kept_display_name', v_name,
    'source_canonical_person_id', v_source_canonical, 'target_canonical_person_id', v_target_canonical,
    'moved', v_counts, 'reason', trim(p_reason)));
  RETURN jsonb_build_object('person_record_id', v_target.id, 'merged_person_record_id', v_source.id,
    'canonical_person_id', v_target_canonical, 'display_name', v_name, 'moved', v_counts);
END;
$function$;
REVOKE ALL ON FUNCTION public.merge_person_records(uuid,uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.merge_person_records(uuid,uuid,uuid,text,text) TO authenticated;
COMMENT ON FUNCTION public.merge_person_records(uuid,uuid,uuid,text,text) IS
  'Administrator merge of two profiles of the same person (for example a CCTV "Unknown Person #N" and a named person). Moves identity evidence, face templates, sightings, CCTV, incidents, vehicle people, mentions, flags and aliases to the kept record; the other name becomes an AKA; the merged record is retained (rejected, merged_into_person_record_id) for audit.';

-- 7. ID evidence submitted by any member --------------------------------------
-- Path: org/<person org>/identity/<uploader>/submission-<person_record_id>/<file>
DROP POLICY IF EXISTS identity_evidence_insert ON storage.objects;
CREATE POLICY identity_evidence_insert ON storage.objects FOR INSERT WITH CHECK (
  bucket_id = 'identity-evidence'
  AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
  AND (
    public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
    OR ((storage.foldername(name))[3] = 'identity' AND (storage.foldername(name))[4] = (auth.uid())::text
        AND (storage.foldername(name))[5] ~ '^incident-[0-9a-fA-F-]{36}$'
        AND public.can_record_incident_person((substring((storage.foldername(name))[5] FROM 10))::uuid, auth.uid()))
    OR ((storage.foldername(name))[3] = 'identity' AND (storage.foldername(name))[4] = (auth.uid())::text
        AND (storage.foldername(name))[5] ~ '^submission-[0-9a-fA-F-]{36}$'
        AND public.org_access_allowed(((storage.foldername(name))[2])::uuid))
  )
);
DROP POLICY IF EXISTS identity_evidence_select ON storage.objects;
CREATE POLICY identity_evidence_select ON storage.objects FOR SELECT USING (
  bucket_id = 'identity-evidence'
  AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
  AND (
    public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
    OR ((storage.foldername(name))[3] = 'identity' AND (storage.foldername(name))[4] = (auth.uid())::text
        AND (storage.foldername(name))[5] ~ '^incident-[0-9a-fA-F-]{36}$'
        AND public.can_record_incident_person((substring((storage.foldername(name))[5] FROM 10))::uuid, auth.uid()))
    OR ((storage.foldername(name))[3] = 'identity' AND (storage.foldername(name))[4] = (auth.uid())::text
        AND (storage.foldername(name))[5] ~ '^submission-[0-9a-fA-F-]{36}$'
        AND public.org_access_allowed(((storage.foldername(name))[2])::uuid))
  )
);

CREATE OR REPLACE FUNCTION public.register_person_identity_submission(
  p_person_record_id uuid, p_document_kind text, p_attachment_id uuid, p_file_name text,
  p_file_type text, p_file_size_bytes bigint, p_storage_path text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_person public.person_records%rowtype;
  v_conversation uuid;
BEGIN
  SELECT * INTO v_person FROM public.person_records WHERE id = p_person_record_id;
  IF v_actor IS NULL OR v_person.id IS NULL OR NOT public.org_access_allowed(v_person.organization_id) THEN
    RAISE EXCEPTION 'Person record not found in your authorised scope';
  END IF;
  IF v_person.metadata ? 'merged_into_person_record_id' OR v_person.metadata ? 'resolved_into_person_record_id' THEN
    RAISE EXCEPTION 'This person has been merged into another record';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.identity_document_type_definitions d WHERE d.document_kind = p_document_kind AND d.active) THEN
    RAISE EXCEPTION 'Unsupported identity document kind';
  END IF;
  IF p_file_type NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/tiff', 'application/pdf') THEN
    RAISE EXCEPTION 'Unsupported identity evidence file type';
  END IF;
  IF p_file_size_bytes <= 0 OR p_file_size_bytes > 26214400 THEN RAISE EXCEPTION 'Identity evidence must be 25 MB or smaller'; END IF;
  IF p_storage_path NOT LIKE 'org/' || v_person.organization_id::text || '/identity/' || v_actor::text || '/submission-' || v_person.id::text || '/%' THEN
    RAISE EXCEPTION 'Identity evidence path is outside the submission scope';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'identity-evidence' AND o.name = p_storage_path) THEN
    RAISE EXCEPTION 'Uploaded identity evidence object not found';
  END IF;
  SELECT id INTO v_conversation FROM public.bob_conversations
  WHERE organization_id = v_person.organization_id AND user_id = v_actor AND module_key = 'operations' ORDER BY updated_at DESC LIMIT 1;
  IF v_conversation IS NULL THEN
    INSERT INTO public.bob_conversations (organization_id, user_id, module_key, title)
    VALUES (v_person.organization_id, v_actor, 'operations', 'Identity evidence')
    RETURNING id INTO v_conversation;
  END IF;
  INSERT INTO public.bob_attachments (id, organization_id, conversation_id, uploaded_by, file_name, file_type, file_size_bytes,
    storage_bucket, storage_path, purpose, processing_state, extraction_payload)
  VALUES (p_attachment_id, v_person.organization_id, v_conversation, v_actor, p_file_name, p_file_type, p_file_size_bytes,
    'identity-evidence', p_storage_path, 'identity_document', 'processing',
    jsonb_build_object('person_record_id', v_person.id, 'document_kind', p_document_kind, 'capture_authority', 'member_submission'));
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_person.organization_id, v_actor, 'person_identity_submission_registered', 'bob_attachments', p_attachment_id,
    jsonb_build_object('person_record_id', v_person.id, 'document_kind', p_document_kind));
  RETURN jsonb_build_object('attachment_id', p_attachment_id, 'organization_id', v_person.organization_id,
    'person_record_id', v_person.id, 'document_kind', p_document_kind);
END;
$function$;
REVOKE ALL ON FUNCTION public.register_person_identity_submission(uuid,text,uuid,text,text,bigint,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_person_identity_submission(uuid,text,uuid,text,text,bigint,text) TO authenticated;
COMMENT ON FUNCTION public.register_person_identity_submission(uuid,text,uuid,text,text,bigint,text) IS
  'Any member of the organisation can submit ID evidence for a person. bob-perceive-image extracts it into a manual_review_required identity document; only an administrator approves it (review_canonical_identity_evidence) and only approval verifies the person.';

-- 8. The vehicle people path refuses obvious duplicates too ------------------
CREATE OR REPLACE FUNCTION public.record_vehicle_person(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid,
  p_person_record_id uuid,
  p_person_fields jsonb,
  p_relationship text,
  p_source text,
  p_basis text,
  p_observation_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_person_record_id uuid := p_person_record_id;
  v_canonical_person_id uuid;
  v_name text := nullif(trim(p_person_fields->>'display_name'), '');
  v_details jsonb;
  v_relationship text;
  v_link_id uuid;
  v_ended integer := 0;
  v_observations jsonb := CASE WHEN p_observation_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_observation_id) END;
BEGIN
  IF v_actor IS NULL OR NOT public.can_access_vehicle_owner_identity(p_organization_id, true) THEN
    RAISE EXCEPTION 'Vehicle owner identity access required';
  END IF;
  IF p_relationship NOT IN ('owner', 'driver', 'associated_person') THEN
    RAISE EXCEPTION 'Choose how this person relates to the vehicle';
  END IF;
  IF p_source NOT IN ('nzta_mvr', 'owner_declared', 'officer_observed', 'other') THEN
    RAISE EXCEPTION 'Choose where the details came from';
  END IF;
  IF p_source = 'nzta_mvr' AND p_relationship <> 'owner' THEN
    RAISE EXCEPTION 'The NZTA register only establishes the registered owner';
  END IF;
  IF coalesce(trim(p_basis), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  v_relationship := CASE WHEN p_relationship = 'owner' AND p_source = 'nzta_mvr' THEN 'registered_owner' ELSE p_relationship END;
  PERFORM 1 FROM public.canonical_vehicles WHERE id = p_canonical_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Canonical vehicle not found'; END IF;
  IF p_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.observations o
    WHERE o.id = p_observation_id AND public.org_access_allowed(o.organization_id)
  ) THEN RAISE EXCEPTION 'Observation not found in your authorised scope'; END IF;

  IF v_person_record_id IS NULL THEN
    IF p_person_fields IS NULL OR jsonb_typeof(p_person_fields) <> 'object' THEN
      RAISE EXCEPTION 'Choose an existing person or enter their details';
    END IF;
    IF v_name IS NULL THEN RAISE EXCEPTION 'Person name is required'; END IF;
    PERFORM public.assert_new_person_not_duplicate(p_organization_id, p_person_fields);
    v_details := jsonb_strip_nulls(jsonb_build_object(
      'phone', nullif(trim(p_person_fields->>'phone'), ''),
      'email', nullif(trim(p_person_fields->>'email'), ''),
      'address', nullif(trim(p_person_fields->>'address'), ''),
      'suburb', nullif(trim(p_person_fields->>'suburb'), ''),
      'city', nullif(trim(p_person_fields->>'city'), ''),
      'notes', nullif(trim(p_person_fields->>'notes'), ''),
      'nzta_mvr_sourced', p_source = 'nzta_mvr'
    ));
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (p_organization_id, v_name, 'manual_review_required',
      jsonb_build_object('profile_details', v_details, 'created_from', 'vehicle_' || p_relationship, 'created_by', v_actor))
    RETURNING id INTO v_person_record_id;
    v_canonical_person_id := public.ensure_canonical_person_for_record(v_person_record_id);
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_organization_id, v_actor, 'identity_person_create', 'person_records', v_person_record_id,
      jsonb_build_object('canonical_person_id', v_canonical_person_id,
        'reason', 'Vehicle ' || replace(p_relationship, '_', ' ') || ': ' || trim(p_basis),
        'fields', array(SELECT jsonb_object_keys(v_details))));
  ELSE
    PERFORM 1 FROM public.person_records WHERE id = v_person_record_id AND organization_id = p_organization_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
    v_canonical_person_id := public.ensure_canonical_person_for_record(v_person_record_id);
  END IF;
  IF v_canonical_person_id IS NULL THEN RAISE EXCEPTION 'The person could not be linked to a canonical person'; END IF;

  -- A vehicle has one current owner per organisation; drivers and associated people accumulate.
  IF v_relationship IN ('owner', 'registered_owner') THEN
    UPDATE public.entity_links SET active = false, ends_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE organization_id = p_organization_id AND to_type = 'vehicle' AND to_id = p_canonical_vehicle_id
      AND relationship = v_relationship AND active
      AND NOT (from_type = 'person' AND from_id = v_canonical_person_id);
    GET DIAGNOSTICS v_ended = ROW_COUNT;
  END IF;

  INSERT INTO public.entity_links AS link (organization_id, from_type, from_id, to_type, to_id, relationship, evidence, active, starts_at, created_by)
  VALUES (p_organization_id, 'person', v_canonical_person_id, 'vehicle', p_canonical_vehicle_id, v_relationship,
    jsonb_build_object('source', p_source, 'basis', trim(p_basis), 'person_record_id', v_person_record_id,
      'nzta_restricted', p_source = 'nzta_mvr', 'observation_ids', v_observations),
    true, clock_timestamp(), v_actor)
  ON CONFLICT (organization_id, from_type, from_id, to_type, to_id, relationship) WHERE active
  DO UPDATE SET evidence = excluded.evidence || jsonb_build_object('observation_ids', (
      SELECT coalesce(jsonb_agg(DISTINCT item), '[]'::jsonb)
      FROM jsonb_array_elements(coalesce(link.evidence->'observation_ids', '[]'::jsonb) || v_observations) item
    )),
    updated_at = clock_timestamp()
  RETURNING id INTO v_link_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor,
    CASE WHEN v_relationship IN ('owner', 'registered_owner') THEN 'vehicle_owner_recorded' ELSE 'vehicle_person_recorded' END,
    'entity_links', v_link_id,
    jsonb_strip_nulls(jsonb_build_object('canonical_vehicle_id', p_canonical_vehicle_id, 'person_record_id', v_person_record_id,
      'canonical_person_id', v_canonical_person_id, 'relationship', v_relationship, 'source', p_source,
      'basis', trim(p_basis), 'observation_id', p_observation_id, 'previous_owner_links_ended', v_ended)));
  RETURN jsonb_build_object('link_id', v_link_id, 'person_record_id', v_person_record_id,
    'canonical_person_id', v_canonical_person_id, 'relationship', v_relationship);
END;
$function$;
