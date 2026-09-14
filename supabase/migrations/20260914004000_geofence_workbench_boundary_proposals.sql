-- Geofence Workbench engine: every boundary from every source lands as a
-- PROPOSAL, is drawn on the map for a human, and is only written to the live
-- entity through accept_boundary_proposal. Implements the ratified
-- GEOFENCE_SYSTEM_REDESIGN principles: no silent fallbacks (P1), visual
-- verification gate on all sources (P2), area gate per zone_type (#99), one
-- canonical address-entry pipeline with dedup (Q10).

-- 1. Security fix: browser boundary RPCs were granted to anon/public.
REVOKE ALL ON FUNCTION public.save_site_boundary(uuid, uuid, text, double precision, double precision) FROM public, anon;
REVOKE ALL ON FUNCTION public.save_zone_boundary(uuid, uuid, text, double precision, double precision) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.save_site_boundary(uuid, uuid, text, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_zone_boundary(uuid, uuid, text, double precision, double precision) TO authenticated, service_role;

-- 2. History can now record checkpoint verification.
ALTER TABLE public.geofence_boundary_history DROP CONSTRAINT IF EXISTS geofence_boundary_history_entity_type_check;
ALTER TABLE public.geofence_boundary_history ADD CONSTRAINT geofence_boundary_history_entity_type_check
  CHECK (entity_type = ANY (ARRAY['organization','location_zone','client_site','patrol_checkpoint']));

-- 3. Proposal staging table.
CREATE TABLE IF NOT EXISTS public.boundary_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('client_site','location_zone','organization','patrol_checkpoint')),
  entity_id uuid,
  proposed_boundary geometry(MultiPolygon, 4326) NOT NULL,
  center_point geometry(Point, 4326),
  area_m2 numeric NOT NULL,
  source text NOT NULL CHECK (source IN ('linz_parcel','linz_building','council_gis','nzta','google_point_radius','user_drawn','bob','imported_geojson')),
  source_ref jsonb NOT NULL DEFAULT '{}'::jsonb,
  address_candidate jsonb,
  zone_type text,
  gate_ok boolean NOT NULL,
  gate_reason text,
  drift_from_current_m double precision,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected','superseded')),
  proposed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  proposed_via text NOT NULL DEFAULT 'workbench' CHECK (proposed_via IN ('workbench','batch','bob')),
  proposed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  decided_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  final_boundary geometry(MultiPolygon, 4326),
  human_edited boolean,
  history_version integer
);

CREATE INDEX IF NOT EXISTS boundary_proposals_queue_idx
  ON public.boundary_proposals (organization_id, status, proposed_at DESC);
CREATE INDEX IF NOT EXISTS boundary_proposals_entity_idx
  ON public.boundary_proposals (entity_type, entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS boundary_proposals_geom_idx
  ON public.boundary_proposals USING gist (proposed_boundary);

COMMENT ON TABLE public.boundary_proposals IS
  'Staging for boundary geometry from any source (LINZ, council GIS, NZTA, Bob, user-drawn). Nothing here is authoritative. accept_boundary_proposal writes the human-confirmed shape to the live entity; the proposal keeps what the source returned versus what the human saved.';

ALTER TABLE public.boundary_proposals ENABLE ROW LEVEL SECURITY;
CREATE POLICY boundary_proposals_select ON public.boundary_proposals FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));
REVOKE INSERT, UPDATE, DELETE ON public.boundary_proposals FROM anon, authenticated;
GRANT SELECT ON public.boundary_proposals TO authenticated;
GRANT ALL ON public.boundary_proposals TO service_role;

