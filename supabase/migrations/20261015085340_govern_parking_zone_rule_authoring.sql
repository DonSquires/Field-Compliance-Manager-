CREATE UNIQUE INDEX IF NOT EXISTS audit_log_parking_rule_request_replay
ON public.audit_log (
  organization_id,
  actor_user_id,
  ((metadata ->> 'client_request_id'))
)
WHERE action = 'parking_zone_rule_updated'
  AND metadata ? 'client_request_id';

DROP FUNCTION IF EXISTS public.manage_parking_zone_rule(
  uuid,
  integer,
  integer,
  numeric,
  text,
  text
);

CREATE FUNCTION public.manage_parking_zone_rule(
  p_client_request_id uuid,
  p_zone_id uuid,
  p_expected_version integer,
  p_time_limit_minutes integer,
  p_disabled_multiplier numeric,
  p_limit_source text,
  p_signage_photo_path text DEFAULT NULL
)
RETURNS public.location_zones
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_zone public.location_zones%rowtype;
  v_before jsonb;
  v_signage_path text;
  v_replay_target uuid;
  v_replay_version integer;
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Parking rule request identity is required';
  END IF;

  SELECT organization_id
  INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor
    AND deactivated_at IS NULL;

  SELECT
    target_id,
    nullif(metadata ->> 'resulting_configuration_version', '')::integer
  INTO v_replay_target, v_replay_version
  FROM public.audit_log
  WHERE organization_id = v_provider
    AND actor_user_id = v_actor
    AND action = 'parking_zone_rule_updated'
    AND metadata ->> 'client_request_id' = p_client_request_id::text
  LIMIT 1;

  SELECT *
  INTO v_zone
  FROM public.location_zones
  WHERE id = p_zone_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_provider IS NULL
    OR NOT public.is_admin_for_org(v_provider)
    OR NOT public.crm_actor_can_manage_location(v_zone.location_id)
  THEN
    RAISE EXCEPTION 'Active administrator required for this Parking zone';
  END IF;

  IF v_zone.zone_type <> 'parking'
    OR v_zone.module_key <> 'parking_enforcement'
  THEN
    RAISE EXCEPTION 'Parking rules require a Parking enforcement zone';
  END IF;

  IF v_replay_target IS NOT NULL THEN
    IF v_replay_target <> v_zone.id THEN
      RAISE EXCEPTION 'Parking rule request identity was already used for another zone';
    END IF;
    IF v_replay_version IS DISTINCT FROM v_zone.configuration_version THEN
      RAISE EXCEPTION 'Parking rule request was already applied and has since been superseded';
    END IF;
    RETURN v_zone;
  END IF;

  IF v_zone.configuration_version <> p_expected_version THEN
    RAISE EXCEPTION 'Zone configuration changed since it was opened';
  END IF;
  IF p_time_limit_minutes IS NULL
    OR p_time_limit_minutes < 1
    OR p_time_limit_minutes > 1440
  THEN
    RAISE EXCEPTION 'Parking time limit must be between 1 and 1440 minutes';
  END IF;
  IF p_disabled_multiplier IS NULL
    OR p_disabled_multiplier < 1
    OR p_disabled_multiplier > 4
  THEN
    RAISE EXCEPTION 'Disabled-bay multiplier must be between 1 and 4';
  END IF;
  IF p_limit_source NOT IN ('manual', 'bob_signage', 'rfp_seed') THEN
    RAISE EXCEPTION 'Supported Parking rule provenance is required';
  END IF;

  v_signage_path := coalesce(
    nullif(btrim(p_signage_photo_path), ''),
    v_zone.parking_signage_photo_url
  );
  IF v_signage_path IS NULL THEN
    RAISE EXCEPTION 'Parking signage photo evidence is required';
  END IF;
  IF v_signage_path NOT LIKE
    'org/' || v_zone.organization_id::text || '/parking-signage/' || v_zone.id::text || '/%'
  THEN
    RAISE EXCEPTION 'Parking signage path is outside the governed zone';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM storage.objects object
    WHERE object.bucket_id = 'scans'
      AND object.name = v_signage_path
      AND coalesce(object.metadata ->> 'mimetype', '') IN (
        'image/jpeg',
        'image/png',
        'image/webp'
      )
  ) THEN
    RAISE EXCEPTION 'Parking signage image evidence was not found';
  END IF;

  v_before := jsonb_build_object(
    'configuration_version', v_zone.configuration_version,
    'time_limit_minutes', v_zone.parking_time_limit_minutes,
    'disabled_multiplier', v_zone.parking_disabled_multiplier,
    'limit_source', v_zone.parking_limit_source,
    'signage_photo_path', v_zone.parking_signage_photo_url
  );

  UPDATE public.location_zones
  SET parking_time_limit_minutes = p_time_limit_minutes,
      parking_disabled_multiplier = p_disabled_multiplier,
      parking_limit_source = p_limit_source,
      parking_signage_photo_url = v_signage_path,
      parking_limit_set_by = v_actor,
      parking_limit_set_at = clock_timestamp(),
      configuration_version = configuration_version + 1
  WHERE id = v_zone.id
  RETURNING * INTO v_zone;

  INSERT INTO public.audit_log(
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_provider,
    v_actor,
    'parking_zone_rule_updated',
    'location_zones',
    v_zone.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'zone_organization_id', v_zone.organization_id,
      'previous', v_before,
      'resulting', jsonb_build_object(
        'configuration_version', v_zone.configuration_version,
        'time_limit_minutes', v_zone.parking_time_limit_minutes,
        'disabled_multiplier', v_zone.parking_disabled_multiplier,
        'limit_source', v_zone.parking_limit_source,
        'signage_photo_path', v_zone.parking_signage_photo_url
      ),
      'resulting_configuration_version', v_zone.configuration_version
    )
  );

  RETURN v_zone;
