-- CLI-generated draft reordered after the latest committed catalog migration (20261101160000).
BEGIN;

ALTER TABLE public.client_sites DROP CONSTRAINT client_sites_geo_required_chk;
ALTER TABLE public.client_sites ADD CONSTRAINT client_sites_geo_required_chk CHECK (
  center_point IS NOT NULL OR boundary IS NOT NULL OR (
    coalesce(metadata->>'created_via' = 'service_client_setup', false)
    AND boundary_status = 'provisional' AND boundary_verification = 'unverified'
  )
) NOT VALID;

ALTER TABLE public.location_zones
  ADD COLUMN is_verification_point boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.location_zones.is_verification_point IS
  'Officer-confirmed reference zone, not a replacement perimeter or a source of regulatory rules.';
ALTER TABLE public.location_zones ADD CONSTRAINT verification_point_has_geometry CHECK (
  NOT is_verification_point OR (radius_meters IS NOT NULL AND radius_meters = 10
    AND center_point IS NOT NULL AND boundary IS NOT NULL)
);
CREATE UNIQUE INDEX location_zone_verification_anchor_unique
  ON public.location_zones (location_id, (metadata->>'verification_anchor'))
  WHERE is_verification_point;
CREATE UNIQUE INDEX service_place_request_receipt_unique
  ON public.audit_log (organization_id, actor_user_id, action, (metadata->>'request_id'))
  WHERE action IN ('service_client_saved','service_location_created','field_place_verified');

CREATE OR REPLACE FUNCTION public.guard_field_verification_point()
RETURNS trigger LANGUAGE plpgsql SET search_path = public
AS $function$
BEGIN
  IF OLD.is_verification_point THEN
    IF NOT NEW.is_verification_point OR jsonb_typeof(NEW.metadata->'field_capture') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Keep the field verification provenance. Edit the surrounding site or area instead';
    END IF;
    IF NEW.metadata->'field_capture' IS NOT DISTINCT FROM OLD.metadata->'field_capture'
      AND (NEW.boundary IS DISTINCT FROM OLD.boundary OR NEW.center_point IS DISTINCT FROM OLD.center_point
        OR NEW.radius_meters IS DISTINCT FROM OLD.radius_meters
        OR NEW.boundary_verification IS DISTINCT FROM OLD.boundary_verification
        OR NEW.boundary_verified_by IS DISTINCT FROM OLD.boundary_verified_by
        OR NEW.boundary_verified_at IS DISTINCT FROM OLD.boundary_verified_at
        OR NEW.is_active IS DISTINCT FROM OLD.is_active
        OR NEW.location_id IS DISTINCT FROM OLD.location_id OR NEW.parent_zone_id IS DISTINCT FROM OLD.parent_zone_id) THEN
      RAISE EXCEPTION 'Use Places to capture and confirm a new verification point; edit the surrounding perimeter separately';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.guard_field_verification_point() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER aa_field_verification_point BEFORE UPDATE ON public.location_zones
  FOR EACH ROW EXECUTE FUNCTION public.guard_field_verification_point();

CREATE OR REPLACE FUNCTION public.field_place_provider_allowed(p_provider_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT p_provider_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.user_profiles u
    WHERE u.id = auth.uid() AND u.deactivated_at IS NULL
      AND u.role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master')
      AND (u.organization_id = p_provider_id
        OR (u.role IN ('admin_officer', 'admin', 'master', 'grand_master')
          AND public.is_admin_for_org(p_provider_id))
        OR EXISTS (SELECT 1 FROM public.staff_branch_authorisations b
          WHERE b.user_id = u.id AND b.branch_org_id = p_provider_id AND b.status = 'active'
            AND (b.starts_on IS NULL OR b.starts_on <= current_date)
            AND (b.ends_on IS NULL OR b.ends_on >= current_date)))
  );