-- 4. Area gate per zone_type (m^2). Owner-confirmed NZ bands from
--    bob-resolve-geofence; a shape outside its band is never authoritative.
CREATE OR REPLACE FUNCTION public.geofence_area_gate(p_area_m2 numeric, p_zone_type text)
RETURNS TABLE (ok boolean, reason text)
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_min numeric; v_max numeric;
BEGIN
  CASE coalesce(p_zone_type, '')
    WHEN 'parking', 'parking_enforcement' THEN v_min := 10; v_max := 50000;
    WHEN 'freedom_camping' THEN v_min := 50; v_max := 500000;
    WHEN 'noise_control' THEN v_min := 50; v_max := 2000000;
    WHEN 'patrol_area', 'patrol_route' THEN v_min := 1000; v_max := 100000000;
    WHEN 'site' THEN v_min := 10; v_max := 2000000;
    WHEN 'jurisdiction' THEN v_min := 1000000; v_max := 300000000000;
    ELSE v_min := 10; v_max := 500000;
  END CASE;
  IF p_area_m2 IS NULL OR p_area_m2 <= 0 THEN RETURN QUERY SELECT false, 'invalid_area'; RETURN; END IF;
  IF p_area_m2 < v_min THEN RETURN QUERY SELECT false, format('below_min_area:%sm2<%s', round(p_area_m2), v_min); RETURN; END IF;
  IF p_area_m2 > v_max THEN RETURN QUERY SELECT false, format('above_max_area:%sm2>%s', round(p_area_m2), v_max); RETURN; END IF;
  RETURN QUERY SELECT true, NULL::text;
END;
$$;

