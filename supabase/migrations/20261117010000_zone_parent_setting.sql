-- Governed editor for location_zones.parent_zone_id ("Part of" another work area).
--
-- Canon: docs/canon/LOCATION_HOUSE_MODEL.md, ruling correction 2026-09-23. parent_zone_id is a same-organisation
-- grouping/attribution/reporting relation only. It does not feed resolve_context or geofence containment, and this
-- migration does not change either. Containment of a child inside its parent is advisory (GEOFENCE_PRINCIPLES.md:
-- "nesting is advisory proximity, not hard containment") and never blocks a save.

CREATE OR REPLACE FUNCTION public.location_zone_parent_containment(p_zone_id uuid, p_checkpoint_organization_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_child public.location_zones%rowtype;
  v_parent public.location_zones%rowtype;
  v_child_m2 double precision;
  v_outside_m2 double precision;
  v_checkpoints jsonb := '[]'::jsonb;
BEGIN
  SELECT * INTO v_child FROM public.location_zones WHERE id = p_zone_id;
  IF NOT FOUND OR v_child.parent_zone_id IS NULL THEN
    RETURN jsonb_build_object('status', 'no_parent', 'checkpoints_outside', '[]'::jsonb);
  END IF;
  SELECT * INTO v_parent FROM public.location_zones WHERE id = v_child.parent_zone_id;
  IF NOT FOUND OR v_parent.boundary IS NULL THEN
    RETURN jsonb_build_object('status', 'no_boundary', 'checkpoints_outside', '[]'::jsonb);
  END IF;

  -- Only the calling provider's own active checkpoints, matching get_location_patrol_checkpoints.
  IF p_checkpoint_organization_id IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name,
        'distance_m', round(ST_Distance(v_parent.boundary::geography, p.pt::geography)::numeric, 1)
      ) ORDER BY c.name), '[]'::jsonb)
    INTO v_checkpoints
    FROM public.patrol_checkpoints c
    CROSS JOIN LATERAL (SELECT ST_SetSRID(ST_MakePoint(c.gps_lng, c.gps_lat), 4326) AS pt) p
    WHERE c.zone_id = v_child.id AND c.active AND c.organization_id = p_checkpoint_organization_id
      AND c.gps_lat IS NOT NULL AND c.gps_lng IS NOT NULL
      AND NOT ST_Covers(v_parent.boundary, p.pt);
  END IF;

  IF v_child.boundary IS NULL THEN
    RETURN jsonb_build_object('status', 'no_boundary', 'checkpoints_outside', v_checkpoints);
  END IF;
  v_child_m2 := ST_Area(v_child.boundary::geography);
  v_outside_m2 := ST_Area(ST_Difference(v_child.boundary, v_parent.boundary)::geography);
  RETURN jsonb_build_object(
    'status', 'measured',
    'child_hectares', round((v_child_m2 / 10000)::numeric, 2),
    'inside_parent_percent', CASE WHEN v_child_m2 > 0
      THEN round((greatest(v_child_m2 - v_outside_m2, 0) / v_child_m2 * 100)::numeric, 1) END,
    'outside_parent_hectares', round((v_outside_m2 / 10000)::numeric, 2),
    'checkpoints_outside', v_checkpoints);
EXCEPTION WHEN internal_error OR data_exception THEN
  -- A GEOS topology failure must not break a save or the map read; the advisory is simply unavailable.
  RETURN jsonb_build_object('status', 'unavailable', 'checkpoints_outside', '[]'::jsonb);
END;
$function$;

COMMENT ON FUNCTION public.location_zone_parent_containment(uuid, uuid) IS
  'Advisory only: how much of a work area lies inside its reporting parent, and which of the given provider''s active checkpoints on it lie outside the parent. Never used for resolution or to block a save.';