$function$;
REVOKE ALL ON FUNCTION public.field_place_provider_allowed(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.field_place_client_allowed(p_provider_id uuid, p_client_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT p_client_id IS NOT NULL AND public.field_place_provider_allowed(p_provider_id) AND
    (p_client_id = p_provider_id OR EXISTS (
      SELECT 1 FROM public.service_agreements a
      WHERE a.provider_organization_id = p_provider_id AND a.client_organization_id = p_client_id
        AND a.agreement_type = 'operational'
        AND (a.starts_on IS NULL OR a.starts_on <= current_date)
        AND (a.ends_on IS NULL OR a.ends_on >= current_date)
        AND (a.invitation_status = 'accepted'
          OR a.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL)
    ));
$function$;
REVOKE ALL ON FUNCTION public.field_place_client_allowed(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.field_place_agreement_id(p_provider_id uuid, p_client_id uuid)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_ids uuid[];
BEGIN
  IF NOT public.field_place_client_allowed(p_provider_id, p_client_id) THEN
    RAISE EXCEPTION 'No confirmed operational engagement for this client';
  END IF;
  IF p_provider_id = p_client_id THEN RETURN NULL; END IF;
  SELECT array_agg(id ORDER BY created_at) INTO v_ids FROM public.service_agreements
    WHERE provider_organization_id = p_provider_id AND client_organization_id = p_client_id
      AND agreement_type = 'operational'
      AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date)
      AND (invitation_status = 'accepted' OR external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL);
  IF coalesce(cardinality(v_ids), 0) <> 1 THEN
    RAISE EXCEPTION 'One current operational agreement is required. Ask an administrator to review the client agreements';
  END IF;
  RETURN v_ids[1];
END;
$function$;
REVOKE ALL ON FUNCTION public.field_place_agreement_id(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_field_place_workspace(
  p_provider_id uuid, p_client_id uuid DEFAULT NULL, p_search text DEFAULT '',
  p_offset integer DEFAULT 0, p_location_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_clients jsonb; v_places jsonb; v_count integer;
BEGIN
  IF auth.uid() IS NULL OR NOT public.field_place_provider_allowed(p_provider_id) THEN
    RAISE EXCEPTION 'An active field or administrator role in this provider is required';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 OR char_length(coalesce(p_search, '')) > 200 THEN
    RAISE EXCEPTION 'Invalid location search or page';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) ORDER BY o.name), '[]')
  INTO v_clients FROM public.organizations o
  WHERE o.id = p_provider_id OR o.id IN (
    SELECT a.client_organization_id FROM public.service_agreements a
    WHERE a.provider_organization_id = p_provider_id AND a.agreement_type = 'operational'
      AND (a.starts_on IS NULL OR a.starts_on <= current_date)
      AND (a.ends_on IS NULL OR a.ends_on >= current_date)
      AND (a.invitation_status = 'accepted' OR a.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL)
  );
  IF p_client_id IS NULL AND p_location_id IS NOT NULL THEN
    SELECT organization_id INTO p_client_id FROM public.locations WHERE id = p_location_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Location is not available'; END IF;
  END IF;
  IF p_client_id IS NULL THEN
    RETURN jsonb_build_object('clients', v_clients, 'places', '[]'::jsonb, 'total', 0);
  END IF;
  IF NOT public.field_place_client_allowed(p_provider_id, p_client_id) THEN
    RAISE EXCEPTION 'This client has no confirmed operational engagement with your provider';
  END IF;
  SELECT count(*) INTO v_count FROM public.locations l
  WHERE l.organization_id = p_client_id AND (p_location_id IS NULL OR l.id = p_location_id)
    AND (coalesce(p_search, '') = '' OR strpos(lower(l.name || ' ' || coalesce(l.address, '')), lower(p_search)) > 0);
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.name, q.id), '[]') INTO v_places FROM (
    SELECT l.id, l.name, l.address, l.notes, l.updated_at, l.organization_id,
      l.canonical_place_id,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'active', s.active, 'site_type', s.site_type,
        'lat', ST_Y(s.center_point), 'lng', ST_X(s.center_point),
        'gps_lat', s.gps_lat, 'gps_lng', s.gps_lng, 'boundary_status', s.boundary_status,
        'boundary', ST_AsGeoJSON(s.boundary)::jsonb, 'boundary_verification', s.boundary_verification,
        'risk_level', s.risk_level, 'site_brief', s.site_brief, 'access_instructions', s.access_instructions,
        'hs_notes', s.hs_notes, 'configuration_version', s.configuration_version
      ) ORDER BY s.created_at) FROM public.client_sites s WHERE s.location_id = l.id), '[]') AS sites,
      coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id', z.id, 'name', z.name, 'active', z.is_active, 'module_key', z.module_key,
        'lat', ST_Y(z.center_point), 'lng', ST_X(z.center_point),
        'boundary', ST_AsGeoJSON(z.boundary)::jsonb, 'boundary_verification', z.boundary_verification,
        'boundary_status', z.boundary_status,
        'is_verification_point', z.is_verification_point, 'radius_meters', z.radius_meters,
        'verified_at', z.boundary_verified_at, 'verified_by', u.display_name,
        'capture', z.metadata->'field_capture', 'configuration_version', z.configuration_version
      ) ORDER BY z.is_verification_point, z.created_at)
      FROM public.location_zones z LEFT JOIN public.user_profiles u ON u.id = z.boundary_verified_by
      WHERE z.location_id = l.id), '[]') AS zones
    FROM public.locations l
    WHERE l.organization_id = p_client_id AND (p_location_id IS NULL OR l.id = p_location_id)
      AND (coalesce(p_search, '') = '' OR strpos(lower(l.name || ' ' || coalesce(l.address, '')), lower(p_search)) > 0)
    ORDER BY l.name, l.id LIMIT 100 OFFSET p_offset
  ) q;
  RETURN jsonb_build_object('clients', v_clients, 'places', v_places, 'total', v_count);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_field_place_workspace(uuid, uuid, text, integer, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_field_place_workspace(uuid, uuid, text, integer, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_service_client(
  p_request_id uuid, p_provider_id uuid, p_client_id uuid, p_expected_updated_at timestamptz,
  p_name text, p_email text, p_phone text, p_notes text, p_confirm_engagement boolean
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_actor uuid := auth.uid(); v_org public.organizations%rowtype;
  v_agreement public.service_agreements%rowtype; v_request jsonb; v_prior jsonb; v_result jsonb;
BEGIN
  IF v_actor IS NULL OR NOT public.field_place_provider_allowed(p_provider_id)
    OR NOT public.is_admin_for_org(p_provider_id) THEN
    RAISE EXCEPTION 'An active provider administrator is required';
  END IF;
  IF p_request_id IS NULL OR nullif(trim(p_name), '') IS NULL OR char_length(p_name) > 200
    OR char_length(coalesce(p_notes, '')) > 10000 THEN
    RAISE EXCEPTION 'A request ID and client name of up to 200 characters are required';
  END IF;
  IF nullif(trim(coalesce(p_email, '')), '') IS NOT NULL
    AND trim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid contact email or leave it empty';
  END IF;
  v_request := jsonb_build_object('client_id', p_client_id, 'version', p_expected_updated_at,
    'name', trim(p_name), 'email', p_email, 'phone', p_phone, 'notes', p_notes, 'engaged', p_confirm_engagement);
  PERFORM pg_advisory_xact_lock(hashtextextended('service-client:' || p_provider_id || ':' || p_request_id, 0));
  SELECT metadata INTO v_prior FROM public.audit_log
    WHERE organization_id = p_provider_id AND actor_user_id = v_actor AND action = 'service_client_saved'
      AND metadata->>'request_id' = p_request_id::text LIMIT 1;
  IF FOUND THEN
    IF v_prior->'request' IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'Retry contains changed client details'; END IF;
    RETURN v_prior->'result';
  END IF;
  IF p_client_id IS NULL THEN
    IF p_confirm_engagement IS DISTINCT FROM true THEN RAISE EXCEPTION 'Confirm the provider is engaged by this client'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('service-client-name:' || lower(trim(p_name)), 0));
    IF EXISTS (SELECT 1 FROM public.organizations WHERE lower(trim(name)) = lower(trim(p_name))) THEN
      RAISE EXCEPTION 'An organisation with this name already exists. Select its existing record instead of creating a duplicate';
    END IF;
    INSERT INTO public.organizations(name, organization_type, parent_organization_id, active, status,
      contact_email, contact_phone, account_notes, client_request_id)
    VALUES (trim(p_name), 'client', NULL, true, 'active', nullif(trim(p_email), ''),
      nullif(trim(p_phone), ''), nullif(trim(p_notes), ''), p_request_id) RETURNING * INTO v_org;
  ELSE
    IF p_client_id = p_provider_id OR (NOT public.crm_actor_can_manage_account(p_client_id) AND NOT (
      p_confirm_engagement IS TRUE AND EXISTS (
        SELECT 1 FROM public.service_agreements pending
        WHERE pending.provider_organization_id = p_provider_id AND pending.client_organization_id = p_client_id
          AND pending.agreement_type = 'operational' AND pending.invitation_status IN ('not_invited', 'invited')
          AND (pending.starts_on IS NULL OR pending.starts_on <= current_date)
          AND (pending.ends_on IS NULL OR pending.ends_on >= current_date)
      )
    )) THEN
      RAISE EXCEPTION 'Client is outside your managed operational accounts';
    END IF;
    SELECT * INTO v_org FROM public.organizations WHERE id = p_client_id FOR UPDATE;
    IF NOT FOUND OR p_expected_updated_at IS NULL OR v_org.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Client changed since it was opened. Reload before saving';
    END IF;
    UPDATE public.organizations SET name = trim(p_name), contact_email = nullif(trim(p_email), ''),
      contact_phone = nullif(trim(p_phone), ''), account_notes = nullif(trim(p_notes), ''), updated_at = clock_timestamp()
      WHERE id = p_client_id RETURNING * INTO v_org;
  END IF;
  IF p_confirm_engagement THEN
    IF (SELECT count(*) FROM public.service_agreements
      WHERE provider_organization_id = p_provider_id AND client_organization_id = v_org.id
        AND agreement_type = 'operational'
        AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date)) > 1 THEN
      RAISE EXCEPTION 'Several current agreements exist. Confirm engagement in the agreement workspace instead';
    END IF;
    SELECT * INTO v_agreement FROM public.service_agreements
      WHERE provider_organization_id = p_provider_id AND client_organization_id = v_org.id
        AND agreement_type = 'operational'
        AND (starts_on IS NULL OR starts_on <= current_date) AND (ends_on IS NULL OR ends_on >= current_date)
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.service_agreements(provider_organization_id, client_organization_id, name,
        agreement_type, starts_on, invitation_status, client_portal_access_mode)
      VALUES (p_provider_id, v_org.id, v_org.name || ' services', 'operational', current_date,
        'not_invited', 'transparency_only') RETURNING * INTO v_agreement;
    END IF;
    UPDATE public.service_agreements SET external_refs = coalesce(external_refs, '{}') || jsonb_build_object(
      'engagement_confirmation', jsonb_build_object('confirmed_by', v_actor, 'confirmed_at', clock_timestamp(),
        'source', 'provider_administrator', 'request_id', p_request_id))
      WHERE id = v_agreement.id;
  END IF;
  v_result := jsonb_build_object('id', v_org.id, 'name', v_org.name, 'updated_at', v_org.updated_at,
    'agreement_id', v_agreement.id, 'engagement_confirmed', public.field_place_client_allowed(p_provider_id, v_org.id),
    'contact_email', v_org.contact_email, 'contact_phone', v_org.contact_phone, 'account_notes', v_org.account_notes);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_provider_id, v_actor, 'service_client_saved', 'organizations', v_org.id,
      jsonb_build_object('request_id', p_request_id, 'request', v_request, 'result', v_result));
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_service_client(uuid, uuid, uuid, timestamptz, text, text, text, text, boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_service_client(uuid, uuid, uuid, timestamptz, text, text, text, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.capture_field_place(
  p_request_id uuid, p_provider_id uuid, p_client_id uuid, p_location_id uuid,
  p_expected_updated_at timestamptz, p_place_kind text, p_name text,
  p_capture jsonb, p_map_confirmed boolean, p_parent_zone_id uuid DEFAULT NULL,
  p_target_site_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_actor uuid := auth.uid(); v_house public.locations%rowtype; v_zone public.location_zones%rowtype;
  v_site_id uuid; v_parent geometry; v_point geometry; v_circle geometry; v_raw geometry;
  v_time timestamptz; v_accuracy double precision; v_prior jsonb; v_request jsonb;
  v_result jsonb; v_anchor text; v_agreement_id uuid; v_created boolean := false; v_field jsonb;
  v_new_id uuid := gen_random_uuid();
BEGIN
  IF v_actor IS NULL OR NOT public.field_place_client_allowed(p_provider_id, p_client_id) THEN
    RAISE EXCEPTION 'Field place access requires an active role and confirmed operational client';
  END IF;
  IF p_request_id IS NULL OR p_map_confirmed IS DISTINCT FROM true OR p_place_kind NOT IN ('site', 'zone')
    OR p_place_kind IS NULL OR nullif(trim(p_name), '') IS NULL OR char_length(p_name) > 200 THEN
    RAISE EXCEPTION 'Choose a client, place type and name, then confirm the point on the map';
  END IF;
  IF jsonb_typeof(p_capture) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_capture->'lat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_capture->'lng') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_capture->'accuracy') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_capture->'confirmed_lat') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_capture->'confirmed_lng') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_capture->'captured_at') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'A complete GPS capture and confirmed map point are required';
  END IF;
  IF (p_capture->>'lat')::double precision NOT BETWEEN -90 AND 90
    OR (p_capture->>'confirmed_lat')::double precision NOT BETWEEN -90 AND 90
    OR (p_capture->>'lng')::double precision NOT BETWEEN -180 AND 180
    OR (p_capture->>'confirmed_lng')::double precision NOT BETWEEN -180 AND 180
    OR (p_capture->>'accuracy')::double precision NOT BETWEEN 0.01 AND 100000 THEN
    RAISE EXCEPTION 'GPS coordinates or accuracy are invalid';
  END IF;
  v_request := jsonb_build_object('client', p_client_id, 'location', p_location_id,
    'version', p_expected_updated_at, 'kind', p_place_kind, 'name', trim(p_name),
    'capture', p_capture, 'parent_zone', p_parent_zone_id, 'target_site', p_target_site_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('field-place:' || p_provider_id || ':' || p_request_id, 0));
  SELECT metadata INTO v_prior FROM public.audit_log WHERE organization_id = p_provider_id
    AND actor_user_id = v_actor AND action = 'field_place_verified'
    AND metadata->>'request_id' = p_request_id::text LIMIT 1;
  IF FOUND THEN
    IF v_prior->'request' IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'Retry contains changed field details'; END IF;
    RETURN v_prior->'result';
  END IF;
  v_time := (p_capture->>'captured_at')::timestamptz;
  IF v_time < clock_timestamp() - interval '10 minutes' OR v_time > clock_timestamp() + interval '1 minute' THEN
    RAISE EXCEPTION 'GPS capture is stale. Capture your position again before verifying';
  END IF;
  v_accuracy := (p_capture->>'accuracy')::double precision;
  v_raw := ST_SetSRID(ST_MakePoint((p_capture->>'lng')::double precision, (p_capture->>'lat')::double precision), 4326);
  v_point := ST_SetSRID(ST_MakePoint((p_capture->>'confirmed_lng')::double precision, (p_capture->>'confirmed_lat')::double precision), 4326);
  v_circle := ST_Multi(ST_Buffer(v_point::geography, 10)::geometry);
  v_agreement_id := public.field_place_agreement_id(p_provider_id, p_client_id);
  IF p_location_id IS NULL THEN
    IF p_parent_zone_id IS NOT NULL OR p_target_site_id IS NOT NULL THEN RAISE EXCEPTION 'Select the existing location before its site or zone'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('service-place-name:' || p_client_id || ':' || lower(trim(p_name)), 0));
    IF EXISTS (SELECT 1 FROM public.locations WHERE organization_id = p_client_id AND lower(trim(name)) = lower(trim(p_name))) THEN
      RAISE EXCEPTION 'A location with this name exists for the client. Select it to verify or update it';
    END IF;
    INSERT INTO public.locations(id, organization_id, name, created_by, client_request_id, canonical_place_id)
      VALUES (v_new_id, p_client_id, trim(p_name), v_actor, p_request_id,
        public.canonical_place_for_house(v_new_id, p_client_id, trim(p_name), NULL, NULL, p_place_kind))
      RETURNING * INTO v_house;
    v_created := true;
    IF p_place_kind = 'site' THEN
      INSERT INTO public.client_sites(client_organization_id, location_id, name, site_type, site_origin, service_agreement_id,
        boundary_status, boundary_verification, center_point, metadata)
      VALUES (p_client_id, v_house.id, trim(p_name), 'other', 'adhoc', v_agreement_id, 'provisional', 'unverified', v_point,
        jsonb_build_object('created_via', 'officer_field_capture')) RETURNING id INTO v_site_id;
    ELSE
      INSERT INTO public.location_zones(organization_id, location_id, name, zone_type, module_key, rule_type,
        boundary_status, boundary_verification)
      VALUES (p_client_id, v_house.id, trim(p_name), 'general', 'patrol', 'unrestricted', 'provisional', 'unverified')
      RETURNING id INTO p_parent_zone_id;
    END IF;
  ELSE
    SELECT * INTO v_house FROM public.locations WHERE id = p_location_id AND organization_id = p_client_id FOR UPDATE;
    IF NOT FOUND OR p_expected_updated_at IS NULL OR v_house.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'Location changed or is not available. Reload before verifying';
    END IF;
    IF p_parent_zone_id IS NOT NULL THEN
      IF p_target_site_id IS NOT NULL THEN RAISE EXCEPTION 'Select one site or zone boundary to verify'; END IF;
      SELECT boundary INTO v_parent FROM public.location_zones
        WHERE id = p_parent_zone_id AND location_id = v_house.id AND organization_id = p_client_id
          AND NOT is_verification_point FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'The parent zone does not belong to this location'; END IF;
    ELSE
      IF p_target_site_id IS NULL AND (SELECT count(*) FROM public.client_sites WHERE location_id = v_house.id) > 1 THEN
        RAISE EXCEPTION 'This location has several sites. Select the intended boundary';
      END IF;
      SELECT id, boundary INTO v_site_id, v_parent FROM public.client_sites
        WHERE location_id = v_house.id AND (p_target_site_id IS NULL OR id = p_target_site_id)
        ORDER BY created_at LIMIT 1 FOR UPDATE;
      IF p_target_site_id IS NOT NULL AND NOT FOUND THEN RAISE EXCEPTION 'The site does not belong to this location'; END IF;
      IF v_site_id IS NULL AND EXISTS (SELECT 1 FROM public.location_zones WHERE location_id = v_house.id AND NOT is_verification_point) THEN
        RAISE EXCEPTION 'Select the zone boundary for this location';
      END IF;
    END IF;
    IF v_parent IS NOT NULL THEN
      IF NOT ST_IsValid(v_parent) THEN RAISE EXCEPTION 'The existing boundary is invalid. Ask an administrator to repair it'; END IF;
      IF NOT ST_Covers(v_parent, v_point) THEN RAISE EXCEPTION 'Place the verification point inside the selected boundary'; END IF;
    END IF;
    UPDATE public.locations SET name = trim(p_name), updated_at = clock_timestamp()
      WHERE id = v_house.id RETURNING * INTO v_house;
    IF v_site_id IS NOT NULL THEN
      UPDATE public.client_sites SET name = trim(p_name), center_point = coalesce(center_point, v_point),
        configuration_version = configuration_version + 1,
        service_agreement_id = coalesce(service_agreement_id, v_agreement_id),
        metadata = coalesce(metadata, '{}') || jsonb_build_object('field_place_managed', true)
        WHERE id = v_site_id;
    ELSIF p_parent_zone_id IS NOT NULL THEN
      UPDATE public.location_zones SET name = trim(p_name), center_point = coalesce(center_point, v_point),
        configuration_version = configuration_version + 1 WHERE id = p_parent_zone_id;
    END IF;
  END IF;
  v_anchor := coalesce('zone:' || p_parent_zone_id, 'site:' || v_site_id, 'location:' || v_house.id);
  v_field := p_capture || jsonb_build_object('verified_at', clock_timestamp(), 'verified_by', v_actor,
    'provider_id', p_provider_id, 'radius_m', 10, 'method', CASE WHEN ST_Equals(v_raw, v_point)
      THEN 'gps_and_map_confirmation' ELSE 'gps_with_manual_map_correction' END);
  SELECT * INTO v_zone FROM public.location_zones
    WHERE location_id = v_house.id AND is_verification_point AND metadata->>'verification_anchor' = v_anchor FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.location_zones(organization_id, location_id, name, zone_type, module_key, rule_type,
      is_verification_point, boundary, center_point, radius_meters, boundary_status,
      boundary_verification, boundary_verified_by, boundary_verified_at, metadata, parent_zone_id)
    VALUES (p_client_id, v_house.id, trim(p_name) || ' - verification point',
      'general', 'patrol', 'unrestricted', true, v_circle, v_point, 10, 'provisional', 'verified', v_actor,
      clock_timestamp(), jsonb_build_object('verification_anchor', v_anchor, 'field_capture', v_field), p_parent_zone_id)
    RETURNING * INTO v_zone;
  ELSE
    UPDATE public.location_zones SET name = trim(p_name) || ' - verification point', boundary = v_circle, is_active = true, center_point = v_point, radius_meters = 10,
      boundary_verification = 'verified', boundary_verified_by = v_actor, boundary_verified_at = clock_timestamp(),
      metadata = metadata || jsonb_build_object('field_capture', v_field), configuration_version = configuration_version + 1
      WHERE id = v_zone.id RETURNING * INTO v_zone;
  END IF;
  INSERT INTO public.geofence_boundary_history(entity_type, entity_id, boundary, boundary_source, verification_state,
    verified_by, verified_at, changed_by, changed_via, change_reason, version)
  VALUES ('location_zone', v_zone.id, v_circle, 'officer_gps', 'verified', v_actor, clock_timestamp(), v_actor,
    'verification', 'Officer portal: 10 m reference point confirmed on map; existing perimeter preserved', public._gbh_next_version('location_zone', v_zone.id));
  IF v_agreement_id IS NOT NULL THEN
    IF p_parent_zone_id IS NOT NULL THEN
      INSERT INTO public.service_agreement_locations(service_agreement_id, zone_id, status)
        SELECT v_agreement_id, p_parent_zone_id, 'active'
        WHERE NOT EXISTS (SELECT 1 FROM public.service_agreement_locations WHERE service_agreement_id = v_agreement_id AND zone_id = p_parent_zone_id);
    END IF;
    IF v_site_id IS NOT NULL THEN
      INSERT INTO public.service_agreement_locations(service_agreement_id, site_id, status)
        SELECT v_agreement_id, v_site_id, 'active'
        WHERE NOT EXISTS (SELECT 1 FROM public.service_agreement_locations WHERE service_agreement_id = v_agreement_id AND site_id = v_site_id);
    END IF;
  END IF;
  v_result := jsonb_build_object('location_id', v_house.id, 'site_id', v_site_id, 'zone_id', v_zone.id,
    'created', v_created, 'radius_m', 10, 'verified_at', v_zone.boundary_verified_at, 'updated_at', v_house.updated_at);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_provider_id, v_actor, 'field_place_verified', 'location_zones', v_zone.id,
      jsonb_build_object('request_id', p_request_id, 'request', v_request, 'result', v_result, 'field_capture', v_field));
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.capture_field_place(uuid, uuid, uuid, uuid, timestamptz, text, text, jsonb, boolean, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.capture_field_place(uuid, uuid, uuid, uuid, timestamptz, text, text, jsonb, boolean, uuid, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_service_location(
  p_request_id uuid, p_provider_id uuid, p_client_id uuid, p_name text, p_kind text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_house public.locations%rowtype; v_id uuid; v_agreement uuid; v_prior jsonb; v_new_id uuid := gen_random_uuid();
BEGIN
  IF auth.uid() IS NULL OR NOT public.field_place_client_allowed(p_provider_id, p_client_id)
    OR NOT public.is_admin_for_org(p_provider_id) THEN RAISE EXCEPTION 'Provider administrator access is required'; END IF;
  IF p_request_id IS NULL OR nullif(trim(p_name), '') IS NULL OR char_length(p_name) > 200
    OR p_kind IS NULL OR p_kind NOT IN ('site', 'zone') THEN RAISE EXCEPTION 'A location name and site or zone type are required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('service-place-request:' || p_provider_id || ':' || p_request_id, 0));
  SELECT metadata INTO v_prior FROM public.audit_log WHERE organization_id = p_provider_id
    AND actor_user_id = auth.uid() AND action = 'service_location_created' AND metadata->>'request_id' = p_request_id::text LIMIT 1;
  IF FOUND THEN
    IF v_prior->>'name' IS DISTINCT FROM trim(p_name) OR v_prior->>'kind' IS DISTINCT FROM p_kind
      OR v_prior->>'client_id' IS DISTINCT FROM p_client_id::text THEN RAISE EXCEPTION 'Retry contains changed location details'; END IF;
    RETURN v_prior->'result';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('service-place-name:' || p_client_id || ':' || lower(trim(p_name)), 0));
  IF EXISTS (SELECT 1 FROM public.locations WHERE organization_id = p_client_id AND lower(trim(name)) = lower(trim(p_name))) THEN
    RAISE EXCEPTION 'This client already has a location with this name. Open the existing location';
  END IF;
  v_agreement := public.field_place_agreement_id(p_provider_id, p_client_id);
  INSERT INTO public.locations(id, organization_id, name, created_by, client_request_id, canonical_place_id)
    VALUES (v_new_id, p_client_id, trim(p_name), auth.uid(), p_request_id,
      public.canonical_place_for_house(v_new_id, p_client_id, trim(p_name), NULL, NULL, p_kind))
    RETURNING * INTO v_house;
  IF p_kind = 'site' THEN
    INSERT INTO public.client_sites(client_organization_id, location_id, name, site_type, boundary_status, boundary_verification, metadata, service_agreement_id)
      VALUES (p_client_id, v_house.id, trim(p_name), 'other', 'provisional', 'unverified',
        jsonb_build_object('created_via', 'service_client_setup'), v_agreement) RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.location_zones(organization_id, location_id, name, zone_type, module_key, rule_type, boundary_status, boundary_verification)
      VALUES (p_client_id, v_house.id, trim(p_name), 'general', 'patrol', 'unrestricted', 'provisional', 'unverified') RETURNING id INTO v_id;
  END IF;
  IF v_agreement IS NOT NULL THEN
    INSERT INTO public.service_agreement_locations(service_agreement_id, site_id, zone_id, status, created_by)
      VALUES (v_agreement, CASE WHEN p_kind = 'site' THEN v_id END,
        CASE WHEN p_kind = 'zone' THEN v_id END, 'active', auth.uid()) ON CONFLICT DO NOTHING;
  END IF;
  v_prior := jsonb_build_object('location_id', v_house.id, 'facet_id', v_id, 'kind', p_kind);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_provider_id, auth.uid(), 'service_location_created', 'locations', v_house.id,
      jsonb_build_object('request_id', p_request_id, 'name', trim(p_name), 'kind', p_kind, 'client_id', p_client_id, 'result', v_prior));
  RETURN v_prior;
END;
$function$;
REVOKE ALL ON FUNCTION public.create_service_location(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_service_location(uuid, uuid, uuid, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_service_location_profile(
  p_provider_id uuid, p_location_id uuid, p_expected_updated_at timestamptz, p_name text, p_notes text,
  p_site_id uuid DEFAULT NULL, p_site_version integer DEFAULT NULL, p_site_profile jsonb DEFAULT NULL,
  p_resolved_address jsonb DEFAULT NULL, p_zone_id uuid DEFAULT NULL, p_zone_version integer DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_house public.locations%rowtype; v_zone public.location_zones%rowtype;
BEGIN
  IF auth.uid() IS NULL OR NOT public.field_place_provider_allowed(p_provider_id)
    OR NOT public.is_admin_for_org(p_provider_id) THEN RAISE EXCEPTION 'Provider administrator access is required'; END IF;
  SELECT * INTO v_house FROM public.locations WHERE id = p_location_id FOR UPDATE;
  IF NOT FOUND OR NOT public.field_place_client_allowed(p_provider_id, v_house.organization_id) THEN
    RAISE EXCEPTION 'Location is outside your operational clients';
  END IF;
  IF p_expected_updated_at IS NULL OR v_house.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Location changed since it was opened. Reload before saving';
  END IF;
  IF nullif(trim(p_name), '') IS NULL OR char_length(p_name) > 200 OR char_length(coalesce(p_notes, '')) > 10000 THEN
    RAISE EXCEPTION 'Enter a name up to 200 characters and notes up to 10000 characters';
  END IF;
  IF p_resolved_address IS NOT NULL THEN
    IF jsonb_typeof(p_resolved_address) IS DISTINCT FROM 'object'
      OR nullif(trim(p_resolved_address->>'label'), '') IS NULL
      OR char_length(p_resolved_address->>'label') > 500
      OR coalesce(p_resolved_address->>'source', '') NOT IN ('linz_address','google_address','google_reverse','google_place','council_registry') THEN
      RAISE EXCEPTION 'Choose an address from the address search results';
    END IF;
    IF EXISTS (SELECT 1 FROM public.locations WHERE organization_id = v_house.organization_id
      AND id <> v_house.id AND address_match_key = public.address_match_key(p_resolved_address->>'label')) THEN
      RAISE EXCEPTION 'Another location for this client already has that address. Review the existing location before linking';
    END IF;
  END IF;
  IF p_site_id IS NOT NULL THEN
    IF p_zone_id IS NOT NULL THEN RAISE EXCEPTION 'Edit one site or area profile at a time'; END IF;
    IF p_site_version IS NULL THEN RAISE EXCEPTION 'Site version is required. Reload the profile'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.client_sites WHERE id = p_site_id AND location_id = v_house.id) THEN
      RAISE EXCEPTION 'Site does not belong to this location';
    END IF;
    IF jsonb_typeof(p_site_profile->'active') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Choose the site active state'; END IF;
    UPDATE public.client_sites SET metadata = coalesce(metadata, '{}') || jsonb_build_object('field_place_managed', true)
      WHERE id = p_site_id;
    PERFORM public.manage_crm_site_profile(p_site_id, p_site_version, p_site_profile->>'risk_level',
      p_site_profile->>'site_brief', p_site_profile->>'access_instructions', p_site_profile->>'hs_notes',
      (p_site_profile->>'active')::boolean);
  END IF;
  IF p_zone_id IS NOT NULL THEN
    SELECT * INTO v_zone FROM public.location_zones
      WHERE id = p_zone_id AND location_id = v_house.id AND NOT is_verification_point FOR UPDATE;
    IF NOT FOUND OR p_zone_version IS NULL OR v_zone.configuration_version IS DISTINCT FROM p_zone_version THEN
      RAISE EXCEPTION 'Area changed or is not available. Reload the profile before saving';
    END IF;
    UPDATE public.location_zones SET name = trim(p_name), configuration_version = configuration_version + 1
      WHERE id = p_zone_id;
  END IF;
  UPDATE public.locations SET name = trim(p_name), notes = nullif(trim(p_notes), ''), updated_at = clock_timestamp()
    , address = CASE WHEN p_resolved_address IS NULL THEN address ELSE trim(p_resolved_address->>'label') END
    WHERE id = p_location_id RETURNING * INTO v_house;
  IF p_site_id IS NOT NULL THEN UPDATE public.client_sites SET name = trim(p_name), address = v_house.address WHERE id = p_site_id; END IF;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_provider_id, auth.uid(), 'service_location_profile_saved', 'locations', v_house.id,
      jsonb_build_object('client_id', v_house.organization_id, 'previous_version', p_expected_updated_at, 'resolved_address', p_resolved_address));
  RETURN jsonb_build_object('location_id', v_house.id, 'updated_at', v_house.updated_at);
END;
$function$;
REVOKE ALL ON FUNCTION public.save_service_location_profile(uuid, uuid, timestamptz, text, text, uuid, integer, jsonb, jsonb, uuid, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_service_location_profile(uuid, uuid, timestamptz, text, text, uuid, integer, jsonb, jsonb, uuid, integer) TO authenticated;

CREATE OR REPLACE FUNCTION public.crm_actor_can_manage_location(p_location_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.locations l
    JOIN public.user_profiles actor ON actor.id = auth.uid() AND actor.deactivated_at IS NULL
    WHERE l.id = p_location_id AND public.is_admin_for_org(actor.organization_id)
      AND (
        l.organization_id = actor.organization_id
        OR l.organization_id = ANY(public.get_descendant_organizations(coalesce(actor.employer_organization_id, actor.organization_id)))
        OR EXISTS (
          SELECT 1 FROM public.service_agreements agreement
          JOIN public.service_agreement_locations coverage ON coverage.service_agreement_id = agreement.id AND coverage.status = 'active'
          LEFT JOIN public.client_sites site ON site.id = coverage.site_id
          LEFT JOIN public.location_zones zone ON zone.id = coverage.zone_id
          WHERE ((agreement.provider_organization_id = actor.organization_id AND agreement.invitation_status = 'accepted')
            OR (public.is_admin_for_org(agreement.provider_organization_id)
              AND agreement.client_organization_id = l.organization_id
              AND (agreement.invitation_status = 'accepted' OR agreement.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL)
              AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
              AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)))
            AND agreement.agreement_type = 'operational'
            AND (site.location_id = l.id OR zone.location_id = l.id)
        )
      )
  );
$function$;
REVOKE ALL ON FUNCTION public.crm_actor_can_manage_location(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.crm_actor_can_manage_location(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_crm_operational_geography()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_reach uuid[];
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required';
  END IF;
  v_reach := array(
    SELECT DISTINCT descendant
    FROM unnest(public.get_descendant_organizations(v_provider) || v_provider) descendant
  );
  RETURN jsonb_build_object(
    'locations', (
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.name), '[]'::jsonb)
      FROM (
        SELECT DISTINCT location.id, location.organization_id, location.canonical_place_id,
          location.name, location.address, location.suburb, location.postcode, location.notes
        FROM public.locations location
        WHERE location.organization_id = ANY(v_reach)
          OR EXISTS (
            SELECT 1 FROM public.service_agreements agreement
            JOIN public.service_agreement_locations link ON link.service_agreement_id = agreement.id AND link.status = 'active'
            LEFT JOIN public.client_sites site ON site.id = link.site_id
            LEFT JOIN public.location_zones zone ON zone.id = link.zone_id
            WHERE agreement.provider_organization_id = ANY(v_reach)
              AND (agreement.invitation_status = 'accepted' OR (
                agreement.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL
                AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
                AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)))
              AND agreement.agreement_type = 'operational'
              AND (site.location_id = location.id OR zone.location_id = location.id)
          )
      ) item
    ),
    'sites', (
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.name), '[]'::jsonb)
      FROM (
        SELECT DISTINCT site.id, site.client_organization_id, site.location_id, site.name,
          site.address, site.site_type, site.active, site.gps_lat, site.gps_lng,
          st_asgeojson(site.boundary)::jsonb AS boundary, site.boundary_status,
          site.boundary_verification, site.configuration_version
        FROM public.client_sites site
        WHERE site.client_organization_id = ANY(v_reach)
          OR EXISTS (
            SELECT 1 FROM public.service_agreements agreement
            JOIN public.service_agreement_locations link ON link.service_agreement_id = agreement.id AND link.status = 'active'
            WHERE agreement.provider_organization_id = ANY(v_reach)
              AND (agreement.invitation_status = 'accepted' OR (
                agreement.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL
                AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
                AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)))
              AND agreement.agreement_type = 'operational' AND link.site_id = site.id
          )
      ) item
    ),
    'zones', (
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.name), '[]'::jsonb)
      FROM (
        SELECT DISTINCT zone.id, zone.organization_id, zone.location_id, zone.name,
          location.address, zone.zone_type, zone.module_key, zone.rule_type, zone.is_active,
          zone.active_schedule, zone.onsite_profile, zone.enforcement_workflow_override,
          st_asgeojson(zone.boundary)::jsonb AS boundary, st_asgeojson(zone.center_point)::jsonb AS center_point,
          zone.boundary_status, zone.boundary_verification, zone.bylaw_clause, zone.bylaw_source_url,
          zone.nightly_limit_consecutive, zone.nightly_limit_monthly, zone.scv_required,
          zone.parking_time_limit_minutes, zone.parking_disabled_multiplier, zone.parking_signage_photo_url,
          zone.parking_limit_source, zone.parking_limit_set_at, zone.configuration_version
        FROM public.location_zones zone LEFT JOIN public.locations location ON location.id = zone.location_id
        WHERE NOT zone.is_verification_point AND (zone.organization_id = ANY(v_reach)
          OR EXISTS (
            SELECT 1 FROM public.service_agreements agreement
            JOIN public.service_agreement_locations link ON link.service_agreement_id = agreement.id AND link.status = 'active'
            WHERE agreement.provider_organization_id = ANY(v_reach)
              AND (agreement.invitation_status = 'accepted' OR (
                agreement.external_refs->'engagement_confirmation'->>'confirmed_by' IS NOT NULL
                AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
                AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)))
              AND agreement.agreement_type = 'operational' AND link.zone_id = zone.id
          ))
      ) item
    )
  );