-- 5. Canonical address dedup (Q10): match by address key or within 50 m.
CREATE OR REPLACE FUNCTION public.find_existing_site_for_address(
  p_organization_id uuid,
  p_address text,
  p_lat double precision,
  p_lng double precision
) RETURNS TABLE (
  site_id uuid, site_name text, address text, client_organization_id uuid,
  match_reason text, distance_m double precision, has_boundary boolean, boundary_verification text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key text := nullif(regexp_replace(lower(trim(coalesce(p_address, ''))), '[^a-z0-9]+', '', 'g'), '');
  v_point geometry;
BEGIN
  IF auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Organization access denied';
  END IF;
  IF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    v_point := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  END IF;
  RETURN QUERY
  SELECT s.id, s.name, s.address, s.client_organization_id,
    CASE WHEN v_key IS NOT NULL AND s.address_match_key = v_key THEN 'exact_address' ELSE 'within_50m' END,
    CASE WHEN v_point IS NULL OR s.center_point IS NULL THEN NULL
         ELSE ST_Distance(s.center_point::geography, v_point::geography) END,
    s.boundary IS NOT NULL,
    s.boundary_verification
  FROM public.client_sites s
  WHERE public.org_access_allowed(s.client_organization_id)
    AND ((v_key IS NOT NULL AND s.address_match_key = v_key)
      OR (v_point IS NOT NULL AND s.center_point IS NOT NULL
          AND ST_DWithin(s.center_point::geography, v_point::geography, 50)))
  ORDER BY CASE WHEN v_key IS NOT NULL AND s.address_match_key = v_key THEN 0 ELSE 1 END,
           ST_Distance(s.center_point::geography, v_point::geography) NULLS LAST
  LIMIT 5;
END;
$$;

-- 6. Propose: stage geometry, compute area/gate/drift. Never touches live rows.
CREATE OR REPLACE FUNCTION public.propose_boundary(
  p_organization_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_geojson jsonb,
  p_source text,
  p_source_ref jsonb DEFAULT '{}'::jsonb,
  p_address_candidate jsonb DEFAULT NULL,
  p_zone_type text DEFAULT NULL,
  p_proposed_via text DEFAULT 'workbench'
) RETURNS TABLE (
  proposal_id uuid, area_m2 numeric, gate_ok boolean, gate_reason text,
  drift_from_current_m double precision, current_has_boundary boolean, proposed_geojson jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_geom geometry;
  v_area numeric;
  v_gate record;
  v_current geometry;
  v_drift double precision;
  v_zone_type text := p_zone_type;
  v_row public.boundary_proposals%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT public.is_admin_for_org(p_organization_id) AND NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Organization access denied';
  END IF;
  IF p_entity_type NOT IN ('client_site','location_zone','organization','patrol_checkpoint') THEN
    RAISE EXCEPTION 'Unsupported entity_type %', p_entity_type;
  END IF;

  v_geom := ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p_geojson::text), 4326)));
  IF v_geom IS NULL OR ST_IsEmpty(v_geom) OR NOT ST_IsValid(v_geom) THEN
    RAISE EXCEPTION 'Proposed geometry is empty or invalid';
  END IF;
  IF GeometryType(v_geom) <> 'MULTIPOLYGON' THEN
    RAISE EXCEPTION 'Proposed geometry must be a polygon, got %', GeometryType(v_geom);
  END IF;
  v_area := ST_Area(v_geom::geography);

  IF p_entity_id IS NOT NULL THEN
    IF p_entity_type = 'client_site' THEN
      SELECT boundary INTO v_current FROM public.client_sites WHERE id = p_entity_id;
      v_zone_type := coalesce(v_zone_type, 'site');
    ELSIF p_entity_type = 'location_zone' THEN
      SELECT boundary, coalesce(v_zone_type, zone_type) INTO v_current, v_zone_type FROM public.location_zones WHERE id = p_entity_id;
    ELSIF p_entity_type = 'organization' THEN
      SELECT jurisdiction_geom INTO v_current FROM public.organizations WHERE id = p_entity_id;
      v_zone_type := coalesce(v_zone_type, 'jurisdiction');
    END IF;
    IF v_current IS NOT NULL THEN
      v_drift := ST_HausdorffDistance(v_current::geography, v_geom::geography);
    END IF;
  ELSE
    v_zone_type := coalesce(v_zone_type, CASE p_entity_type WHEN 'client_site' THEN 'site' WHEN 'organization' THEN 'jurisdiction' END);
  END IF;

  SELECT * INTO v_gate FROM public.geofence_area_gate(v_area, v_zone_type);

  -- Any older open proposal for the same entity is superseded by this one.
  IF p_entity_id IS NOT NULL THEN
    UPDATE public.boundary_proposals SET status = 'superseded', decided_at = clock_timestamp()
    WHERE entity_type = p_entity_type AND entity_id = p_entity_id AND status = 'proposed';
  END IF;

  INSERT INTO public.boundary_proposals (
    organization_id, entity_type, entity_id, proposed_boundary, center_point, area_m2,
    source, source_ref, address_candidate, zone_type, gate_ok, gate_reason,
    drift_from_current_m, proposed_by, proposed_via
  ) VALUES (
    p_organization_id, p_entity_type, p_entity_id, v_geom, ST_Centroid(v_geom), v_area,
    p_source, coalesce(p_source_ref, '{}'::jsonb), p_address_candidate, v_zone_type, v_gate.ok, v_gate.reason,
    v_drift, v_actor, CASE WHEN p_proposed_via IN ('workbench','batch','bob') THEN p_proposed_via ELSE 'workbench' END
  ) RETURNING * INTO v_row;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'boundary_proposed', 'boundary_proposals', v_row.id,
    jsonb_build_object('entity_type', p_entity_type, 'entity_id', p_entity_id, 'source', p_source,
      'area_m2', round(v_area), 'gate_ok', v_gate.ok, 'gate_reason', v_gate.reason, 'drift_m', v_drift));

  RETURN QUERY SELECT v_row.id, v_area, v_gate.ok, v_gate.reason, v_drift, v_current IS NOT NULL, ST_AsGeoJSON(v_geom)::jsonb;
END;
$$;

