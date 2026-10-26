-- Governed import of R&M's historical person notices and letters.
--
-- R&M's trespass notices, warning letters, permit refusals and contact requests are
-- the source of truth for who has been dealt with on each client's land. Each one is
-- filed under the landowner client organisation and linked to the shared canonical
-- person. The person is resolved, in order, from: an explicit canonical person; the
-- NZTA registered owner of the vehicle the notice names, when the surname agrees; a
-- unique exact name match among the provider's and client's people; otherwise a new
-- person record verified by the notice itself (owner ruling: "verification is the
-- notice"). An ambiguous match is refused so the caller holds it for review.
-- Letters are recorded as titled; only trespass and warning notices expire, at the
-- source register's expiry when it has one, otherwise issue + 2 years (trigger).
-- Confirmed owner rules (2026-10-26): warning expiry defaults to two years,
-- explicit register expiry is retained, and a notice can verify its named person.

ALTER TABLE public.notices DROP CONSTRAINT IF EXISTS notices_notice_type_check;
ALTER TABLE public.notices ADD CONSTRAINT notices_notice_type_check CHECK (notice_type = ANY (ARRAY[
  'warning', 'infringement', 'notice_to_vacate', 'trespass', 'abatement', 'direction',
  'enforcement', 'biosecurity', 'smoke', 'permit_refusal', 'contact_request'
]));
COMMENT ON TABLE public.notices IS
'All notice types: warning, infringement, NTV, abatement, direction, enforcement, biosecurity, smoke, and the permit refusal and contact request letters R&M send for landowner clients.';

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
          AND v_surname = ANY (regexp_split_to_array(lower(coalesce(person.display_name, '')), '[^[:alpha:]]+')));
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
'Provider-administrator import of an R&M historical trespass notice, warning, permit refusal or contact request for a landowner client. Links the shared canonical person (explicit, NZTA registered owner of the named vehicle with agreeing surname, or unique exact name) or creates a person verified by the notice; refuses ambiguous matches. Replay-safe by import key; audited.';
REVOKE ALL ON FUNCTION public.import_person_notice(uuid, text, text, timestamptz, text, text, text, text, text, timestamptz, uuid, text, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_person_notice(uuid, text, text, timestamptz, text, text, text, text, text, timestamptz, uuid, text, text, text, text, text, text, text, text) TO authenticated, service_role;

-- Permit refusal and contact request letters do not bar entry, so only trespass and warning
-- notices make a person "notice in force" in person search.
CREATE OR REPLACE FUNCTION public.search_people(p_query text, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_query text := regexp_replace(lower(trim(coalesce(p_query, ''))), '\s+', ' ', 'g');
  v_norm text;
  v_tokens text[];
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_orgs uuid[];
  v_identity_orgs uuid[];
  v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = v_actor AND deactivated_at IS NULL
      AND role IN ('grand_master', 'master', 'admin', 'admin_officer')
  ) THEN
    RAISE EXCEPTION 'Active operations role required';
  END IF;
  v_norm := regexp_replace(v_query, '[^a-z0-9]+', '', 'g');
  IF length(v_norm) < 2 THEN RETURN '[]'::jsonb; END IF;
  v_tokens := array(
    SELECT token FROM unnest(regexp_split_to_array(regexp_replace(v_query, '[^a-z0-9 ]+', '', 'g'), ' ')) token
    WHERE token <> ''
  );
  v_orgs := array(SELECT o.id FROM public.organizations o WHERE public.org_access_allowed(o.id));
  v_identity_orgs := array(SELECT org_id FROM unnest(v_orgs) org_id WHERE public.can_access_vehicle_owner_identity(org_id));

  WITH matched AS (
    SELECT p.id
    FROM public.canonical_people p
    WHERE p.status = 'active'
      AND (p.normalized_name LIKE '%' || v_norm || '%'
        OR (cardinality(v_tokens) > 1 AND NOT EXISTS (
          SELECT 1 FROM unnest(v_tokens) token WHERE position(token IN lower(coalesce(p.display_name, ''))) = 0)))
    UNION
    SELECT link.canonical_person_id
    FROM public.person_record_aliases alias
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = alias.person_record_id
    WHERE alias.active AND alias.organization_id = ANY (v_orgs) AND alias.alias_norm LIKE '%' || v_norm || '%'
    UNION
    SELECT link.canonical_person_id
    FROM public.person_records record
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = record.id
    WHERE record.organization_id = ANY (v_orgs)
      AND regexp_replace(lower(coalesce(record.display_name, '')), '[^a-z0-9]+', '', 'g') LIKE '%' || v_norm || '%'
  ),
  visible AS (
    SELECT p.*
    FROM public.canonical_people p
    WHERE p.id IN (SELECT id FROM matched)
      AND p.status = 'active'
      AND (EXISTS (SELECT 1 FROM public.canonical_person_links link
                   WHERE link.canonical_person_id = p.id AND link.organization_id = ANY (v_orgs))
        OR EXISTS (SELECT 1 FROM public.notices notice
                   WHERE notice.person_id = p.id AND notice.organization_id = ANY (v_orgs)))
  ),
  ranked AS (
    SELECT v.*,
      (v.normalized_name = v_norm) AS exact_match,
      EXISTS (SELECT 1 FROM public.notices notice
              WHERE notice.person_id = v.id AND notice.organization_id = ANY (v_orgs)
                AND notice.status = 'issued' AND notice.notice_type IN ('trespass', 'warning')
                AND (notice.expires_at IS NULL OR notice.expires_at > clock_timestamp())) AS has_notice_in_force
    FROM visible v
    ORDER BY exact_match DESC, has_notice_in_force DESC, v.display_name
    LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'canonical_person_id', r.id,
    'display_name', r.display_name,
    'review_state', r.review_state,
    'homeless_status', r.homeless_status,
    'has_notice_in_force', r.has_notice_in_force,
    'aliases', coalesce((
      SELECT jsonb_agg(DISTINCT alias.alias)
      FROM public.canonical_person_links link
      JOIN public.person_record_aliases alias ON alias.person_record_id = link.source_id AND alias.active
      WHERE link.canonical_person_id = r.id AND link.source_table = 'person_records' AND alias.organization_id = ANY (v_orgs)
    ), '[]'::jsonb),
    'organizations', coalesce((
      SELECT jsonb_agg(DISTINCT org.name)
      FROM public.organizations org
      WHERE org.id = ANY (v_orgs)
        AND (EXISTS (SELECT 1 FROM public.canonical_person_links link WHERE link.canonical_person_id = r.id AND link.organization_id = org.id)
          OR EXISTS (SELECT 1 FROM public.notices notice WHERE notice.person_id = r.id AND notice.organization_id = org.id))
    ), '[]'::jsonb),
    'notices', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'notice_id', notice.id,
        'organization_id', notice.organization_id,
        'organization_name', org.name,
        'notice_type', notice.notice_type,
        'notice_number', notice.notice_number,
        'status', notice.status,
        'issued_at', notice.issued_at,
        'expires_at', notice.expires_at,
        'expiry_state', public.notice_expiry_state(notice.status, notice.expires_at),
        'location_name', place.name
      ) ORDER BY notice.issued_at DESC NULLS LAST)
      FROM public.notices notice
      JOIN public.organizations org ON org.id = notice.organization_id
      LEFT JOIN public.observations observation ON observation.id = notice.observation_id
      LEFT JOIN public.locations place ON place.id = coalesce(notice.location_id, observation.location_id)
      WHERE notice.person_id = r.id AND notice.organization_id = ANY (v_orgs)
    ), '[]'::jsonb),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'canonical_vehicle_id', vehicle.id,
        'plate_number', vehicle.plate_number,
        'make', vehicle.make,
        'model', vehicle.model,
        'colour', vehicle.colour,
        'relationship', link.relationship,
        'since', link.starts_at,
        'source', CASE WHEN link.organization_id = ANY (v_identity_orgs) THEN link.evidence->>'source' END,
        'source_checked_at', CASE WHEN link.organization_id = ANY (v_identity_orgs)
          THEN link.evidence->>'source_checked_at' END
      ) ORDER BY link.starts_at DESC NULLS LAST)
      FROM public.entity_links link
      JOIN public.canonical_vehicles vehicle ON vehicle.id = link.to_id
      WHERE link.from_type = 'person' AND link.from_id = r.id AND link.to_type = 'vehicle'
        AND link.active AND link.organization_id = ANY (v_orgs)
        AND (link.relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person')
          OR link.organization_id = ANY (v_identity_orgs))
    ), '[]'::jsonb),
    'nzta_authorised', cardinality(v_identity_orgs) > 0,
    'nzta', CASE WHEN cardinality(v_identity_orgs) = 0 THEN NULL ELSE (
      SELECT jsonb_build_object(
        'address', coalesce(doc.extracted_fields->'approved'->>'address',
                            doc.extracted_fields->'proposed'->>'physical_address',
                            doc.extracted_fields->'proposed'->>'address'),
        'last_checked_at', check_row.checked_at,
        'checks', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'plate_number', checked_vehicle.plate_number,
            'checked_at', history.checked_at
          ) ORDER BY history.checked_at DESC), '[]'::jsonb)
          FROM public.vehicle_identity_checks history
          JOIN public.canonical_vehicles checked_vehicle ON checked_vehicle.id = history.canonical_vehicle_id
          WHERE history.canonical_person_id = r.id AND history.organization_id = ANY (v_identity_orgs)
        )
      )
      FROM public.vehicle_identity_checks check_row
      JOIN public.person_identity_documents doc ON doc.id = check_row.identity_document_id
      WHERE check_row.canonical_person_id = r.id AND check_row.organization_id = ANY (v_identity_orgs)
      ORDER BY check_row.checked_at DESC
      LIMIT 1
    ) END
  ) ORDER BY r.exact_match DESC, r.has_notice_in_force DESC, r.display_name), '[]'::jsonb)
  INTO v_result
  FROM ranked r;

  RETURN v_result;
END;
$function$;
COMMENT ON FUNCTION public.search_people(text, integer) IS
  'Person search across the caller''s authorised organisations: name/alias match, notices and letters with expiry state, linked vehicles. Only issued trespass and warning notices count as in force. Address and NZTA register checks are only returned to users with vehicle-owner identity access (owner ruling 2026-10-26). Safety warnings come from get_safety_warnings.';
REVOKE ALL ON FUNCTION public.search_people(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_people(text, integer) TO authenticated;