REVOKE ALL ON FUNCTION public.location_zone_parent_containment(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.location_zone_parent_containment(uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.set_location_zone_parent(p_zone_id uuid, p_parent_zone_id uuid, p_expected_version integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_zone public.location_zones%rowtype;
  v_parent public.location_zones%rowtype;
  v_old_parent uuid;
  v_parent_level integer;
  v_subtree_height integer;
  v_changed boolean := false;
  v_cycle boolean;
  c_max_depth constant integer := 5;
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id = v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active CRM administrator required for this location';
  END IF;
  SELECT * INTO v_zone FROM public.location_zones WHERE id = p_zone_id;
  IF NOT FOUND OR NOT public.crm_actor_can_manage_location(v_zone.location_id) THEN
    RAISE EXCEPTION 'Active CRM administrator required for this location';
  END IF;

  -- Serialise parent edits per place so two concurrent edits cannot form a cycle.
  PERFORM pg_advisory_xact_lock(hashtextextended('location_zone_parent:' || v_zone.location_id::text, 0));
  SELECT * INTO v_zone FROM public.location_zones WHERE id = p_zone_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Zone not found';
  END IF;

  IF v_zone.is_verification_point THEN
    RAISE EXCEPTION 'Verification points are not work areas';
  END IF;
  IF p_expected_version IS NOT NULL AND v_zone.configuration_version <> p_expected_version THEN
    RAISE EXCEPTION 'Zone configuration changed since it was opened';
  END IF;

  IF p_parent_zone_id IS NOT NULL THEN
    IF p_parent_zone_id = v_zone.id THEN
      RAISE EXCEPTION 'A work area cannot be part of itself';
    END IF;
    SELECT * INTO v_parent FROM public.location_zones WHERE id = p_parent_zone_id;
    IF NOT FOUND OR v_parent.organization_id <> v_zone.organization_id THEN
      RAISE EXCEPTION 'Parent work area must belong to the same organisation';
    END IF;
    IF v_parent.location_id IS DISTINCT FROM v_zone.location_id THEN
      RAISE EXCEPTION 'Parent work area must be on the same place';
    END IF;
    IF v_parent.is_verification_point THEN
      RAISE EXCEPTION 'A verification point cannot be a parent work area';
    END IF;

    WITH RECURSIVE parts(id, depth) AS (
      SELECT v_zone.id, 1
      UNION
      SELECT child.id, parts.depth + 1
      FROM public.location_zones child JOIN parts ON child.parent_zone_id = parts.id
      WHERE NOT child.is_verification_point AND parts.depth < 32
    )
    SELECT max(depth), bool_or(id = p_parent_zone_id) INTO v_subtree_height, v_cycle FROM parts;
    IF v_cycle THEN
      RAISE EXCEPTION 'A work area cannot be part of one of its own parts';
    END IF;

    WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT v_parent.id, v_parent.parent_zone_id, 1
      UNION
      SELECT up.id, up.parent_zone_id, chain.depth + 1
      FROM public.location_zones up JOIN chain ON up.id = chain.parent_id
      WHERE chain.depth < 32
    )
    SELECT max(depth) INTO v_parent_level FROM chain;
    IF v_parent_level + v_subtree_height > c_max_depth THEN
      RAISE EXCEPTION 'Work areas can be nested at most % levels deep', c_max_depth;
    END IF;
  END IF;

  v_old_parent := v_zone.parent_zone_id;
  v_changed := v_old_parent IS DISTINCT FROM p_parent_zone_id;
  IF v_changed THEN
    UPDATE public.location_zones
    SET parent_zone_id = p_parent_zone_id, configuration_version = configuration_version + 1
    WHERE id = v_zone.id
    RETURNING * INTO v_zone;
    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_provider, v_actor, 'crm_zone_parent_set', 'location_zones', v_zone.id, jsonb_build_object(
      'location_id', v_zone.location_id,
      'old_parent_zone_id', v_old_parent,
      'new_parent_zone_id', v_zone.parent_zone_id,
      'configuration_version', v_zone.configuration_version));
  END IF;

  RETURN jsonb_build_object(
    'zone_id', v_zone.id,
    'parent_zone_id', v_zone.parent_zone_id,
    'configuration_version', v_zone.configuration_version,
    'changed', v_changed,
    'containment', public.location_zone_parent_containment(v_zone.id, v_provider));
END;
$function$;

COMMENT ON FUNCTION public.set_location_zone_parent(uuid, uuid, integer) IS
  'Sets or clears a work area''s reporting parent ("Part of") on the same organisation and place. Reporting-only: does not affect resolve_context. Returns advisory containment that never blocks.';
REVOKE ALL ON FUNCTION public.set_location_zone_parent(uuid, uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_location_zone_parent(uuid, uuid, integer) TO authenticated, service_role;

-- The place map read carries the reporting parent and its advisory containment. Body otherwise as live.
CREATE OR REPLACE FUNCTION public.get_crm_operational_geography()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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
              AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
              AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
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
              AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
              AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
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
          zone.parking_limit_source, zone.parking_limit_set_at, zone.configuration_version,
          zone.parent_zone_id,
          CASE WHEN zone.parent_zone_id IS NOT NULL
            THEN public.location_zone_parent_containment(zone.id, NULL) END AS parent_containment
        FROM public.location_zones zone LEFT JOIN public.locations location ON location.id = zone.location_id
        WHERE NOT zone.is_verification_point AND (zone.organization_id = ANY(v_reach)
          OR EXISTS (
            SELECT 1 FROM public.service_agreements agreement
            JOIN public.service_agreement_locations link ON link.service_agreement_id = agreement.id AND link.status = 'active'
            WHERE agreement.provider_organization_id = ANY(v_reach)
              AND (agreement.starts_on IS NULL OR agreement.starts_on <= current_date)
              AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
              AND agreement.agreement_type = 'operational' AND link.zone_id = zone.id
          ))
      ) item
    )
  );