-- 7. Accept: human-confirmed shape (possibly edited) becomes the live boundary.
--    Writes through the existing history discipline; optional same-actor verify.
CREATE OR REPLACE FUNCTION public.accept_boundary_proposal(
  p_proposal_id uuid,
  p_final_geojson jsonb DEFAULT NULL,
  p_verify boolean DEFAULT false,
  p_note text DEFAULT NULL
) RETURNS TABLE (entity_type text, entity_id uuid, area_m2 numeric, human_edited boolean, verified boolean, history_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_p public.boundary_proposals%rowtype;
  v_final geometry;
  v_edited boolean := false;
  v_area numeric;
  v_gate record;
  v_version integer;
  v_owner_org uuid;
  v_source text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_p FROM public.boundary_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Proposal not found'; END IF;
  IF v_p.status <> 'proposed' THEN RAISE EXCEPTION 'Proposal is already %', v_p.status; END IF;
  IF v_p.entity_id IS NULL THEN RAISE EXCEPTION 'Proposal has no target entity; create the site or zone first'; END IF;

  IF p_final_geojson IS NOT NULL THEN
    v_final := ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(p_final_geojson::text), 4326)));
    IF v_final IS NULL OR ST_IsEmpty(v_final) OR NOT ST_IsValid(v_final) THEN RAISE EXCEPTION 'Final geometry is empty or invalid'; END IF;
    v_edited := NOT ST_Equals(v_final, v_p.proposed_boundary);
  ELSE
    v_final := v_p.proposed_boundary;
  END IF;
  v_area := ST_Area(v_final::geography);
  SELECT * INTO v_gate FROM public.geofence_area_gate(v_area, v_p.zone_type);
  IF NOT v_gate.ok THEN RAISE EXCEPTION 'Boundary fails the % area gate: %', coalesce(v_p.zone_type, 'default'), v_gate.reason; END IF;

  v_source := CASE WHEN v_edited THEN 'user_drawn' ELSE v_p.source END;

  IF v_p.entity_type = 'client_site' THEN
    SELECT client_organization_id INTO v_owner_org FROM public.client_sites WHERE id = v_p.entity_id FOR UPDATE;
    IF v_owner_org IS NULL OR NOT public.org_access_allowed(v_owner_org) THEN RAISE EXCEPTION 'Site not found or access denied'; END IF;
    -- client_sites.boundary is Polygon(4326); a single-part multipolygon is unwrapped.
    IF ST_NumGeometries(v_final) <> 1 THEN RAISE EXCEPTION 'A site boundary must be a single polygon'; END IF;
    UPDATE public.client_sites
      SET boundary = ST_GeometryN(v_final, 1), center_point = ST_Centroid(v_final),
          boundary_status = CASE WHEN v_p.source = 'google_point_radius' THEN 'provisional' ELSE 'authoritative' END,
          boundary_verification = 'unverified', boundary_verified_by = NULL, boundary_verified_at = NULL,
          configuration_version = configuration_version + 1
      WHERE id = v_p.entity_id;
    v_version := public._gbh_next_version('client_site', v_p.entity_id);
    INSERT INTO public.geofence_boundary_history (entity_type, entity_id, boundary, boundary_source, verification_state, changed_by, changed_via, change_reason, version)
    VALUES ('client_site', v_p.entity_id, ST_GeometryN(v_final, 1), v_source, 'unverified', v_actor, 'direct_edit',
      format('Accepted boundary proposal %s (%s%s)', v_p.id, v_p.source, CASE WHEN v_edited THEN ', human-edited' ELSE '' END), v_version);
  ELSIF v_p.entity_type = 'location_zone' THEN
    SELECT organization_id INTO v_owner_org FROM public.location_zones WHERE id = v_p.entity_id FOR UPDATE;
    IF v_owner_org IS NULL OR NOT public.is_admin_for_org(v_owner_org) THEN RAISE EXCEPTION 'Zone not found or access denied'; END IF;
    UPDATE public.location_zones
      SET boundary = v_final, center_point = ST_Centroid(v_final),
          boundary_status = CASE WHEN v_p.source = 'google_point_radius' THEN 'provisional' ELSE 'authoritative' END,
          boundary_verification = 'unverified', boundary_verified_by = NULL, boundary_verified_at = NULL,
          configuration_version = configuration_version + 1
      WHERE id = v_p.entity_id;
    v_version := public._gbh_next_version('location_zone', v_p.entity_id);
    INSERT INTO public.geofence_boundary_history (entity_type, entity_id, boundary, boundary_source, verification_state, changed_by, changed_via, change_reason, version)
    VALUES ('location_zone', v_p.entity_id, v_final, v_source, 'unverified', v_actor, 'direct_edit',
      format('Accepted boundary proposal %s (%s%s)', v_p.id, v_p.source, CASE WHEN v_edited THEN ', human-edited' ELSE '' END), v_version);
  ELSE
    -- Org jurisdiction is SENSITIVE (Q5): it must go through the governed proposal flow.
    RAISE EXCEPTION 'Entity type % cannot be accepted through the workbench', v_p.entity_type;
  END IF;

  UPDATE public.boundary_proposals
    SET status = 'accepted', decided_by = v_actor, decided_at = clock_timestamp(), decision_note = p_note,
        final_boundary = v_final, human_edited = v_edited, history_version = v_version
    WHERE id = v_p.id;

  IF p_verify THEN
    PERFORM public.verify_boundary(v_p.entity_type, v_p.entity_id);
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_p.organization_id, v_actor, 'boundary_proposal_accepted', v_p.entity_type || 's', v_p.entity_id,
    jsonb_build_object('proposal_id', v_p.id, 'source', v_p.source, 'human_edited', v_edited, 'area_m2', round(v_area), 'verified', p_verify, 'history_version', v_version));

  RETURN QUERY SELECT v_p.entity_type, v_p.entity_id, v_area, v_edited, p_verify, v_version;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_boundary_proposal(p_proposal_id uuid, p_note text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_actor uuid := auth.uid(); v_p public.boundary_proposals%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF nullif(trim(coalesce(p_note, '')), '') IS NULL THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO v_p FROM public.boundary_proposals WHERE id = p_proposal_id FOR UPDATE;
  IF NOT FOUND OR NOT public.org_access_allowed(v_p.organization_id) THEN RAISE EXCEPTION 'Proposal not found or access denied'; END IF;
  IF v_p.status <> 'proposed' THEN RAISE EXCEPTION 'Proposal is already %', v_p.status; END IF;
  UPDATE public.boundary_proposals SET status = 'rejected', decided_by = v_actor, decided_at = clock_timestamp(), decision_note = trim(p_note) WHERE id = v_p.id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_p.organization_id, v_actor, 'boundary_proposal_rejected', 'boundary_proposals', v_p.id, jsonb_build_object('entity_type', v_p.entity_type, 'entity_id', v_p.entity_id, 'source', v_p.source, 'note', trim(p_note)));
  RETURN true;
