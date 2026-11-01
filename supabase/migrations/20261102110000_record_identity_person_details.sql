-- In-app Bob's confirmed person steps (PR #284 review) need one audited database operation each, because
-- manage_identity_person cannot be made safe for them from outside the database:
--   * create inserts unconditionally, so two confirmations (in any conversations) that both re-checked the register
--     before either inserted made duplicate people;
--   * update rewrites display_name (and the unshared canonical name) from the caller's copy, so a rename made
--     between Bob's read and the write was silently reverted;
--   * update does not refuse a record that has since been merged into, or resolved into, another person.
-- record_identity_person_details is the administrator path for those two steps:
--   create  serialises on (organisation, normalised name) with a transaction advisory lock, then returns the one
--           exact-name (or active alias) person already recorded whose date of birth does not conflict
--           (outcome 'existing'; the person row is untouched, only a missing canonical link is created so a
--           dependent safety warning can attach) or creates through manage_identity_person (outcome 'created').
--           p_distinct_from lists records the user confirmed are different people; they never count as a match.
--   update  details only: locks the row, refuses merged/resolved records, never touches display_name or the
--           canonical name, merges profile details, and writes nothing (outcome 'unchanged') when they are already
--           held. A supplied date of birth reaches the canonical person only when no other organisation links to it,
--           the same rule manage_identity_person applies.
-- Chat records only category, notes, email, phone and date_of_birth; licences and addresses stay with the registry.