END;
$function$;

REVOKE ALL ON FUNCTION public.manage_parking_zone_rule(
  uuid,
  uuid,
  integer,
  integer,
  numeric,
  text,
  text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_parking_zone_rule(
  uuid,
  uuid,
  integer,
  integer,
  numeric,
  text,
  text
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_crm_operational_geography()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_reach uuid[];
BEGIN
  SELECT organization_id
  INTO v_provider
  FROM public.user_profiles
  WHERE id = v_actor
    AND deactivated_at IS NULL;

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
        SELECT DISTINCT
          location.id,
          location.organization_id,
          location.canonical_place_id,
          location.name,
          location.address,
          location.suburb,
          location.postcode,
          location.notes
        FROM public.locations location
        WHERE location.organization_id = ANY(v_reach)
          OR EXISTS (
            SELECT 1
            FROM public.service_agreements agreement
            JOIN public.service_agreement_locations link
              ON link.service_agreement_id = agreement.id
             AND link.status = 'active'
            LEFT JOIN public.client_sites site ON site.id = link.site_id
            LEFT JOIN public.location_zones zone ON zone.id = link.zone_id
            WHERE agreement.provider_organization_id = ANY(v_reach)
              AND agreement.invitation_status = 'accepted'
              AND agreement.agreement_type = 'operational'
              AND (site.location_id = location.id OR zone.location_id = location.id)
          )
      ) item
    ),
    'sites', (
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.name), '[]'::jsonb)
      FROM (
        SELECT DISTINCT
          site.id,
          site.client_organization_id,
          site.location_id,
          site.name,
          site.address,
          site.site_type,
          site.active,
          site.gps_lat,
          site.gps_lng,
          st_asgeojson(site.boundary)::jsonb AS boundary,
          site.boundary_status,
          site.boundary_verification,
          site.configuration_version
        FROM public.client_sites site
        WHERE site.client_organization_id = ANY(v_reach)
          OR EXISTS (
            SELECT 1
            FROM public.service_agreements agreement
            JOIN public.service_agreement_locations link
              ON link.service_agreement_id = agreement.id
             AND link.status = 'active'
            WHERE agreement.provider_organization_id = ANY(v_reach)
              AND agreement.invitation_status = 'accepted'
              AND agreement.agreement_type = 'operational'
              AND link.site_id = site.id
          )
      ) item
    ),
    'zones', (
      SELECT coalesce(jsonb_agg(to_jsonb(item) ORDER BY item.name), '[]'::jsonb)
      FROM (
        SELECT DISTINCT
          zone.id,
          zone.organization_id,
          zone.location_id,
          zone.name,
          location.address,
          zone.zone_type,
          zone.module_key,
          zone.rule_type,
          zone.is_active,
          zone.active_schedule,
          zone.onsite_profile,
          zone.enforcement_workflow_override,
          st_asgeojson(zone.boundary)::jsonb AS boundary,
          st_asgeojson(zone.center_point)::jsonb AS center_point,
          zone.boundary_status,
          zone.boundary_verification,
          zone.bylaw_clause,
          zone.bylaw_source_url,
          zone.nightly_limit_consecutive,
          zone.nightly_limit_monthly,
          zone.scv_required,
          zone.parking_time_limit_minutes,
          zone.parking_disabled_multiplier,
          zone.parking_signage_photo_url,
          zone.parking_limit_source,
          zone.parking_limit_set_at,
          zone.configuration_version
        FROM public.location_zones zone
        LEFT JOIN public.locations location ON location.id = zone.location_id
        WHERE zone.organization_id = ANY(v_reach)
          OR EXISTS (
            SELECT 1
            FROM public.service_agreements agreement
            JOIN public.service_agreement_locations link
              ON link.service_agreement_id = agreement.id
             AND link.status = 'active'
            WHERE agreement.provider_organization_id = ANY(v_reach)
              AND agreement.invitation_status = 'accepted'
              AND agreement.agreement_type = 'operational'
              AND link.zone_id = zone.id
          )
      ) item
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.get_crm_operational_geography() IS
  'Returns provider-owned and accepted-agreement client locations, sites, and zones through one CRM-admin scoped read boundary, including source-backed Parking rule readiness.';