END;
$$;

-- 8. Unified review queue across sites and zones for the caller's reach.
CREATE OR REPLACE FUNCTION public.get_geofence_review_queue(p_organization_id uuid DEFAULT NULL)
RETURNS TABLE (
  entity_type text, entity_id uuid, name text, address text, organization_id uuid, organization_name text,
  zone_type text, module_key text, boundary_state text, boundary_status text, boundary_verification text,
  has_boundary boolean, boundary_geojson jsonb, center_lat double precision, center_lng double precision,
  active_agreements integer, open_proposal_id uuid, open_proposal_source text, open_proposal_gate_ok boolean,
  open_proposal_area_m2 numeric, open_proposal_drift_m double precision, open_proposal_geojson jsonb,
  configuration_version integer, priority integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sites AS (
    SELECT 'client_site'::text AS entity_type, s.id AS entity_id, s.name, s.address, s.client_organization_id AS organization_id,
      NULL::text AS zone_type, NULL::text AS module_key, s.boundary_status, s.boundary_verification, s.boundary AS geom, s.center_point,
      (SELECT count(*)::integer FROM public.service_agreement_locations sal JOIN public.service_agreements sa ON sa.id = sal.service_agreement_id
        WHERE sal.site_id = s.id AND sal.status = 'active'
          AND (sa.starts_on IS NULL OR sa.starts_on <= current_date) AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)) AS active_agreements,
      s.configuration_version
    FROM public.client_sites s
    WHERE s.active AND public.org_access_allowed(s.client_organization_id)
      AND (p_organization_id IS NULL OR s.client_organization_id = p_organization_id)
  ), zones AS (
    SELECT 'location_zone'::text, z.id, z.name, z.address, z.organization_id, z.zone_type, z.module_key, z.boundary_status, z.boundary_verification, z.boundary, z.center_point,
      (SELECT count(*)::integer FROM public.service_agreement_locations sal JOIN public.service_agreements sa ON sa.id = sal.service_agreement_id
        WHERE sal.zone_id = z.id AND sal.status = 'active'
          AND (sa.starts_on IS NULL OR sa.starts_on <= current_date) AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)),
      z.configuration_version
    FROM public.location_zones z
    WHERE z.is_active AND public.org_access_allowed(z.organization_id)
      AND (p_organization_id IS NULL OR z.organization_id = p_organization_id)
  ), entities AS (SELECT * FROM sites UNION ALL SELECT * FROM zones)
  SELECT e.entity_type, e.entity_id, e.name, e.address, e.organization_id, o.name,
    e.zone_type, e.module_key,
    CASE WHEN e.geom IS NULL THEN 'missing' WHEN e.boundary_verification = 'verified' THEN 'verified' ELSE 'unverified' END,
    e.boundary_status, e.boundary_verification,
    e.geom IS NOT NULL, CASE WHEN e.geom IS NULL THEN NULL ELSE ST_AsGeoJSON(e.geom)::jsonb END,
    ST_Y(e.center_point), ST_X(e.center_point),
    e.active_agreements,
    bp.id, bp.source, bp.gate_ok, bp.area_m2, bp.drift_from_current_m, CASE WHEN bp.id IS NULL THEN NULL ELSE ST_AsGeoJSON(bp.proposed_boundary)::jsonb END,
    e.configuration_version,
    (CASE WHEN e.geom IS NULL THEN 300 WHEN e.boundary_verification <> 'verified' THEN 200 ELSE 0 END)
      + (CASE WHEN bp.id IS NOT NULL THEN 50 ELSE 0 END)
      + least(e.active_agreements, 10) * 10
  FROM entities e
  JOIN public.organizations o ON o.id = e.organization_id
  LEFT JOIN LATERAL (
    SELECT * FROM public.boundary_proposals p WHERE p.entity_type = e.entity_type AND p.entity_id = e.entity_id AND p.status = 'proposed'
    ORDER BY p.proposed_at DESC LIMIT 1
  ) bp ON true
  ORDER BY 24 DESC, e.name;
$$;

REVOKE ALL ON FUNCTION public.geofence_area_gate(numeric, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.find_existing_site_for_address(uuid, text, double precision, double precision) FROM public, anon;
REVOKE ALL ON FUNCTION public.propose_boundary(uuid, text, uuid, jsonb, text, jsonb, jsonb, text, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.accept_boundary_proposal(uuid, jsonb, boolean, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.reject_boundary_proposal(uuid, text) FROM public, anon;
REVOKE ALL ON FUNCTION public.get_geofence_review_queue(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.geofence_area_gate(numeric, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.find_existing_site_for_address(uuid, text, double precision, double precision) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.propose_boundary(uuid, text, uuid, jsonb, text, jsonb, jsonb, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.accept_boundary_proposal(uuid, jsonb, boolean, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_boundary_proposal(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_geofence_review_queue(uuid) TO authenticated, service_role;
