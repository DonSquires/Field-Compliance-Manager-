create or replace function public.get_orgs_by_jurisdiction_point (
  p_lng        double precision,
  p_lat        double precision,
  p_module_key text             default null::text
)
  returns table (
    id   uuid,
    name text
  )
  language sql
  stable
  security definer
  AS $function$
  WITH pt AS (
    SELECT ST_SetSRID(ST_Point(p_lng, p_lat), 4326) AS geom
  ),
  -- All orgs whose VERIFIED jurisdiction contains the point
  containing_orgs AS (
    SELECT o.id, o.name
    FROM public.organizations o, pt
    WHERE o.jurisdiction_geom IS NOT NULL
      AND o.jurisdiction_verification = 'verified'
      AND ST_Contains(o.jurisdiction_geom, pt.geom)
  ),
  -- Sites whose boundary contains the point (for ownership + agreement lookups)
  containing_sites AS (
    SELECT cs.id AS site_id, cs.client_organization_id
    FROM public.client_sites cs, pt
    WHERE cs.boundary IS NOT NULL
      AND cs.boundary_verification = 'verified'
      AND ST_IsValid(cs.boundary)
      AND NOT ST_IsEmpty(cs.boundary)
      AND ST_Contains(cs.boundary, pt.geom)
  ),
  -- Zones whose boundary contains the point (for agreement lookups)
  containing_zones AS (
    SELECT lz.id AS zone_id, lz.organization_id
    FROM public.location_zones lz, pt
    WHERE lz.boundary IS NOT NULL
      AND lz.boundary_verification = 'verified'
      AND ST_IsValid(lz.boundary)
      AND NOT ST_IsEmpty(lz.boundary)
      AND ST_Contains(lz.boundary, pt.geom)
  ),
  -- (a) Agreement-based standing: org has an active service_agreement
  --     covering the module at a site/zone containing the point.
  agreement_standing AS (
    SELECT DISTINCT sa.client_organization_id AS org_id
    FROM public.service_agreements sa
    JOIN public.service_agreement_locations sal
      ON sal.service_agreement_id = sa.id
      AND sal.status = 'active'
    LEFT JOIN public.service_agreement_modules sam
      ON sam.service_agreement_id = sa.id
      AND sam.enabled = true
    WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
      AND (
        -- Location match: site or zone containing the point
        (sal.site_id IS NOT NULL AND sal.site_id IN (SELECT site_id FROM containing_sites))
        OR
        (sal.zone_id IS NOT NULL AND sal.zone_id IN (SELECT zone_id FROM containing_zones))
      )
      AND (
        -- Module match: when p_module_key provided, require module enabled
        p_module_key IS NULL
        OR sam.module_key = p_module_key
      )
  ),
  -- (b) Self-request standing: org OWNS the site AND module is enabled
  --     at the site via site_services.
  ownership_standing AS (
    SELECT DISTINCT cs.client_organization_id AS org_id
    FROM containing_sites cs
    WHERE (
      p_module_key IS NULL
      OR EXISTS (
        SELECT 1 FROM public.site_services ss
        WHERE ss.site_id = cs.site_id
          AND ss.organization_id = cs.client_organization_id
          AND ss.module_key = p_module_key
          AND ss.enabled = true
      )
    )
  ),
  -- Union of all orgs with standing
  standing_orgs AS (
    SELECT org_id FROM agreement_standing
    UNION
    SELECT org_id FROM ownership_standing
  )
  SELECT co.id, co.name
  FROM containing_orgs co
  WHERE (
    -- When module_key is provided, only return orgs with standing
    p_module_key IS NULL
    OR co.id IN (SELECT org_id FROM standing_orgs)
  )
  ORDER BY
    -- Standing-bearing orgs sort first even when p_module_key is NULL
    (CASE WHEN co.id IN (SELECT org_id FROM standing_orgs) THEN 0 ELSE 1 END),
    co.name;
$function$;

grant execute on function "public"."get_orgs_by_jurisdiction_point"(double precision, double precision, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."get_orgs_by_jurisdiction_point"(double precision, double precision, text) is 'Role-aware requester picklist (0290). Returns orgs whose verified jurisdiction contains the point. When p_module_key is provided, filters to orgs with requester standing for that module (active agreement or site ownership + site_services). When omitted, backward-compatible but standing-bearing orgs sort first. Replaces geometry-only 0286.';