CREATE OR REPLACE FUNCTION public.record_identity_person_details(
  p_organization_id uuid,
  p_person_record_id uuid,
  p_action text,
  p_fields jsonb,
  p_distinct_from uuid[],
  p_reason text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_name text;
  v_norm text;
  v_dob date;
  v_details jsonb;
  v_matches uuid[];
  v_person public.person_records%rowtype;
  v_current jsonb;
  v_canonical_id uuid;
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('create', 'update') THEN RAISE EXCEPTION 'Unsupported person action'; END IF;
  IF coalesce(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF jsonb_typeof(v_fields) <> 'object' THEN RAISE EXCEPTION 'Person details must be an object'; END IF;
  IF nullif(btrim(v_fields->>'date_of_birth'), '') IS NOT NULL THEN
    v_dob := (v_fields->>'date_of_birth')::date;
    IF v_dob > current_date THEN RAISE EXCEPTION 'Date of birth cannot be in the future'; END IF;
  END IF;
  v_details := jsonb_strip_nulls(jsonb_build_object(
    'category', nullif(btrim(v_fields->>'category'), ''),
    'notes', nullif(btrim(v_fields->>'notes'), ''),
    'email', nullif(btrim(v_fields->>'email'), ''),
    'phone', nullif(btrim(v_fields->>'phone'), ''),
    'date_of_birth', v_dob
  ));
  IF length(v_details->>'category') > 120 OR length(v_details->>'notes') > 1000
    OR length(v_details->>'email') > 254 OR length(v_details->>'phone') > 40 THEN
    RAISE EXCEPTION 'A person detail is longer than the register allows';
  END IF;

  IF p_action = 'create' THEN
    v_name := nullif(btrim(regexp_replace(coalesce(v_fields->>'display_name', ''), '\s+', ' ', 'g')), '');
    v_norm := public.normalize_person_name(v_name);
    IF coalesce(v_norm, '') = '' THEN RAISE EXCEPTION 'Person name is required'; END IF;
    IF length(v_name) > 120 THEN RAISE EXCEPTION 'Person name is longer than the register allows'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('identity_person_create:' || p_organization_id::text || ':' || v_norm, 0));
    SELECT coalesce(array_agg(person.id ORDER BY person.id), '{}'::uuid[]) INTO v_matches
    FROM public.person_records AS person
    LEFT JOIN public.canonical_person_links AS link
      ON link.source_table = 'person_records' AND link.source_id = person.id
    LEFT JOIN public.canonical_people AS canonical ON canonical.id = link.canonical_person_id
    WHERE person.organization_id = p_organization_id
      AND NOT (person.metadata ? 'merged_into_person_record_id')
      AND NOT (person.metadata ? 'resolved_into_person_record_id')
      AND NOT (person.id = ANY (coalesce(p_distinct_from, '{}'::uuid[])))
      AND (public.normalize_person_name(person.display_name) = v_norm
        OR EXISTS (SELECT 1 FROM public.person_record_aliases AS alias
          WHERE alias.person_record_id = person.id AND alias.active AND public.normalize_person_name(alias.alias) = v_norm))
      AND (v_dob IS NULL
        OR coalesce(nullif(person.metadata->'profile_details'->>'date_of_birth', '')::date, canonical.date_of_birth) IS NULL
        OR coalesce(nullif(person.metadata->'profile_details'->>'date_of_birth', '')::date, canonical.date_of_birth) = v_dob);
    IF cardinality(v_matches) > 1 THEN
      RAISE EXCEPTION 'AMBIGUOUS_PERSON: % people named % are already recorded', cardinality(v_matches), v_name;
    END IF;
    IF cardinality(v_matches) = 1 THEN
      SELECT * INTO v_person FROM public.person_records WHERE id = v_matches[1];
      RETURN jsonb_build_object('outcome', 'existing', 'person_record_id', v_person.id,
        'canonical_person_id', public.ensure_canonical_person_for_record(v_person.id), 'display_name', v_person.display_name);
    END IF;
    v_result := public.manage_identity_person(p_organization_id, NULL, 'create',
      v_details || jsonb_build_object('display_name', v_name), btrim(p_reason));
    RETURN v_result || jsonb_build_object('outcome', 'created');
  END IF;

  IF v_details = '{}'::jsonb THEN RAISE EXCEPTION 'No person details were given'; END IF;
  SELECT * INTO v_person FROM public.person_records
  WHERE id = p_person_record_id AND organization_id = p_organization_id FOR UPDATE;
  IF v_person.id IS NULL THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
  IF v_person.metadata ? 'merged_into_person_record_id' OR v_person.metadata ? 'resolved_into_person_record_id' THEN
    RAISE EXCEPTION 'This person has been merged into another record';
  END IF;
  v_current := coalesce(v_person.metadata->'profile_details', '{}'::jsonb);
  IF v_current @> v_details THEN
    SELECT link.canonical_person_id INTO v_canonical_id FROM public.canonical_person_links AS link
    WHERE link.source_table = 'person_records' AND link.source_id = v_person.id LIMIT 1;
    RETURN jsonb_build_object('outcome', 'unchanged', 'person_record_id', v_person.id,
      'canonical_person_id', v_canonical_id, 'display_name', v_person.display_name);
  END IF;
  v_canonical_id := public.ensure_canonical_person_for_record(v_person.id);
  UPDATE public.person_records
  SET metadata = metadata || jsonb_build_object('profile_details', v_current || v_details)
  WHERE id = v_person.id;
  IF v_dob IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.canonical_person_links
    WHERE canonical_person_id = v_canonical_id AND organization_id IS DISTINCT FROM p_organization_id
  ) THEN
    UPDATE public.canonical_people SET date_of_birth = v_dob, updated_at = clock_timestamp()
    WHERE id = v_canonical_id AND date_of_birth IS DISTINCT FROM v_dob;
  END IF;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'identity_person_details_update', 'person_records', v_person.id,
    jsonb_build_object('canonical_person_id', v_canonical_id, 'reason', btrim(p_reason),
      'fields', array(SELECT jsonb_object_keys(v_details))));
  RETURN jsonb_build_object('outcome', 'updated', 'person_record_id', v_person.id,
    'canonical_person_id', v_canonical_id, 'display_name', v_person.display_name);
END;
$function$;

COMMENT ON FUNCTION public.record_identity_person_details(uuid, uuid, text, jsonb, uuid[], text) IS
  'Administrator person step for confirmed chat updates. create is serialised per organisation and normalised name and returns an existing exact-name person with no conflicting date of birth instead of inserting a duplicate (p_distinct_from excludes records the user confirmed are different people); update changes profile details only, under the row lock, never the name, and refuses merged or resolved records.';
REVOKE ALL ON FUNCTION public.record_identity_person_details(uuid, uuid, text, jsonb, uuid[], text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_identity_person_details(uuid, uuid, text, jsonb, uuid[], text) TO authenticated;
