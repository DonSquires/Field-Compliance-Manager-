create or replace function public.resolve_context (
  p_lat        double precision,
  p_lng        double precision,
  p_org_id     uuid,
  p_module_key text                     default null::text,
  p_at         timestamp with time zone default now()
)
  returns table (
    in_operating_bounds         boolean,
    out_of_bounds_district      text,
    governing_jurisdiction_id   uuid,
    governing_jurisdiction_name text,
    on_site                     boolean,
    site_id                     uuid,
    client_org_id               uuid,
    matched_zone_id             uuid,
    matched_module_key          text,
    effective_rules             jsonb,
    resolution_status           text,
    governor_overlap_flag       boolean
  )
  language plpgsql
  stable
  security definer
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
  v_client_org   uuid := null;  -- final owner answer (always resolves TO THE HOUSE where possible)
  v_rules        jsonb := '{}'::jsonb;
  v_resolution   text := 'outside_all_geofences';
  v_gov_overlap  boolean := false;

  -- Layer 1/2 verification state
  v_org_jur_verification text;
  v_org_jur_geom_exists  boolean;
  v_org_jur_geom_valid   boolean;

  -- Governor count for overlap detection
  v_governor_count integer := 0;
BEGIN
  -- -- Layer 1: operating bounds --
  -- P1/P2: must distinguish no-geofence / unverified / invalid / outside / inside.
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

  -- Determine Layer 1 resolution_status contribution
  IF NOT COALESCE(v_org_jur_geom_exists, false) THEN
    v_resolution := 'unresolved_no_geofence';
  ELSIF NOT COALESCE(v_org_jur_geom_valid, false) THEN
    v_resolution := 'unresolved_invalid';
  ELSIF COALESCE(v_org_jur_verification, 'unverified') <> 'verified' THEN
    v_resolution := 'unresolved_unverified';
  ELSIF NOT COALESCE(v_in_bounds, false) THEN
    -- Verified geometry exists, point is outside
    v_resolution := 'outside_all_geofences';
  ELSE
    -- Point is inside verified jurisdiction; continue to Layer 2/3
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

  -- -- Layer 2: governing council jurisdiction (ROLE-AWARE) --
  -- (UNCHANGED from 0290 -- byte-identical.)

  -- First, count qualifying governors for overlap detection
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

  -- Flag overlap when more than one qualifying governor
  IF v_governor_count > 1 THEN
    v_gov_overlap := true;
  END IF;

  -- Pick the primary governor (smallest area among qualifying governors)
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

  -- -- Layer 3: site geofence + zone --
  -- 0347: added z.location_id to the SELECT (into v_zone) so the
  -- ownership hop can prefer the house. Zone MATCHING itself is
  -- byte-unchanged from 0290.
  SELECT z.id, z.site_id, z.location_id, z.module_key, z.onsite_profile, z.boundary,
         z.jurisdiction_rule_set_id, z.rule_overrides,
         z.repeat_stay_radius_m, z.repeat_stay_window_nights,
         z.nightly_limit_consecutive, z.nightly_limit_monthly, z.scv_required
    INTO v_zone
  FROM public.location_zones z
  WHERE z.organization_id = p_org_id
    AND z.boundary IS NOT NULL
    AND z.boundary_verification = 'verified'
    AND ST_IsValid(z.boundary)
    AND NOT ST_IsEmpty(z.boundary)
    AND st_contains(z.boundary, v_point)
    AND (p_module_key IS NULL OR z.module_key = p_module_key)
    AND public._geofence_active_at(z.active_schedule, p_at)
  ORDER BY (z.parent_zone_id IS NOT NULL) DESC
  LIMIT 1;

  IF v_zone.id IS NOT NULL THEN
    v_site_id := v_zone.site_id;
    v_resolution := 'resolved';

    -- 0347 OWNERSHIP: the answer is ALWAYS THE HOUSE
    -- (locations.organization_id). site_id is a transitional
    -- COMPATIBILITY LINK (v2 ruling !1304) -- never a co-equal owner.
    -- So it is used only as a ROUTE to the house, not as an owner in
    -- its own right. Resolution tiers, all landing on the house:
    --   1. zone.location_id -> locations.organization_id       (direct house link)
    --   2. zone.site_id -> client_sites.location_id -> locations (site as ROUTE to house)
    --   3. zone.site_id -> client_sites.client_organization_id (transitional last-resort,
    --      only while a site has no house link yet during migration)
    -- On current data every zone.location_id is NULL and sites may not
    -- yet carry location_id, so resolution reaches tier 3 = the exact
    -- 0290 answer (client_sites.client_organization_id). Output is
    -- therefore IDENTICAL today; it becomes house-authoritative as
    -- step 2 populates location_id upward. Per the §5 ruling the three
    -- tiers return the SAME org by construction (same PLACE axis).

    -- Tier 1: zone carries a direct house link.
    IF v_zone.location_id IS NOT NULL THEN
      SELECT loc.organization_id
        INTO v_client_org
      FROM public.locations loc
      WHERE loc.id = v_zone.location_id;
    END IF;

    -- ON-SITE test stays on client_sites (the house has NO geometry).
    -- UNCHANGED from 0290. This block ALSO captures the site's own
    -- links so we can route to the house (tiers 2/3) when the zone
    -- had no direct location_id.
    IF v_site_id IS NOT NULL THEN
      DECLARE
        v_site_location_id uuid := null;
        v_site_client_org  uuid := null;
      BEGIN
        SELECT cs.location_id,
               cs.client_organization_id,
               CASE
                 WHEN v_zone.onsite_profile = 'approach_10m'
                   THEN st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography, v_point::geography, 10)
                 ELSE
                   (cs.boundary IS NOT NULL AND st_contains(cs.boundary, v_point))
                   OR st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography,
                                 v_point::geography,
                                 COALESCE(cs.onsite_radius_meters, 10))
               END
          INTO v_site_location_id, v_site_client_org, v_on_site
        FROM public.client_sites cs
        WHERE cs.id = v_site_id;
        v_on_site := COALESCE(v_on_site, false);

        -- Owner not yet resolved via the zone's direct house link:
        -- route THROUGH the site to its house (tier 2), and only if
        -- the site has no house yet, use the site's own owner column
        -- as the transitional last-resort (tier 3).
        IF v_client_org IS NULL THEN
          IF v_site_location_id IS NOT NULL THEN
            SELECT loc.organization_id
              INTO v_client_org
            FROM public.locations loc
            WHERE loc.id = v_site_location_id;
          END IF;
          -- Tier 3 transitional fallback.
          v_client_org := COALESCE(v_client_org, v_site_client_org);
        END IF;
      END;
    END IF;

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
    -- No verified zone matched. Determine WHY for the resolution_status.
    -- (UNCHANGED from 0290.)
    IF v_resolution NOT IN ('unresolved_no_geofence', 'unresolved_invalid', 'unresolved_unverified') THEN
      IF EXISTS (
        SELECT 1 FROM public.location_zones z
        WHERE z.organization_id = p_org_id
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
        WHERE z.organization_id = p_org_id
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
          WHERE z.organization_id = p_org_id
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

grant execute
  on function "public"."resolve_context"(double precision, double precision, uuid, text, timestamp with time zone)
  to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_context"(double precision, double precision, uuid, text, timestamp with time zone) is 'Three-layer geofence resolution with verification gate (P1/P2) and role-aware governing jurisdiction. 0347 convergence step 1: the OWNERSHIP answer (client_org_id) ALWAYS resolves TO THE HOUSE (locations.organization_id) where a house is reachable. site_id is a transitional COMPATIBILITY LINK (v2 ruling !1304), used only as a ROUTE to the house, never as a co-equal owner. Resolution tiers: (1) zone.location_id -> locations; (2) zone.site_id -> client_sites.location_id -> locations (site as route); (3) zone.site_id -> client_sites.client_organization_id (transitional last-resort only while a site has no house link during migration). Per the owner ruling (2026-08-05) all three tiers return the SAME org by construction (same PLACE axis), so this changes the SOURCE of the answer, not the answer. ON-SITE geometry, zone matching, Layer 1/2, resolution_status, all 12 columns and governor_overlap_flag are byte-unchanged from 0290. Safe day-one: live zones have location_id NULL and their sites may not yet carry location_id, so resolution reaches tier 3 = the exact 0290 answer -> IDENTICAL output on current data; becomes house-authoritative as step 2 populates location_id upward.';