END;
$function$;
COMMENT ON FUNCTION public.get_crm_operational_geography() IS
  'CRM-admin scoped geography for owned and accepted or provider-attested operational places; reference markers are not work areas.';
REVOKE ALL ON FUNCTION public.get_crm_operational_geography() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_crm_operational_geography() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_crm_operational_place_editor(p_location_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
declare v_actor uuid:=auth.uid();v_provider uuid;v_location public.locations%rowtype;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_location(p_location_id) then raise exception 'Active CRM administrator required for this location';end if;
  select * into v_location from public.locations l where l.id=p_location_id;if not found then raise exception 'Location not found';end if;
  return jsonb_build_object(
    'location',jsonb_build_object('id',v_location.id,'name',v_location.name,'organization_id',v_location.organization_id),
    'sites',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'risk_level',s.risk_level,'site_brief',s.site_brief,'access_instructions',s.access_instructions,'hs_notes',s.hs_notes,'active',s.active,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'configuration_version',s.configuration_version) order by s.name),'[]'::jsonb) from public.client_sites s where s.location_id=v_location.id),
    'zones',(select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'zone_type',z.zone_type,'module_key',z.module_key,'rule_type',z.rule_type,'is_active',z.is_active,'nightly_limit_consecutive',z.nightly_limit_consecutive,'nightly_limit_monthly',z.nightly_limit_monthly,'scv_required',z.scv_required,'enforcement_workflow_override',z.enforcement_workflow_override,'boundary_status',z.boundary_status,'boundary_verification',z.boundary_verification,'configuration_version',z.configuration_version) order by z.name),'[]'::jsonb) from public.location_zones z where z.location_id=v_location.id AND NOT z.is_verification_point),
    'modules',(select coalesce(jsonb_agg(jsonb_build_object('module_key',m.module_key,'display_name',initcap(replace(m.module_key,'_',' '))) order by m.module_key),'[]'::jsonb) from public.module_catalog m where m.active),
    'closures',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'zone_id',c.zone_id,'closure_type',c.closure_type,'status',c.status,'effective_from',c.effective_from,'effective_to',c.effective_to,'reason',c.reason,'resolution_notes',c.resolution_notes) order by c.created_at desc),'[]'::jsonb) from public.zone_closures c join public.location_zones z on z.id=c.zone_id where z.location_id=v_location.id AND NOT z.is_verification_point)
  );
