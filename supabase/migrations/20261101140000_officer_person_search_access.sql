-- Owner ruling 2026-10-27: explicit operational person lookup for officers;
-- contact details remain with active Admin, Admin officer, Master and Grand Master.
-- Ordered after the already-released 20261101130000 permit migration.

CREATE OR REPLACE FUNCTION public.can_access_person_contacts(p_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT p_organization_id IS NOT NULL
    AND public.org_access_allowed(p_organization_id)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles p
      WHERE p.id = auth.uid() AND p.deactivated_at IS NULL
        AND p.role IN ('grand_master', 'master', 'admin', 'admin_officer')
    );
$function$;
REVOKE ALL ON FUNCTION public.can_access_person_contacts(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_person_contacts(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.can_search_people(p_organization_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles p
    WHERE p.id = auth.uid() AND p.deactivated_at IS NULL
      AND public.org_access_allowed(coalesce(p_organization_id, p.organization_id))
      AND (
        p.role IN ('grand_master', 'master', 'admin', 'admin_officer')
        OR EXISTS (
          SELECT 1 FROM public.resolve_access_grants(p.id, p.organization_id) g
          WHERE g.area = 'person_search'
        )
      )
  );
$function$;
REVOKE ALL ON FUNCTION public.can_search_people(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_search_people(uuid) TO authenticated;
COMMENT ON FUNCTION public.can_search_people(uuid) IS
  'Operational person lookup: active operations roles or explicit person_search area at the user home organisation. The staff authorization enables lookup only within existing org_access_allowed scope, including operational agreements; it creates no organization access and no NZTA or contact-detail permission.';

CREATE OR REPLACE FUNCTION public.get_person_search_access(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_target public.user_profiles%rowtype;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id;
  IF v_target.id IS NULL OR auth.uid() IS NULL
     OR NOT public.is_admin_for_org(v_target.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'direct', EXISTS (
      SELECT 1 FROM public.staff_area_grants g
      WHERE g.user_id = p_user_id AND g.scope_org_id = v_target.organization_id
        AND g.area = 'person_search' AND g.status = 'active'
    ),
    'via_grant', EXISTS (
      SELECT 1 FROM public.staff_area_grants g
      WHERE g.user_id = p_user_id AND g.scope_org_id <> v_target.organization_id
        AND g.area = 'person_search' AND g.status = 'active'
        AND v_target.organization_id = ANY(public.get_descendant_organizations(g.scope_org_id))
    ),
    'via_preset', EXISTS (
      SELECT 1 FROM public.preset_assignments a
      JOIN public.access_presets p ON p.id = a.preset_id
      WHERE a.user_id = p_user_id AND a.status = 'active'
        AND p.grants->>'person_search' IN ('view', 'verify', 'approve', 'adjust', 'manage')
        AND v_target.organization_id = ANY(public.get_descendant_organizations(a.scope_org_id))
    ),
    'via_role', v_target.role IN ('grand_master', 'master', 'admin', 'admin_officer'),
    'active', v_target.deactivated_at IS NULL,
    'organization_id', v_target.organization_id
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.get_person_search_access(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_person_search_access(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.set_person_search_access(p_user_id uuid, p_enabled boolean, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_target public.user_profiles%rowtype;
  v_grant_id uuid;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id FOR UPDATE;
  IF v_target.id IS NULL OR auth.uid() IS NULL
     OR NOT public.is_admin_for_org(v_target.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id = auth.uid() THEN RAISE EXCEPTION 'You cannot change your own person-search authorization'; END IF;
  IF v_target.role = 'grand_master' THEN RAISE EXCEPTION 'Grand master access is not configurable here'; END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'An enabled or disabled choice is required'; END IF;
  IF nullif(trim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'A reason is required for the access audit trail'; END IF;
  IF p_enabled AND v_target.deactivated_at IS NOT NULL THEN RAISE EXCEPTION 'Cannot enable an inactive user'; END IF;
  IF p_enabled THEN
    INSERT INTO public.staff_area_grants(user_id, scope_org_id, area, level, status, granted_by)
    VALUES(p_user_id, v_target.organization_id, 'person_search', 'view', 'active', auth.uid())
    ON CONFLICT(user_id, scope_org_id, area)
    DO UPDATE SET level = 'view', status = 'active', granted_by = auth.uid(), updated_at = clock_timestamp()
    RETURNING id INTO v_grant_id;
  ELSE
    UPDATE public.staff_area_grants SET status = 'ended', updated_at = clock_timestamp()
    WHERE user_id = p_user_id AND scope_org_id = v_target.organization_id
      AND area = 'person_search' AND status = 'active'
    RETURNING id INTO v_grant_id;
  END IF;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_target.organization_id, auth.uid(),
    CASE WHEN p_enabled THEN 'person_search_access_granted' ELSE 'person_search_access_ended' END,
    'staff_area_grants', v_grant_id,
    jsonb_build_object('user_id', p_user_id, 'area', 'person_search', 'level', 'view', 'reason', trim(p_reason)));
  RETURN public.get_person_search_access(p_user_id);
END;
$function$;
REVOKE ALL ON FUNCTION public.set_person_search_access(uuid, boolean, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_person_search_access(uuid, boolean, text) TO authenticated;

-- Raw profile metadata contains private contacts. Field readers use bounded RPC projections.
ALTER POLICY person_records_select ON public.person_records
  USING (public.can_access_person_contacts(organization_id));
ALTER POLICY entity_links_select ON public.entity_links USING (
  public.org_access_allowed(organization_id)
  AND (relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person')
    OR (public.can_access_vehicle_owner_identity(organization_id)
      AND public.can_access_person_contacts(organization_id)))
);

-- The invoker view previously depended on an admin-only base table, so officers
-- could not actually read permits. Project in a bounded, authorized definer
-- function without granting access to the underlying private columns.
CREATE OR REPLACE FUNCTION public.read_person_permits_fieldwork()
RETURNS TABLE(
  id uuid, organization_id uuid, client_organization_id uuid, canonical_person_id uuid,
  holder_name text, permit_number text, permit_type text, applicant_type text, company_name text,
  contact_email text, contact_phone text, address_text text, forest_areas text[], activities text[],
  hunting_season text, date_from date, date_to date, firearm_confirm boolean, firearm_licence_valid boolean,
  chainsaw_safety_equipment boolean, keys_issued boolean, conditions text, status text,
  compliance_checked_at timestamptz, compliance_source text, vehicle_plates text[], validity_state text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT pp.id, pp.organization_id, pp.client_organization_id, pp.canonical_person_id,
    cp.display_name, pp.permit_number, pp.permit_type, pp.applicant_type, pp.company_name,
    CASE WHEN public.can_access_person_contacts(pp.organization_id) THEN pp.contact_email END,
    CASE WHEN public.can_access_person_contacts(pp.organization_id) THEN pp.contact_phone END,
    CASE WHEN public.can_access_person_contacts(pp.organization_id) THEN pp.address_text END,
    pp.forest_areas, pp.activities, pp.hunting_season, pp.date_from, pp.date_to,
    pp.firearm_confirm, pp.firearm_licence_valid, pp.chainsaw_safety_equipment, pp.keys_issued,
    pp.conditions, pp.status, pp.compliance_checked_at, pp.compliance_source,
    (SELECT array_agg(cv.plate_number ORDER BY cv.plate_number)
     FROM public.person_permit_vehicles ppv
     JOIN public.canonical_vehicles cv ON cv.id = ppv.canonical_vehicle_id
     WHERE ppv.permit_id = pp.id),
    public.person_permit_validity(pp.status, pp.date_from, pp.date_to)
  FROM public.person_permits pp
  LEFT JOIN public.canonical_people cp ON cp.id = pp.canonical_person_id
  WHERE public.can_search_people(pp.organization_id);
$function$;
REVOKE ALL ON FUNCTION public.read_person_permits_fieldwork() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_person_permits_fieldwork() TO authenticated;
CREATE OR REPLACE VIEW public.person_permits_fieldwork WITH (security_invoker = true) AS
  SELECT * FROM public.read_person_permits_fieldwork();
COMMENT ON VIEW public.person_permits_fieldwork IS
  'Organization-scoped operational permit projection for authorized person-search users. Contact fields are null outside active operations roles. Never exposes firearm licence numbers or raw identity evidence.';

CREATE OR REPLACE FUNCTION public.search_people(p_query text, p_limit integer DEFAULT 25)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_query text := regexp_replace(lower(trim(coalesce(p_query, ''))), '\s+', ' ', 'g');
  v_norm text;
  v_tokens text[];
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_orgs uuid[];
  v_identity_orgs uuid[];
  v_contact_orgs uuid[];
  v_result jsonb;
BEGIN
  IF NOT public.can_search_people() THEN
    RAISE EXCEPTION 'Person-search authorization required' USING ERRCODE = '42501';
  END IF;
  v_norm := regexp_replace(v_query, '[^a-z0-9]+', '', 'g');
  IF length(v_norm) < 2 THEN RAISE EXCEPTION 'Enter at least two letters or numbers'; END IF;
  v_tokens := array(
    SELECT token FROM unnest(regexp_split_to_array(regexp_replace(v_query, '[^a-z0-9 ]+', '', 'g'), ' ')) token
    WHERE token <> ''
  );
  v_orgs := array(SELECT o.id FROM public.organizations o WHERE public.can_search_people(o.id));
  v_identity_orgs := array(SELECT org_id FROM unnest(v_orgs) org_id WHERE public.can_access_vehicle_owner_identity(org_id));
  v_contact_orgs := array(SELECT org_id FROM unnest(v_orgs) org_id WHERE public.can_access_person_contacts(org_id));

  WITH matched AS (
    SELECT p.id FROM public.canonical_people p
    WHERE p.status = 'active'
      AND (p.normalized_name LIKE '%' || v_norm || '%'
        OR (cardinality(v_tokens) > 1 AND NOT EXISTS (
          SELECT 1 FROM unnest(v_tokens) token WHERE position(token IN lower(coalesce(p.display_name, ''))) = 0)))
    UNION
    SELECT link.canonical_person_id
    FROM public.person_record_aliases alias
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = alias.person_record_id
    WHERE alias.active AND alias.organization_id = ANY(v_orgs) AND alias.alias_norm LIKE '%' || v_norm || '%'
    UNION
    SELECT link.canonical_person_id
    FROM public.person_records record
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = record.id
    WHERE record.organization_id = ANY(v_orgs)
      AND regexp_replace(lower(coalesce(record.display_name, '')), '[^a-z0-9]+', '', 'g') LIKE '%' || v_norm || '%'
    UNION
    SELECT permit.canonical_person_id FROM public.person_permits permit
    WHERE permit.organization_id = ANY(v_orgs)
      AND regexp_replace(lower(permit.permit_number), '[^a-z0-9]+', '', 'g') = v_norm
  ), visible AS (
    SELECT p.* FROM public.canonical_people p
    WHERE p.id IN (SELECT id FROM matched) AND p.status = 'active'
      AND (EXISTS (SELECT 1 FROM public.canonical_person_links link
                   WHERE link.canonical_person_id = p.id AND link.organization_id = ANY(v_orgs))
        OR EXISTS (SELECT 1 FROM public.notices notice
                   WHERE notice.person_id = p.id AND notice.organization_id = ANY(v_orgs))
        OR EXISTS (SELECT 1 FROM public.person_permits permit
                   WHERE permit.canonical_person_id = p.id AND permit.organization_id = ANY(v_orgs)))
  ), ranked AS (
    SELECT v.*,
      (v.normalized_name = v_norm OR EXISTS (
        SELECT 1 FROM public.person_permits permit
        WHERE permit.canonical_person_id = v.id AND permit.organization_id = ANY(v_orgs)
          AND regexp_replace(lower(permit.permit_number), '[^a-z0-9]+', '', 'g') = v_norm)) AS exact_match,
      EXISTS (SELECT 1 FROM public.notices notice
              WHERE notice.person_id = v.id AND notice.organization_id = ANY(v_orgs)
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
    'contact_details_authorised', cardinality(v_contact_orgs) > 0,
    'aliases', coalesce((
      SELECT jsonb_agg(DISTINCT alias.alias)
      FROM public.canonical_person_links link
      JOIN public.person_record_aliases alias ON alias.person_record_id = link.source_id AND alias.active
      WHERE link.canonical_person_id = r.id AND link.source_table = 'person_records' AND alias.organization_id = ANY(v_orgs)
    ), '[]'::jsonb),
    'organizations', coalesce((
      SELECT jsonb_agg(DISTINCT org.name) FROM public.organizations org
      WHERE org.id = ANY(v_orgs)
        AND (EXISTS (SELECT 1 FROM public.canonical_person_links link WHERE link.canonical_person_id = r.id AND link.organization_id = org.id)
          OR EXISTS (SELECT 1 FROM public.notices notice WHERE notice.person_id = r.id AND notice.organization_id = org.id)
          OR EXISTS (SELECT 1 FROM public.person_permits permit WHERE permit.canonical_person_id = r.id AND permit.organization_id = org.id))
    ), '[]'::jsonb),
    'notices', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'notice_id', notice.id, 'organization_id', notice.organization_id, 'organization_name', org.name,
        'notice_type', notice.notice_type, 'notice_number', notice.notice_number, 'status', notice.status,
        'issued_at', notice.issued_at, 'expires_at', notice.expires_at,
        'expiry_state', public.notice_expiry_state(notice.status, notice.expires_at), 'location_name', place.name
      ) ORDER BY notice.issued_at DESC NULLS LAST)
      FROM public.notices notice JOIN public.organizations org ON org.id = notice.organization_id
      LEFT JOIN public.observations observation ON observation.id = notice.observation_id
      LEFT JOIN public.locations place ON place.id = coalesce(notice.location_id, observation.location_id)
      WHERE notice.person_id = r.id AND notice.organization_id = ANY(v_orgs)
    ), '[]'::jsonb),
    'permits', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'permit_id', permit.id, 'organization_name', org.name, 'client_organization_name', client.name,
        'permit_number', permit.permit_number, 'permit_type', permit.permit_type,
        'applicant_type', permit.applicant_type, 'company_name', permit.company_name, 'status', permit.status,
        'validity_state', public.person_permit_validity(permit.status, permit.date_from, permit.date_to),
        'date_from', permit.date_from, 'date_to', permit.date_to,
        'forest_areas', coalesce(to_jsonb(permit.forest_areas), '[]'::jsonb),
        'activities', coalesce(to_jsonb(permit.activities), '[]'::jsonb),
        'hunting_season', permit.hunting_season, 'firearm_licence_valid', permit.firearm_licence_valid,
        'chainsaw_safety_equipment', permit.chainsaw_safety_equipment, 'keys_issued', permit.keys_issued,
        'conditions', permit.conditions,
        'contact_email', CASE WHEN permit.organization_id = ANY(v_contact_orgs) THEN permit.contact_email END,
        'contact_phone', CASE WHEN permit.organization_id = ANY(v_contact_orgs) THEN permit.contact_phone END,
        'address_text', CASE WHEN permit.organization_id = ANY(v_contact_orgs) THEN permit.address_text END,
        'compliance_checked_at', permit.compliance_checked_at, 'source_document', permit.source_document,
        'vehicles', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'canonical_vehicle_id', vehicle.id, 'plate_number', vehicle.plate_number,
            'make', vehicle.make, 'model', vehicle.model, 'colour', vehicle.colour
          ) ORDER BY vehicle.plate_number)
          FROM public.person_permit_vehicles permit_vehicle
          JOIN public.canonical_vehicles vehicle ON vehicle.id = permit_vehicle.canonical_vehicle_id
          WHERE permit_vehicle.permit_id = permit.id
        ), '[]'::jsonb)
      ) ORDER BY permit.date_to DESC NULLS LAST, permit.created_at DESC)
      FROM public.person_permits permit JOIN public.organizations org ON org.id = permit.organization_id
      LEFT JOIN public.organizations client ON client.id = permit.client_organization_id
      WHERE permit.canonical_person_id = r.id AND permit.organization_id = ANY(v_orgs)
    ), '[]'::jsonb),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'canonical_vehicle_id', vehicle.id, 'plate_number', vehicle.plate_number,
        'make', vehicle.make, 'model', vehicle.model, 'colour', vehicle.colour,
        'relationship', link.relationship, 'since', link.starts_at,
        'source', CASE WHEN link.organization_id = ANY(v_identity_orgs) THEN link.evidence->>'source' END,
        'source_checked_at', CASE WHEN link.organization_id = ANY(v_identity_orgs) THEN link.evidence->>'source_checked_at' END
      ) ORDER BY link.starts_at DESC NULLS LAST)
      FROM public.entity_links link JOIN public.canonical_vehicles vehicle ON vehicle.id = link.to_id
      WHERE link.from_type = 'person' AND link.from_id = r.id AND link.to_type = 'vehicle'
        AND link.active AND link.organization_id = ANY(v_orgs)
        AND (link.relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person')
          OR link.organization_id = ANY(v_identity_orgs))
    ), '[]'::jsonb),
    'nzta_authorised', cardinality(v_identity_orgs) > 0,
    'nzta', CASE WHEN cardinality(v_identity_orgs) = 0 THEN NULL ELSE (
      SELECT jsonb_build_object(
        'address', CASE WHEN check_row.organization_id = ANY(v_contact_orgs) THEN
          coalesce(doc.extracted_fields->'approved'->>'address',
                   doc.extracted_fields->'proposed'->>'physical_address',
                   doc.extracted_fields->'proposed'->>'address') END,
        'last_checked_at', check_row.checked_at,
        'checks', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'plate_number', checked_vehicle.plate_number, 'checked_at', history.checked_at
          ) ORDER BY history.checked_at DESC), '[]'::jsonb)
          FROM public.vehicle_identity_checks history
          JOIN public.canonical_vehicles checked_vehicle ON checked_vehicle.id = history.canonical_vehicle_id
          WHERE history.canonical_person_id = r.id AND history.organization_id = ANY(v_identity_orgs)
        )
      )
      FROM public.vehicle_identity_checks check_row
      JOIN public.person_identity_documents doc ON doc.id = check_row.identity_document_id
      WHERE check_row.canonical_person_id = r.id AND check_row.organization_id = ANY(v_identity_orgs)
      ORDER BY check_row.checked_at DESC LIMIT 1
    ) END
  ) ORDER BY r.exact_match DESC, r.has_notice_in_force DESC, r.display_name), '[]'::jsonb)
  INTO v_result FROM ranked r;
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.search_people(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.search_people(text, integer) TO authenticated;
COMMENT ON FUNCTION public.search_people(text, integer) IS
  'Authorized operational person search by name, alias or exact permit number. Organization-scoped notices, permits and linked vehicles; NZTA identity remains separately authorized. Private contact/address values require active Admin, Admin officer, Master or Grand Master access, including NZTA addresses (owner ruling 2026-10-27). No firearm licence numbers.';

CREATE OR REPLACE FUNCTION public.get_vehicle_owner_links(p_organization_id uuid, p_canonical_vehicle_id uuid)
RETURNS TABLE(link_id uuid, relationship text, active boolean, source text, basis text, nzta_restricted boolean,
  person_record_id uuid, canonical_person_id uuid, display_name text, phone text, email text, address text,
  locality text, observation_ids uuid[], details_visible boolean, recorded_at timestamptz, recorded_by_name text,
  ended_at timestamptz, source_checked_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_full boolean;
  v_contacts boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Organization access required' USING ERRCODE = '42501';
  END IF;
  v_full := public.can_access_vehicle_owner_identity(p_organization_id);
  v_contacts := v_full AND public.can_access_person_contacts(p_organization_id);
  RETURN QUERY
  SELECT link.id, link.relationship, link.active, link.evidence->>'source',
    CASE WHEN v_contacts THEN link.evidence->>'basis' END,
    coalesce((link.evidence->>'nzta_restricted')::boolean, false),
    CASE WHEN v_full THEN person_record.id END,
    CASE WHEN v_full THEN link.from_id END,
    CASE WHEN v_full THEN coalesce(person_record.display_name, canonical_person.display_name) END,
    CASE WHEN v_contacts THEN person_record.metadata->'profile_details'->>'phone' END,
    CASE WHEN v_contacts THEN person_record.metadata->'profile_details'->>'email' END,
    CASE WHEN v_contacts THEN person_record.metadata->'profile_details'->>'address' END,
    CASE WHEN v_contacts THEN public.vehicle_owner_locality(person_record.metadata->'profile_details') END,
    coalesce(ARRAY(
      SELECT (item #>> '{}')::uuid
      FROM jsonb_array_elements(coalesce(link.evidence->'observation_ids', '[]'::jsonb)) item
    ), ARRAY[]::uuid[]),
    v_full, link.created_at, user_profile.display_name,
    CASE WHEN v_full OR NOT (link.evidence ? 'nzta_owner_history_first_check_id') THEN link.ends_at END,
    CASE WHEN v_full THEN nullif(link.evidence->>'source_checked_at', '')::timestamptz END
  FROM public.entity_links link
  LEFT JOIN public.person_records person_record
    ON person_record.id = (link.evidence->>'person_record_id')::uuid AND person_record.organization_id = link.organization_id
  LEFT JOIN public.canonical_people canonical_person ON canonical_person.id = link.from_id
  LEFT JOIN public.user_profiles user_profile ON user_profile.id = link.created_by
  WHERE link.organization_id = p_organization_id AND link.to_type = 'vehicle'
    AND link.to_id = p_canonical_vehicle_id AND link.from_type = 'person'
    AND link.relationship IN ('owner', 'registered_owner', 'driver', 'associated_person')
    AND NOT coalesce(link.evidence->>'superseded_by_reconciliation', 'false')::boolean
  ORDER BY link.active DESC, (link.relationship IN ('owner', 'registered_owner')) DESC, link.created_at DESC
  LIMIT 50;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_vehicle_owner_links(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_owner_links(uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.get_vehicle_owner_links(uuid, uuid) IS
  'Scoped vehicle-person links: NZTA authorization exposes identity, not private contact/address/locality or free-text basis. Those require active operations administrator roles. Owner history remains source-time observations, never legal transfer dates.';

CREATE OR REPLACE FUNCTION public.find_person_matches(
  p_organization_id uuid, p_name text DEFAULT NULL, p_date_of_birth date DEFAULT NULL,
  p_licence_number text DEFAULT NULL, p_phone text DEFAULT NULL, p_email text DEFAULT NULL,
  p_exclude_person_record_id uuid DEFAULT NULL, p_limit integer DEFAULT 8
) RETURNS TABLE(person_record_id uuid, display_name text, review_state text, matched_name text,
  match_basis text, score real, strength text, aliases text[], locality text, origin text, sighting_count bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_norm text := public.normalize_person_name(p_name);
  v_lower text := nullif(lower(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g')), '');
  v_first text;
  v_last text;
  v_licence text := nullif(upper(regexp_replace(coalesce(p_licence_number, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_phone text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '');
  v_email text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_contacts boolean := public.can_access_person_contacts(p_organization_id);
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.org_access_allowed(p_organization_id)
    OR NOT (public.can_search_people(p_organization_id) OR public.can_access_vehicle_owner_identity(p_organization_id)) THEN
    RAISE EXCEPTION 'Person-search or vehicle-owner authorization required' USING ERRCODE = '42501';
  END IF;
  IF NOT v_contacts AND (v_phone IS NOT NULL OR v_email IS NOT NULL) THEN
    RAISE EXCEPTION 'Contact-detail matching requires an operations administrator' USING ERRCODE = '42501';
  END IF;
  IF v_norm IS NULL AND v_licence IS NULL AND (v_phone IS NULL OR length(v_phone) < 7) AND v_email IS NULL THEN
    RAISE EXCEPTION 'Enter a name or an authorized identity detail to match';
  END IF;
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
    WHERE pr.organization_id = p_organization_id AND pr.id IS DISTINCT FROM p_exclude_person_record_id
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
        WHEN public.normalize_person_name(n.name) = v_norm THEN CASE WHEN n.name_kind = 'alias' THEN 'alias_exact' ELSE 'name_exact' END
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
      public.normalize_person_name(n.name) = v_norm OR extensions.similarity(lower(n.name), v_lower) >= 0.45
      OR (v_last IS NOT NULL AND lower(regexp_replace(trim(n.name), '^.* ', '')) = v_last
        AND length(v_first) >= 2 AND length(split_part(lower(trim(n.name)), ' ', 1)) >= 2
        AND (position(v_first IN split_part(lower(trim(n.name)), ' ', 1)) > 0
          OR position(split_part(lower(trim(n.name)), ' ', 1) IN v_first) > 0))
    )
  ), detail_hits AS (
    SELECT p.id, p.display_name AS name,
      CASE WHEN v_licence IS NOT NULL AND v_licence IN (
        upper(regexp_replace(coalesce(p.details->>'driver_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(coalesce(p.details->>'firearms_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(coalesce(p.details->>'security_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(coalesce(p.details->>'document_number', ''), '[^A-Za-z0-9]', '', 'g'))) THEN 'credential_number_exact'
        WHEN v_phone IS NOT NULL AND regexp_replace(coalesce(p.details->>'phone', ''), '[^0-9]', '', 'g') = v_phone THEN 'phone_exact'
        ELSE 'email_exact' END AS basis,
      CASE WHEN v_licence IS NOT NULL AND v_licence IN (
        upper(regexp_replace(coalesce(p.details->>'driver_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(coalesce(p.details->>'firearms_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(coalesce(p.details->>'security_licence_number', ''), '[^A-Za-z0-9]', '', 'g')),
        upper(regexp_replace(coalesce(p.details->>'document_number', ''), '[^A-Za-z0-9]', '', 'g'))) THEN 1.0
        ELSE 0.90 END::real AS score
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
      CASE WHEN p_date_of_birth IS NOT NULL AND nullif(p.details->>'date_of_birth', '')::date = p_date_of_birth
        THEN greatest(h.score, 0.97)::real ELSE h.score END AS score,
      (p_date_of_birth IS NOT NULL AND nullif(p.details->>'date_of_birth', '')::date = p_date_of_birth) AS dob_match
    FROM (SELECT * FROM name_hits UNION ALL SELECT * FROM detail_hits) h JOIN people p ON p.id = h.id
  ), ranked AS (
    SELECT DISTINCT ON (h.id) h.id, h.name, h.basis || CASE WHEN h.dob_match THEN '+date_of_birth' ELSE '' END AS basis, h.score
    FROM hits h ORDER BY h.id, h.score DESC
  )
  SELECT p.id, p.display_name, p.review_state, r.name, r.basis, r.score,
    CASE WHEN r.score >= 0.95 THEN 'strong' WHEN r.score >= 0.80 THEN 'likely' ELSE 'possible' END,
    coalesce(ARRAY(SELECT a.alias FROM public.person_record_aliases a WHERE a.person_record_id = p.id AND a.active ORDER BY a.created_at), ARRAY[]::text[]),
    CASE WHEN v_contacts THEN public.vehicle_owner_locality(p.details) END,
    coalesce(p.metadata->>'origin', p.metadata->>'created_from'),
    (SELECT count(*) FROM public.cctv_entity_observations c WHERE c.person_record_id = p.id)
      + (SELECT count(*) FROM public.observations o WHERE o.person_record_id = p.id)
  FROM ranked r JOIN people p ON p.id = r.id
  ORDER BY r.score DESC, p.review_state = 'verified' DESC, p.display_name
  LIMIT least(greatest(coalesce(p_limit, 8), 1), 25);
END;
$function$;
REVOKE ALL ON FUNCTION public.find_person_matches(uuid, text, date, text, text, text, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.find_person_matches(uuid, text, date, text, text, text, uuid, integer) TO authenticated;
COMMENT ON FUNCTION public.find_person_matches(uuid, text, date, text, text, text, uuid, integer) IS
  'Duplicate-prevention matching for authorized person-search or vehicle-owner users. Contact matching and returned locality are operations-administrator-only. No private contact values are returned.';