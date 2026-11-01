-- The security-definer search and expiry register expose sensitive person and
-- enforcement information. Match the operations-role gate used by the UI.
CREATE OR REPLACE FUNCTION public.search_people(p_query text, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
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
                AND notice.status = 'issued' AND (notice.expires_at IS NULL OR notice.expires_at > clock_timestamp())) AS has_notice_in_force
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
        'since', link.starts_at
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
$$;
COMMENT ON FUNCTION public.search_people(text, integer) IS
  'Person search across organisations available to active operations roles. Name/alias, notices and linked vehicles are tenant-scoped; NZTA details require vehicle-owner identity access.';
REVOKE ALL ON FUNCTION public.search_people(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_people(text, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_notice_expiry_register(p_window_days integer DEFAULT 30, p_expired_days integer DEFAULT 90)
RETURNS TABLE (
  notice_id uuid,
  organization_id uuid,
  organization_name text,
  notice_type text,
  notice_number text,
  issued_at timestamptz,
  expires_at timestamptz,
  expiry_state text,
  days_remaining integer,
  canonical_person_id uuid,
  person_display_name text,
  location_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_window integer := least(greatest(coalesce(p_window_days, 30), 0), 365);
  v_expired integer := least(greatest(coalesce(p_expired_days, 90), 0), 730);
  v_orgs uuid[];
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = v_actor AND deactivated_at IS NULL
      AND role IN ('grand_master', 'master', 'admin', 'admin_officer')
  ) THEN
    RAISE EXCEPTION 'Active operations role required';
  END IF;
  v_orgs := array(SELECT o.id FROM public.organizations o WHERE public.org_access_allowed(o.id));
  RETURN QUERY
  SELECT notice.id, notice.organization_id, org.name, notice.notice_type, notice.notice_number,
    notice.issued_at, notice.expires_at,
    public.notice_expiry_state(notice.status, notice.expires_at, v_window),
    ((notice.expires_at AT TIME ZONE 'Pacific/Auckland')::date
      - (clock_timestamp() AT TIME ZONE 'Pacific/Auckland')::date)::integer,
    person.id, person.display_name, place.name
  FROM public.notices notice
  JOIN public.organizations org ON org.id = notice.organization_id
  LEFT JOIN public.canonical_people person ON person.id = notice.person_id
  LEFT JOIN public.observations observation ON observation.id = notice.observation_id
  LEFT JOIN public.locations place ON place.id = coalesce(notice.location_id, observation.location_id)
  WHERE notice.organization_id = ANY (v_orgs)
    AND notice.status = 'issued'
    AND notice.notice_type IN ('trespass', 'warning')
    AND notice.expires_at IS NOT NULL
    AND notice.expires_at <= clock_timestamp() + make_interval(days => v_window)
    AND notice.expires_at > clock_timestamp() - make_interval(days => v_expired)
  ORDER BY notice.expires_at;
END;
$$;
COMMENT ON FUNCTION public.get_notice_expiry_register(integer, integer) IS
  'Issued trespass and warning notices expiring soon or expired recently, visible only to active operations roles and scoped to their authorised organisations.';
REVOKE ALL ON FUNCTION public.get_notice_expiry_register(integer, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_notice_expiry_register(integer, integer) TO authenticated;