end;
$function$;
REVOKE ALL ON FUNCTION public.get_crm_operational_place_editor(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_crm_operational_place_editor(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_active_rules(
  p_organization_id uuid, p_module_key text, p_lat double precision DEFAULT NULL,
  p_lng double precision DEFAULT NULL, p_zone_id uuid DEFAULT NULL, p_site_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL, p_at timestamptz DEFAULT now()
)
RETURNS TABLE(organization_id uuid, module_key text, enabled boolean, dominant_anchor_kind text, active_zone_id uuid, active_site_id uuid, active_location_id uuid, governing_jurisdiction_id uuid, governing_jurisdiction_name text, module_rule_set_id uuid, module_rule_set_name text, evidence_requirements jsonb, approval_policy jsonb, report_template_code text, jurisdiction_rule_set_id uuid, jurisdiction_rule_set_name text, jurisdiction_name text, jurisdiction_rules jsonb, resolution_status text, effective_rules jsonb, policy_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $function$
DECLARE
  v_zone_id uuid := p_zone_id;
  v_site_id uuid := p_site_id;
  v_location_id uuid := p_location_id;
  v_rule jsonb := '{}'::jsonb;
  v_jur_id uuid := NULL;
  v_jur_name text := NULL;
  v_module_rule_set_id uuid := NULL;
  v_module_rule_set_name text := NULL;
  v_module_evidence_requirements jsonb := '{}'::jsonb;
  v_module_approval_policy jsonb := '{}'::jsonb;
  v_module_report_template_code text := NULL;
  v_jurisdiction_rule_set_id uuid := NULL;
  v_jurisdiction_rule_set_name text := NULL;
  v_jurisdiction_name text := NULL;
  v_jurisdiction_rules jsonb := '{}'::jsonb;
  v_resolution text := 'outside_all_geofences';
  v_enabled boolean := false;
  v_anchor text := 'unresolved';
BEGIN
  IF p_organization_id IS NULL OR NULLIF(trim(COALESCE(p_module_key, '')), '') IS NULL THEN RETURN; END IF;
  SELECT om.enabled INTO v_enabled FROM public.organization_modules om
    WHERE om.organization_id = p_organization_id AND om.module_key = p_module_key LIMIT 1;
  IF v_enabled IS NULL THEN v_enabled := false; END IF;

  IF p_zone_id IS NOT NULL THEN
    SELECT z.id,
           (SELECT cs.id FROM public.client_sites cs WHERE cs.location_id = z.location_id AND cs.active ORDER BY cs.created_at LIMIT 1),
           z.location_id, z.jurisdiction_rule_set_id,
           COALESCE(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, COALESCE(jrs.rules, '{}'::jsonb),
           COALESCE(z.module_key, p_module_key),
           CASE WHEN z.boundary IS NOT NULL THEN 'zone' ELSE 'unresolved' END
      INTO v_zone_id, v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules, p_module_key, v_anchor
    FROM public.location_zones z
    LEFT JOIN public.jurisdiction_rule_sets jrs ON jrs.id = z.jurisdiction_rule_set_id
    WHERE z.id = p_zone_id AND NOT z.is_verification_point LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected zone is not an operational work area'; END IF;
    v_resolution := 'resolved';
  ELSIF p_site_id IS NOT NULL THEN
    SELECT cs.id, cs.location_id, COALESCE(z.jurisdiction_rule_set_id, NULL),
           COALESCE(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, COALESCE(jrs.rules, '{}'::jsonb), 'site'
      INTO v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules, v_anchor
    FROM public.client_sites cs
    LEFT JOIN public.location_zones z ON z.location_id = cs.location_id AND z.module_key = p_module_key AND NOT z.is_verification_point
    LEFT JOIN public.jurisdiction_rule_sets jrs ON jrs.id = z.jurisdiction_rule_set_id
    WHERE cs.id = p_site_id ORDER BY z.created_at LIMIT 1;
    v_resolution := 'resolved';
  ELSIF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    SELECT rc.matched_zone_id, rc.site_id, rc.client_org_id, rc.governing_jurisdiction_id,
           rc.governing_jurisdiction_name, rc.effective_rules, rc.resolution_status
      INTO v_zone_id, v_site_id, v_location_id, v_jur_id, v_jur_name, v_rule, v_resolution
    FROM public.resolve_context(p_lat, p_lng, p_organization_id, p_module_key, p_at) rc LIMIT 1;
    IF v_zone_id IS NOT NULL THEN
      SELECT z.location_id INTO v_location_id FROM public.location_zones z WHERE z.id = v_zone_id AND NOT z.is_verification_point LIMIT 1;
    END IF;
    v_anchor := CASE WHEN v_zone_id IS NOT NULL THEN 'zone' WHEN v_site_id IS NOT NULL THEN 'site' ELSE 'unresolved' END;
  END IF;

  SELECT mrs.id, mrs.name, mrs.evidence_requirements, mrs.approval_policy, mrs.report_template_code
    INTO v_module_rule_set_id, v_module_rule_set_name, v_module_evidence_requirements, v_module_approval_policy, v_module_report_template_code
  FROM public.module_rule_sets mrs
  WHERE mrs.organization_id = p_organization_id AND mrs.module_key = p_module_key
  ORDER BY mrs.created_at DESC LIMIT 1;
  IF v_jurisdiction_rule_set_id IS NULL AND p_organization_id IS NOT NULL AND p_module_key IS NOT NULL THEN
    SELECT jrs.id, jrs.name, jrs.jurisdiction_name, jrs.rules
      INTO v_jurisdiction_rule_set_id, v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules
    FROM public.jurisdiction_rule_sets jrs
    WHERE jrs.organization_id = p_organization_id AND jrs.module_key = p_module_key
    ORDER BY jrs.created_at DESC LIMIT 1;
  END IF;
  IF v_rule = '{}'::jsonb THEN v_rule := COALESCE(v_jurisdiction_rules, '{}'::jsonb); END IF;
  RETURN QUERY SELECT p_organization_id, p_module_key, v_enabled, v_anchor, v_zone_id,
    v_site_id, v_location_id, v_jur_id, v_jur_name, v_module_rule_set_id,
    v_module_rule_set_name, v_module_evidence_requirements, v_module_approval_policy,
    v_module_report_template_code, v_jurisdiction_rule_set_id, v_jurisdiction_rule_set_name,
    v_jurisdiction_name, v_jurisdiction_rules, v_resolution, v_rule,
    CASE WHEN v_enabled = false THEN 'disabled'
      WHEN v_resolution IN ('unresolved_no_geofence','unresolved_invalid','unresolved_unverified','outside_all_geofences') THEN 'needs_resolution'
      WHEN v_module_rule_set_id IS NULL THEN 'missing_module_rule_set'
      WHEN v_jurisdiction_rule_set_id IS NULL THEN 'missing_jurisdiction_rule_set'
      ELSE 'effective_rules_ready' END;
END;
$function$;
REVOKE ALL ON FUNCTION public.resolve_active_rules(uuid, text, double precision, double precision, uuid, uuid, uuid, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_active_rules(uuid, text, double precision, double precision, uuid, uuid, uuid, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION "public"."resolve_context"(p_lat double precision, p_lng double precision, p_org_id uuid, p_module_key text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(in_operating_bounds boolean, out_of_bounds_district text, governing_jurisdiction_id uuid, governing_jurisdiction_name text, on_site boolean, site_id uuid, client_org_id uuid, matched_zone_id uuid, matched_module_key text, effective_rules jsonb, resolution_status text, governor_overlap_flag boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_point        geometry := st_setsrid(st_point(p_lng, p_lat), 4326);
  v_in_bounds    boolean := false;
  v_oob_district text := null;
  v_jur_id       uuid := null;
  v_jur_name     text := null;
  v_zone         record;
  v_on_site      boolean := false;
  v_site_id      uuid := null;
  v_client_org   uuid := null;
  v_rules        jsonb := '{}'::jsonb;
  v_resolution   text := 'outside_all_geofences';
  v_gov_overlap  boolean := false;
  v_org_jur_verification text;
  v_org_jur_geom_exists  boolean;
  v_org_jur_geom_valid   boolean;
  v_governor_count integer := 0;
BEGIN
  -- Layer 1: operating bounds (P1/P2: no-geofence / unverified / invalid / outside / inside are distinct).
  SELECT
    o.jurisdiction_geom IS NOT NULL,
    CASE WHEN o.jurisdiction_geom IS NOT NULL
         THEN ST_IsValid(o.jurisdiction_geom) AND NOT ST_IsEmpty(o.jurisdiction_geom)
         ELSE false END,
    o.jurisdiction_verification,
    CASE WHEN o.jurisdiction_geom IS NOT NULL
              AND ST_IsValid(o.jurisdiction_geom)
              AND NOT ST_IsEmpty(o.jurisdiction_geom)
              AND o.jurisdiction_verification = 'verified'
         THEN st_contains(o.jurisdiction_geom, v_point)
         ELSE false END
    INTO v_org_jur_geom_exists, v_org_jur_geom_valid,
         v_org_jur_verification, v_in_bounds
  FROM public.organizations o
  WHERE o.id = p_org_id;

  IF NOT COALESCE(v_org_jur_geom_exists, false) THEN
    v_resolution := 'unresolved_no_geofence';
  ELSIF NOT COALESCE(v_org_jur_geom_valid, false) THEN
    v_resolution := 'unresolved_invalid';
  ELSIF COALESCE(v_org_jur_verification, 'unverified') <> 'verified' THEN
    v_resolution := 'unresolved_unverified';
  ELSE
    v_resolution := 'outside_all_geofences';
  END IF;

  v_in_bounds := COALESCE(v_in_bounds, false);

  IF NOT v_in_bounds THEN
    SELECT o.name INTO v_oob_district
    FROM public.organizations o
    WHERE o.jurisdiction_geom IS NOT NULL
      AND st_contains(o.jurisdiction_geom, v_point)
    ORDER BY st_area(o.jurisdiction_geom) ASC
    LIMIT 1;
  END IF;

  -- Layer 2: governing council jurisdiction (role-aware; unchanged).
  SELECT count(*)
    INTO v_governor_count
  FROM public.organizations o
  WHERE o.jurisdiction_geom IS NOT NULL
    AND o.id <> p_org_id
    AND o.jurisdiction_verification = 'verified'
    AND ST_IsValid(o.jurisdiction_geom)
    AND NOT ST_IsEmpty(o.jurisdiction_geom)
    AND st_contains(o.jurisdiction_geom, v_point)
    AND (
      EXISTS (
        SELECT 1 FROM public.org_engagements e
        WHERE e.status = 'active'
          AND ((e.from_org_id = p_org_id AND e.to_org_id = o.id)
            OR (e.to_org_id = p_org_id AND e.from_org_id = o.id))
      )
      OR o.parent_organization_id = p_org_id
      OR o.id = (SELECT parent_organization_id FROM public.organizations WHERE id = p_org_id)
    )
    AND (
      o.organization_type IN ('government', 'service_provider', 'branch')
      OR EXISTS (
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = o.id
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      )
      OR EXISTS (
        SELECT 1 FROM public.organizations child
        WHERE child.parent_organization_id = o.id
      )
      OR EXISTS (
        SELECT 1 FROM public.org_engagements e2
        WHERE e2.to_org_id = o.id
          AND e2.status = 'active'
      )
    );

  IF v_governor_count > 1 THEN
    v_gov_overlap := true;
  END IF;

  SELECT o.id, o.name
    INTO v_jur_id, v_jur_name
  FROM public.organizations o
  WHERE o.jurisdiction_geom IS NOT NULL
    AND o.id <> p_org_id
    AND o.jurisdiction_verification = 'verified'
    AND ST_IsValid(o.jurisdiction_geom)
    AND NOT ST_IsEmpty(o.jurisdiction_geom)
    AND st_contains(o.jurisdiction_geom, v_point)
    AND (
      EXISTS (
        SELECT 1 FROM public.org_engagements e
        WHERE e.status = 'active'
          AND ((e.from_org_id = p_org_id AND e.to_org_id = o.id)
            OR (e.to_org_id = p_org_id AND e.from_org_id = o.id))
      )
      OR o.parent_organization_id = p_org_id
      OR o.id = (SELECT parent_organization_id FROM public.organizations WHERE id = p_org_id)
    )
    AND (
      o.organization_type IN ('government', 'service_provider', 'branch')
      OR EXISTS (
        SELECT 1 FROM public.service_agreements sa
        WHERE sa.provider_organization_id = o.id
          AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      )
      OR EXISTS (
        SELECT 1 FROM public.organizations child
        WHERE child.parent_organization_id = o.id
      )
      OR EXISTS (
        SELECT 1 FROM public.org_engagements e2
        WHERE e2.to_org_id = o.id
          AND e2.status = 'active'
      )
    )
  ORDER BY st_area(o.jurisdiction_geom) ASC
  LIMIT 1;

  -- Layer 3: verified zone geofence. Matching is unchanged; the site and owner now come from the house.
  SELECT z.id, z.location_id, z.module_key, z.onsite_profile, z.boundary,
         z.jurisdiction_rule_set_id, z.rule_overrides,
         z.repeat_stay_radius_m, z.repeat_stay_window_nights,
         z.nightly_limit_consecutive, z.nightly_limit_monthly, z.scv_required
    INTO v_zone
  FROM public.location_zones z
  WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
    AND z.boundary IS NOT NULL
    AND z.boundary_verification = 'verified'
    AND ST_IsValid(z.boundary)
    AND NOT ST_IsEmpty(z.boundary)
    AND st_contains(z.boundary, v_point)
    AND (p_module_key IS NULL OR z.module_key = p_module_key)
    AND public._geofence_active_at(z.active_schedule, p_at)
  ORDER BY st_area(z.boundary) ASC
  LIMIT 1;

  IF v_zone.id IS NOT NULL THEN
    v_resolution := 'resolved';

    -- The owner is the house (locations.organization_id); the zone's own org is the fallback.
    SELECT loc.organization_id INTO v_client_org FROM public.locations loc WHERE loc.id = v_zone.location_id;
    v_client_org := COALESCE(v_client_org, p_org_id);

    -- The site facet on the same house, preferring one whose geometry holds the point.
    SELECT cs.id,
           CASE
             WHEN v_zone.onsite_profile = 'approach_10m'
               THEN st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography, v_point::geography, 10)
             ELSE
               (cs.boundary IS NOT NULL AND st_contains(cs.boundary, v_point))
               OR st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography,
                             v_point::geography,
                             COALESCE(cs.onsite_radius_meters, 10))
           END
      INTO v_site_id, v_on_site
    FROM public.client_sites cs
    WHERE cs.location_id = v_zone.location_id
      AND cs.active
    ORDER BY (cs.boundary IS NOT NULL AND st_contains(cs.boundary, v_point)) DESC,
             st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography, v_point::geography, COALESCE(cs.onsite_radius_meters, 10)) DESC,
             cs.created_at
    LIMIT 1;
    v_on_site := COALESCE(v_on_site, false);

    SELECT COALESCE(jrs.rules, '{}'::jsonb)
      INTO v_rules
    FROM public.jurisdiction_rule_sets jrs
    WHERE jrs.id = v_zone.jurisdiction_rule_set_id;

    v_rules := COALESCE(v_rules, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
           'repeat_stay_radius_m',      v_zone.repeat_stay_radius_m,
           'repeat_stay_window_nights', v_zone.repeat_stay_window_nights,
           'nightly_limit_consecutive', v_zone.nightly_limit_consecutive,
           'nightly_limit_monthly',     v_zone.nightly_limit_monthly,
           'scv_required',              v_zone.scv_required
         ))
      || COALESCE(v_zone.rule_overrides, '{}'::jsonb);
  ELSE
    IF v_resolution NOT IN ('unresolved_no_geofence', 'unresolved_invalid', 'unresolved_unverified') THEN
      IF EXISTS (
        SELECT 1 FROM public.location_zones z
        WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
          AND z.boundary IS NOT NULL
          AND z.boundary_verification = 'unverified'
          AND ST_IsValid(z.boundary)
          AND NOT ST_IsEmpty(z.boundary)
          AND st_contains(z.boundary, v_point)
          AND (p_module_key IS NULL OR z.module_key = p_module_key)
          AND public._geofence_active_at(z.active_schedule, p_at)
      ) THEN
        v_resolution := 'unresolved_unverified';
      ELSIF EXISTS (
        SELECT 1 FROM public.location_zones z
        WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
          AND z.boundary IS NOT NULL
          AND (NOT ST_IsValid(z.boundary) OR ST_IsEmpty(z.boundary))
          AND st_contains(z.boundary, v_point)
          AND (p_module_key IS NULL OR z.module_key = p_module_key)
          AND public._geofence_active_at(z.active_schedule, p_at)
      ) THEN
        v_resolution := 'unresolved_invalid';
      ELSE
        IF NOT EXISTS (
          SELECT 1 FROM public.location_zones z
          WHERE z.organization_id = p_org_id AND NOT z.is_verification_point
            AND z.boundary IS NOT NULL
            AND (p_module_key IS NULL OR z.module_key = p_module_key)
        ) THEN
          v_resolution := 'unresolved_no_geofence';
        END IF;
      END IF;
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_in_bounds, v_oob_district, v_jur_id, v_jur_name,
    v_on_site, v_site_id, v_client_org,
    v_zone.id, v_zone.module_key, v_rules,
    v_resolution,
    v_gov_overlap;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."resolve_operational_context"(p_lat double precision, p_lng double precision, p_org_id uuid, p_module_key text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(in_operating_bounds boolean, out_of_bounds_district text, governing_jurisdiction_id uuid, governing_jurisdiction_name text, on_site boolean, site_id uuid, client_org_id uuid, matched_zone_id uuid, matched_module_key text, effective_rules jsonb, resolution_status text, governor_overlap_flag boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_point geometry := ST_SetSRID(ST_Point(p_lng, p_lat), 4326);
  v_direct record;
  v_contracted record;
  v_site record;
  v_blocked_status text;
BEGIN
  SELECT * INTO v_direct FROM public.resolve_context(p_lat, p_lng, p_org_id, p_module_key, p_at);
  IF v_direct.matched_zone_id IS NOT NULL OR v_direct.site_id IS NOT NULL THEN
    RETURN QUERY SELECT v_direct.in_operating_bounds, v_direct.out_of_bounds_district,
      v_direct.governing_jurisdiction_id, v_direct.governing_jurisdiction_name,
      v_direct.on_site, v_direct.site_id, v_direct.client_org_id,
      v_direct.matched_zone_id, v_direct.matched_module_key, v_direct.effective_rules,
      v_direct.resolution_status, v_direct.governor_overlap_flag;
    RETURN;
  END IF;

  SELECT rc.* INTO v_contracted
  FROM public.service_agreements sa
  JOIN public.service_agreement_modules sam
    ON sam.service_agreement_id = sa.id AND sam.enabled
   AND (p_module_key IS NULL OR sam.module_key = p_module_key)
  JOIN public.service_agreement_locations sal
    ON sal.service_agreement_id = sa.id AND sal.status = 'active'
  CROSS JOIN LATERAL public.resolve_context(p_lat, p_lng, sa.client_organization_id, p_module_key, p_at) rc
  WHERE sa.provider_organization_id = p_org_id
    AND sa.invitation_status = 'accepted'
    AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date)
    AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
    AND rc.resolution_status = 'resolved'
    AND ((sal.zone_id IS NOT NULL AND sal.zone_id = rc.matched_zone_id)
      OR (sal.site_id IS NOT NULL AND sal.site_id = rc.site_id))
  ORDER BY CASE WHEN sal.zone_id = rc.matched_zone_id THEN 0 ELSE 1 END
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT true, NULL::text, v_contracted.governing_jurisdiction_id,
      v_contracted.governing_jurisdiction_name, v_contracted.on_site,
      v_contracted.site_id, v_contracted.client_org_id, v_contracted.matched_zone_id,
      v_contracted.matched_module_key, v_contracted.effective_rules,
      v_contracted.resolution_status, v_contracted.governor_overlap_flag;
    RETURN;
  END IF;

  SELECT cs.id AS site_id, COALESCE(l.organization_id, cs.client_organization_id) AS client_org_id
    INTO v_site
  FROM public.service_agreements sa
  JOIN public.service_agreement_modules sam
    ON sam.service_agreement_id = sa.id AND sam.enabled
   AND (p_module_key IS NULL OR sam.module_key = p_module_key)
  JOIN public.service_agreement_locations sal
    ON sal.service_agreement_id = sa.id AND sal.status = 'active' AND sal.site_id IS NOT NULL
  JOIN public.client_sites cs ON cs.id = sal.site_id AND cs.active
  LEFT JOIN public.locations l ON l.id = cs.location_id
  WHERE sa.provider_organization_id = p_org_id
    AND sa.invitation_status = 'accepted'
    AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date)
    AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
    AND cs.boundary IS NOT NULL AND cs.boundary_verification = 'verified'
    AND ST_IsValid(cs.boundary) AND NOT ST_IsEmpty(cs.boundary) AND ST_Contains(cs.boundary, v_point)
  ORDER BY ST_Area(cs.boundary) ASC
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT true, NULL::text, v_direct.governing_jurisdiction_id,
      v_direct.governing_jurisdiction_name, true, v_site.site_id,
      v_site.client_org_id, NULL::uuid, p_module_key, '{}'::jsonb,
      'resolved'::text, v_direct.governor_overlap_flag;
    RETURN;
  END IF;

  SELECT candidate.status INTO v_blocked_status
  FROM (
    SELECT 'unresolved_unverified'::text AS status, 0 AS priority, ST_Area(z.boundary) AS area
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.location_zones z ON z.id = sal.zone_id AND z.is_active AND NOT z.is_verification_point
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND z.boundary IS NOT NULL AND COALESCE(z.boundary_verification, 'unverified') <> 'verified'
      AND ST_IsValid(z.boundary) AND NOT ST_IsEmpty(z.boundary) AND ST_Contains(z.boundary, v_point)
      AND (p_module_key IS NULL OR z.module_key = p_module_key) AND public._geofence_active_at(z.active_schedule, p_at)
    UNION ALL
    SELECT 'unresolved_unverified'::text, 1, ST_Area(cs.boundary)
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.client_sites cs ON cs.id = sal.site_id AND cs.active
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND cs.boundary IS NOT NULL AND COALESCE(cs.boundary_verification, 'unverified') <> 'verified'
      AND ST_IsValid(cs.boundary) AND NOT ST_IsEmpty(cs.boundary) AND ST_Contains(cs.boundary, v_point)
    UNION ALL
    SELECT 'unresolved_invalid'::text, 2, 0::double precision
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.location_zones z ON z.id = sal.zone_id AND z.is_active AND NOT z.is_verification_point
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND z.boundary IS NOT NULL AND (NOT ST_IsValid(z.boundary) OR ST_IsEmpty(z.boundary))
      AND z.boundary && v_point AND (p_module_key IS NULL OR z.module_key = p_module_key)
    UNION ALL
    SELECT 'unresolved_invalid'::text, 3, 0::double precision
    FROM public.service_agreements sa
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id = sa.id AND sam.enabled
      AND (p_module_key IS NULL OR sam.module_key = p_module_key)
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id = sa.id AND sal.status = 'active'
    JOIN public.client_sites cs ON cs.id = sal.site_id AND cs.active
    WHERE sa.provider_organization_id = p_org_id AND sa.invitation_status = 'accepted'
      AND (sa.starts_on IS NULL OR sa.starts_on <= p_at::date) AND (sa.ends_on IS NULL OR sa.ends_on >= p_at::date)
      AND cs.boundary IS NOT NULL AND (NOT ST_IsValid(cs.boundary) OR ST_IsEmpty(cs.boundary)) AND cs.boundary && v_point
  ) candidate
  ORDER BY candidate.priority, candidate.area
  LIMIT 1;

  IF v_blocked_status IS NOT NULL THEN
    RETURN QUERY SELECT v_direct.in_operating_bounds, v_direct.out_of_bounds_district,
      v_direct.governing_jurisdiction_id, v_direct.governing_jurisdiction_name,
      false, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, '{}'::jsonb,
      v_blocked_status, v_direct.governor_overlap_flag;
    RETURN;
  END IF;

  RETURN QUERY SELECT v_direct.in_operating_bounds, v_direct.out_of_bounds_district,
    v_direct.governing_jurisdiction_id, v_direct.governing_jurisdiction_name,
    v_direct.on_site, v_direct.site_id, v_direct.client_org_id,
    v_direct.matched_zone_id, v_direct.matched_module_key, v_direct.effective_rules,
    v_direct.resolution_status, v_direct.governor_overlap_flag;
END;
$function$;

CREATE OR REPLACE FUNCTION "public"."tg_location_zones_place_house"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_house_org uuid;
BEGIN
  IF NEW.location_id IS NULL AND NEW.organization_id IS NOT NULL THEN
    IF NEW.name IS NOT NULL THEN
      SELECT id INTO NEW.location_id FROM public.locations
       WHERE organization_id = NEW.organization_id AND lower(name) = lower(NEW.name) ORDER BY created_at LIMIT 1;
    END IF;
    IF NEW.location_id IS NULL THEN
      INSERT INTO public.locations (organization_id, name, created_by)
      VALUES (NEW.organization_id, coalesce(nullif(trim(NEW.name), ''), 'Unnamed zone'), (SELECT up.id FROM public.user_profiles up WHERE up.id = auth.uid()))
      RETURNING id INTO NEW.location_id;
    END IF;
  END IF;
  IF NEW.location_id IS NOT NULL THEN
    SELECT organization_id INTO v_house_org FROM public.locations WHERE id = NEW.location_id;
    IF v_house_org IS NULL THEN
      RAISE EXCEPTION 'Location house % does not exist', NEW.location_id;
    END IF;
    IF NEW.organization_id IS NOT NULL AND v_house_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Zone % cannot hang off a house owned by another organisation', coalesce(NEW.name, NEW.id::text);
    END IF;
    UPDATE public.canonical_places cp SET
      center_point = coalesce(cp.center_point, NEW.center_point),
      boundary = coalesce(cp.boundary, CASE WHEN NEW.boundary IS NULL THEN NULL ELSE ST_Multi(NEW.boundary) END),
      updated_at = now()
    FROM public.locations l
    WHERE l.id = NEW.location_id AND cp.id = l.canonical_place_id AND NOT NEW.is_verification_point
      AND ((cp.center_point IS NULL AND NEW.center_point IS NOT NULL) OR (cp.boundary IS NULL AND NEW.boundary IS NOT NULL));
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION "public"."crm_actor_can_manage_account"(p_account_organization_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(
    select 1
    from public.user_profiles actor
    join public.organizations account on account.id=p_account_organization_id
    where actor.id=auth.uid()
      and actor.deactivated_at is null
      and (
        account.id=actor.organization_id
        or account.parent_organization_id=actor.organization_id
        or account.parent_organization_id = any(public.get_descendant_organizations(coalesce(actor.employer_organization_id,actor.organization_id)))
        or exists(
          select 1
          from public.service_agreements agreement
          where agreement.provider_organization_id = any(public.get_descendant_organizations(coalesce(actor.employer_organization_id,actor.organization_id)))
            and agreement.client_organization_id=account.id
            and agreement.agreement_type='operational'
            and (agreement.invitation_status='accepted' or (
              agreement.external_refs->'engagement_confirmation'->>'confirmed_by' is not null
              and (agreement.starts_on is null or agreement.starts_on<=current_date)
              and (agreement.ends_on is null or agreement.ends_on>=current_date)
            ))
            and public.is_admin_for_org(agreement.provider_organization_id)
        )
      )
  );
$function$;

CREATE OR REPLACE FUNCTION "public"."autolink_client_site_service_agreement"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- A captured draft does not approve financial defaults or an inferred provider relationship.
  if new.metadata->>'created_via' in ('service_client_setup', 'officer_field_capture')
    or new.metadata->'field_place_managed' = 'true'::jsonb then return new; end if;
  if new.service_agreement_id is null and new.client_organization_id is not null then
    select sa.id
      into new.service_agreement_id
    from public.service_agreements sa
    where sa.client_organization_id = new.client_organization_id
      and (sa.ends_on is null or sa.ends_on >= current_date)
    order by sa.starts_on desc nulls last, sa.created_at desc, sa.id desc
    limit 1;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION "public"."ensure_site_financial_config_from_site"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- A captured draft does not approve financial defaults or an inferred provider relationship.
  if new.metadata->>'created_via' in ('service_client_setup', 'officer_field_capture')
    or new.metadata->'field_place_managed' = 'true'::jsonb then return new; end if;
  if new.service_agreement_id is null then
    return new;
  end if;

  insert into public.site_financial_config (
    organization_id,
    site_id,
    service_agreement_id,
    billing_model,
    billing_cycle,
    gst_registered,
    gst_rate,
    payment_terms_days,
    minimum_hours,
    active
  )
  values (
    new.client_organization_id,
    new.id,
    new.service_agreement_id,
    'hourly',
    'monthly',
    true,
    0.15,
    14,
    2,
    true
  )
  on conflict (site_id, service_agreement_id) do nothing;

  return new;
end;
$function$;

COMMIT;