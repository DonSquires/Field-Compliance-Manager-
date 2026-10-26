-- Notice owner matching requires a compatible given name.
--
-- import_person_notice resolved a notice to the NZTA registered owner of the named vehicle
-- when the surname agreed. On R&M's historical register that attributed a family member's
-- notice to the vehicle owner (same plate and surname, different given name), which would
-- show an innocent person as trespassed or warned. The owner is now matched only when the
-- notice gives no given name, or one of its given names equals the owner's, is an initial of
-- it, or shares a 3+ letter prefix with it (Chris / Christopher). Any other name falls through
-- to the unique exact-name match, then to a person verified by the notice itself; the import
-- links that person to the vehicle as an associated person, and genuine spelling duplicates
-- are joined with the governed Merge records action. Signature, grants and every other path
-- are unchanged.

CREATE OR REPLACE FUNCTION public.import_person_notice(
  p_organization_id uuid,
  p_notice_type text,
  p_status text,
  p_issued_at timestamptz,
  p_subject_display_name text,
  p_source_document_name text,
  p_source_reference text,
  p_source_sha256 text,
  p_import_key text,
  p_expires_at timestamptz DEFAULT NULL,
  p_canonical_person_id uuid DEFAULT NULL,
  p_plate_number text DEFAULT NULL,
  p_subject_address text DEFAULT NULL,
  p_notice_number text DEFAULT NULL,
  p_legal_basis text DEFAULT NULL,
  p_area text DEFAULT NULL,
  p_title text DEFAULT NULL,
  p_source_author text DEFAULT NULL,
  p_issued_date_basis text DEFAULT 'document'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_provider_count integer;
  v_authorized_provider_count integer;
  v_latest_owner_check timestamptz;
  v_subject text := nullif(regexp_replace(trim(coalesce(p_subject_display_name, '')), '\s+', ' ', 'g'), '');
  v_norm text;
  v_surname text;
  v_plate text := nullif(regexp_replace(upper(coalesce(p_plate_number, '')), '[^A-Z0-9]', '', 'g'), '');
  v_hash text := lower(nullif(trim(coalesce(p_source_sha256, '')), ''));
  v_key text := nullif(trim(coalesce(p_import_key, '')), '');
  v_notice public.notices%rowtype;
  v_person uuid;
  v_record uuid;
  v_basis text;
  v_candidates uuid[];
  v_given text[];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT count(DISTINCT agreement.provider_organization_id),
         count(DISTINCT agreement.provider_organization_id)
           FILTER (WHERE public.is_admin_for_org(agreement.provider_organization_id)),
         (array_agg(agreement.provider_organization_id ORDER BY agreement.provider_organization_id)
           FILTER (WHERE public.is_admin_for_org(agreement.provider_organization_id)))[1]
    INTO v_provider_count, v_authorized_provider_count, v_provider
  FROM public.service_agreements agreement
  WHERE agreement.client_organization_id = p_organization_id
    AND agreement.agreement_type = 'operational'
    AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
    AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date);
  IF v_provider_count > 0 THEN
    IF v_authorized_provider_count <> 1 THEN
      RAISE EXCEPTION 'Provider administrator access to this client organisation is required';
    END IF;
  ELSE
    SELECT o.parent_organization_id INTO v_provider
    FROM public.organizations o
    WHERE o.id = p_organization_id;
  END IF;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Provider administrator access to this client organisation is required';
  END IF;
  IF p_notice_type IS NULL OR p_notice_type NOT IN ('trespass', 'warning', 'permit_refusal', 'contact_request') THEN
    RAISE EXCEPTION 'Unsupported imported notice type %', p_notice_type;
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('issued', 'withdrawn') THEN RAISE EXCEPTION 'Unsupported imported notice status %', p_status; END IF;
  IF p_issued_at IS NULL THEN RAISE EXCEPTION 'Issued date is required'; END IF;
  IF p_issued_date_basis IS NULL OR p_issued_date_basis NOT IN ('document', 'register', 'document_created') THEN
    RAISE EXCEPTION 'Unsupported issued date basis %', p_issued_date_basis;
  END IF;
  IF p_expires_at IS NOT NULL AND p_notice_type IN ('permit_refusal', 'contact_request') THEN RAISE EXCEPTION 'Letters do not expire'; END IF;
  IF p_expires_at IS NOT NULL AND p_expires_at < p_issued_at THEN RAISE EXCEPTION 'A notice cannot expire before it is issued'; END IF;
  IF v_subject IS NULL AND p_canonical_person_id IS NULL THEN RAISE EXCEPTION 'The person named on the notice is required'; END IF;
  IF nullif(trim(coalesce(p_source_document_name, '')), '') IS NULL OR nullif(trim(coalesce(p_source_reference, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Source document name and governed source reference are required';
  END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A SHA-256 source hash is required'; END IF;
  IF v_key IS NULL THEN RAISE EXCEPTION 'A deterministic import key is required'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':person-notice:' || v_key, 0));
  SELECT * INTO v_notice FROM public.notices n WHERE n.organization_id = p_organization_id AND n.import_key = v_key;
  IF v_notice.id IS NOT NULL THEN
    IF v_notice.source_sha256 IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Import key already exists with a different source hash';
    END IF;
    RETURN jsonb_build_object('notice_id', v_notice.id, 'canonical_person_id', v_notice.person_id,
      'match_basis', v_notice.metadata->>'match_basis', 'inserted', false);
  END IF;

  v_norm := regexp_replace(lower(coalesce(v_subject, '')), '[^a-z0-9]+', '', 'g');
  v_surname := (SELECT token FROM unnest(regexp_split_to_array(lower(coalesce(v_subject, '')), '[^[:alpha:]]+'))
    WITH ORDINALITY AS t(token, ord) WHERE length(token) >= 2 ORDER BY ord DESC LIMIT 1);
  v_given := array(
    SELECT token
    FROM unnest(regexp_split_to_array(
      lower(regexp_replace(coalesce(v_subject, ''), '^\s*(mr|mrs|ms|miss|mx|dr)\.?\s+', '', 'i')),
      '[^[:alpha:]]+')) AS t(token)
    WHERE token <> '' AND token IS DISTINCT FROM v_surname);

  IF p_canonical_person_id IS NOT NULL THEN
    SELECT p.id INTO v_person
    FROM public.canonical_people p
    WHERE p.id = p_canonical_person_id
      AND p.status = 'active'
      AND (
        EXISTS (
          SELECT 1 FROM public.canonical_person_links link
          WHERE link.canonical_person_id = p.id
            AND link.organization_id IN (v_provider, p_organization_id)
        )
        OR EXISTS (
          SELECT 1 FROM public.notices notice
          WHERE notice.person_id = p.id
            AND notice.organization_id IN (v_provider, p_organization_id)
        )
      );
    IF v_person IS NULL THEN RAISE EXCEPTION 'Canonical person not found in provider/client scope'; END IF;
    v_basis := 'explicit';
  END IF;

  IF v_person IS NULL AND v_plate IS NOT NULL AND v_surname IS NOT NULL THEN
    SELECT max(check_row.checked_at)
      INTO v_latest_owner_check
    FROM public.vehicle_identity_checks check_row
    JOIN public.canonical_vehicles vehicle ON vehicle.id = check_row.canonical_vehicle_id
    JOIN public.person_identity_documents document
      ON document.id = check_row.identity_document_id
     AND document.organization_id = check_row.organization_id
    WHERE check_row.organization_id = v_provider
      AND regexp_replace(upper(vehicle.plate_number), '[^A-Z0-9]', '', 'g') = v_plate
      AND check_row.checked_at <= p_issued_at
      AND document.document_kind = 'nzta_mvr_record'
      AND (document.review_state = 'approved'
        OR check_row.vehicle_snapshot->>'owner_only_review' = 'true');
    IF v_latest_owner_check IS NOT NULL THEN
      IF EXISTS (
        SELECT 1
        FROM public.vehicle_identity_checks check_row
        JOIN public.canonical_vehicles vehicle ON vehicle.id = check_row.canonical_vehicle_id
        JOIN public.person_identity_documents document
          ON document.id = check_row.identity_document_id
         AND document.organization_id = check_row.organization_id
        WHERE check_row.organization_id = v_provider
          AND regexp_replace(upper(vehicle.plate_number), '[^A-Z0-9]', '', 'g') = v_plate
          AND check_row.checked_at = v_latest_owner_check
          AND document.document_kind = 'nzta_mvr_record'
          AND (document.review_state = 'approved'
            OR check_row.vehicle_snapshot->>'owner_only_review' = 'true')
        GROUP BY check_row.checked_at
        HAVING count(DISTINCT check_row.canonical_person_id) > 1
      ) THEN
        RAISE EXCEPTION 'Ambiguous person: conflicting registered owners at the relevant NZTA check';
      END IF;
      v_candidates := array(
        SELECT DISTINCT check_row.canonical_person_id
        FROM public.vehicle_identity_checks check_row
        JOIN public.canonical_vehicles vehicle ON vehicle.id = check_row.canonical_vehicle_id
        JOIN public.person_identity_documents document
          ON document.id = check_row.identity_document_id
         AND document.organization_id = check_row.organization_id
        JOIN public.canonical_people person
          ON person.id = check_row.canonical_person_id AND person.status = 'active'
        WHERE check_row.organization_id = v_provider
          AND regexp_replace(upper(vehicle.plate_number), '[^A-Z0-9]', '', 'g') = v_plate
          AND check_row.checked_at = v_latest_owner_check
          AND document.document_kind = 'nzta_mvr_record'
          AND (document.review_state = 'approved'
            OR check_row.vehicle_snapshot->>'owner_only_review' = 'true')
          AND v_surname = ANY (regexp_split_to_array(lower(coalesce(person.display_name, '')), '[^[:alpha:]]+'))
          -- A shared surname on the plate is not enough: a family member named on the notice is a
          -- different person. The owner matches only when the notice gives no given name, or one of
          -- its given names equals, is the initial of, or shares a 3+ letter prefix with the owner's.
          AND (
            cardinality(v_given) = 0
            OR EXISTS (
              SELECT 1
              FROM unnest(v_given) AS notice_name(token)
              CROSS JOIN unnest(regexp_split_to_array(lower(coalesce(person.display_name, '')), '[^[:alpha:]]+')) AS owner_name(token)
              WHERE owner_name.token <> ''
                AND owner_name.token <> v_surname
                AND (
                  owner_name.token = notice_name.token
                  OR ((length(owner_name.token) = 1 OR length(notice_name.token) = 1)
                    AND left(owner_name.token, 1) = left(notice_name.token, 1))
                  OR (least(length(owner_name.token), length(notice_name.token)) >= 3
                    AND (starts_with(owner_name.token, notice_name.token)
                      OR starts_with(notice_name.token, owner_name.token)))
                )
            )
          ));
      IF cardinality(v_candidates) > 1 THEN
        RAISE EXCEPTION 'Ambiguous person: % registered owners at the relevant NZTA check share the surname', cardinality(v_candidates);
      END IF;
      IF cardinality(v_candidates) = 1 THEN
        v_person := v_candidates[1];
        v_basis := 'vehicle_registered_owner_at_notice';
      END IF;
    END IF;
  END IF;

  IF v_person IS NULL AND length(v_norm) >= 4 AND v_subject ~ '\S\s+\S' THEN
    v_candidates := array(
      SELECT DISTINCT p.id
      FROM public.canonical_people p
      JOIN public.canonical_person_links link ON link.canonical_person_id = p.id
      WHERE p.status = 'active' AND p.normalized_name = v_norm
        AND link.organization_id IN (v_provider, p_organization_id));
    IF cardinality(v_candidates) > 1 THEN
      RAISE EXCEPTION 'Ambiguous person: % people share this exact name', cardinality(v_candidates);
    END IF;
    IF cardinality(v_candidates) = 1 THEN v_person := v_candidates[1]; v_basis := 'exact_name'; END IF;
  END IF;

  IF v_person IS NULL THEN
    IF v_subject IS NULL THEN RAISE EXCEPTION 'The person named on the notice is required'; END IF;
    IF regexp_replace(v_subject, '^\s*(mr|mrs|ms|miss|mx|dr)\.?\s+', '', 'i') !~ '[[:alpha:]]{2,}.*\s+.*[[:alpha:]]{2,}' THEN
      RAISE EXCEPTION 'A given name and family name are required to create a person from a notice';
    END IF;
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (v_provider, v_subject, 'verified', jsonb_strip_nulls(jsonb_build_object(
      'created_from', 'person_notice',
      'verified_by', 'notice',
      'notice_import_key', v_key,
      'source_sha256', v_hash,
      'source_document_name', trim(p_source_document_name),
      'notice_organization_id', p_organization_id,
      'profile_details', CASE WHEN nullif(trim(coalesce(p_subject_address, '')), '') IS NULL THEN NULL
        ELSE jsonb_build_object('address', trim(p_subject_address)) END,
      'created_by', v_actor)))
    RETURNING id INTO v_record;
    v_person := public.ensure_canonical_person_for_record(v_record);
    v_basis := 'created_from_notice';
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_provider, v_actor, 'identity_person_create', 'person_records', v_record,
      jsonb_build_object('canonical_person_id', v_person,
        'reason', 'Person named on an R&M ' || replace(p_notice_type, '_', ' ') || ' for a landowner client; the notice is the verification (owner-confirmed import rule).',
        'notice_import_key', v_key));
  END IF;

  INSERT INTO public.notices (
    organization_id, person_id, notice_type, notice_number, legal_basis, status,
    authorized_by, authorized_at, issued_at, expires_at, source_author,
    source_document_name, source_reference, source_sha256, import_key, metadata
  ) VALUES (
    p_organization_id, v_person, p_notice_type,
    nullif(trim(coalesce(p_notice_number, '')), ''), nullif(trim(coalesce(p_legal_basis, '')), ''), p_status,
    nullif(trim(coalesce(p_source_author, '')), ''), p_issued_at, p_issued_at, p_expires_at,
    nullif(trim(coalesce(p_source_author, '')), ''),
    trim(p_source_document_name), trim(p_source_reference), v_hash, v_key,
    jsonb_strip_nulls(jsonb_build_object(
      'provenance', 'rm_source_document',
      'source_of_truth', 'R&M records until R&M operate in FCM (owner-confirmed import rule)',
      'title', nullif(trim(coalesce(p_title, '')), ''),
      'area', nullif(trim(coalesce(p_area, '')), ''),
      'plate_number', v_plate,
      'subject_name_on_notice', v_subject,
      'match_basis', v_basis,
      'issued_date_basis', p_issued_date_basis,
      'created_person_record_id', v_record))
  ) RETURNING * INTO v_notice;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'person_notice_imported', 'notices', v_notice.id,
    jsonb_build_object('notice_type', p_notice_type, 'canonical_person_id', v_person, 'match_basis', v_basis,
      'import_key', v_key, 'source_sha256', v_hash, 'expires_at', v_notice.expires_at));

  RETURN jsonb_build_object('notice_id', v_notice.id, 'canonical_person_id', v_person,
    'person_record_id', v_record, 'match_basis', v_basis, 'expires_at', v_notice.expires_at, 'inserted', true);
END;
$$;

COMMENT ON FUNCTION public.import_person_notice(uuid, text, text, timestamptz, text, text, text, text, text, timestamptz, uuid, text, text, text, text, text, text, text, text) IS
'Provider-administrator import of an R&M historical trespass notice, warning, permit refusal or contact request for a landowner client. Links the shared canonical person (explicit, NZTA registered owner of the named vehicle with agreeing surname and a compatible given name, or unique exact name) or creates a person verified by the notice; refuses ambiguous matches. Replay-safe by import key; audited.';
REVOKE ALL ON FUNCTION public.import_person_notice(uuid, text, text, timestamptz, text, text, text, text, text, timestamptz, uuid, text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_person_notice(uuid, text, text, timestamptz, text, text, text, text, text, timestamptz, uuid, text, text, text, text, text, text, text, text) TO authenticated, service_role;