END;
$function$;

-- The place editor lists every work area on the place, so it carries each one's reporting parent; the geography read
-- covers only zones in the actor's reach and must not be the "Part of" source. Body otherwise as live.
CREATE OR REPLACE FUNCTION public.get_crm_operational_place_editor(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_provider uuid;v_location public.locations%rowtype;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_location(p_location_id) then raise exception 'Active CRM administrator required for this location';end if;
  select * into v_location from public.locations l where l.id=p_location_id;if not found then raise exception 'Location not found';end if;
  return jsonb_build_object(
    'location',jsonb_build_object('id',v_location.id,'name',v_location.name,'organization_id',v_location.organization_id),
    'sites',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'risk_level',s.risk_level,'site_brief',s.site_brief,'access_instructions',s.access_instructions,'hs_notes',s.hs_notes,'active',s.active,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'configuration_version',s.configuration_version) order by s.name),'[]'::jsonb) from public.client_sites s where s.location_id=v_location.id),
    'zones',(select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'zone_type',z.zone_type,'module_key',z.module_key,'rule_type',z.rule_type,'is_active',z.is_active,'nightly_limit_consecutive',z.nightly_limit_consecutive,'nightly_limit_monthly',z.nightly_limit_monthly,'scv_required',z.scv_required,'enforcement_workflow_override',z.enforcement_workflow_override,'parent_zone_id',z.parent_zone_id,'boundary_status',z.boundary_status,'boundary_verification',z.boundary_verification,'configuration_version',z.configuration_version) order by z.name),'[]'::jsonb) from public.location_zones z where z.location_id=v_location.id AND NOT z.is_verification_point),
    'modules',(select coalesce(jsonb_agg(jsonb_build_object('module_key',m.module_key,'display_name',initcap(replace(m.module_key,'_',' '))) order by m.module_key),'[]'::jsonb) from public.module_catalog m where m.active),
    'closures',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'zone_id',c.zone_id,'closure_type',c.closure_type,'status',c.status,'effective_from',c.effective_from,'effective_to',c.effective_to,'reason',c.reason,'resolution_notes',c.resolution_notes) order by c.created_at desc),'[]'::jsonb) from public.zone_closures c join public.location_zones z on z.id=c.zone_id where z.location_id=v_location.id AND NOT z.is_verification_point)
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.get_crm_operational_place_editor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crm_operational_place_editor(uuid) TO authenticated, service_role;