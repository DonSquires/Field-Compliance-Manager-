-- Geofence verification: make the place house carry a verified boundary to every
-- organisation's site at the same physical place, and stop status columns lying.
--
-- Live evidence (2026-11-08):
--   * tg_client_sites_inherit_canonical_boundary / tg_location_zones_inherit_canonical_boundary
--     (20260922090000) propose with source 'canonical_place_inherited', which
--     boundary_proposals_source_check never admitted. The triggers swallow the error, so the
--     inheritance has silently never happened.
--   * 9 active sites carry boundary_status = 'authoritative' with no boundary at all.
--   * A verified site boundary never reached the canonical place or sibling sites, so another
--     organisation's site at the same place stayed "No geometry".
--
-- GEOFENCE_PRINCIPLES P1/P2 still hold: sharing stages an unverified PROPOSAL on each sibling;
-- a person at that organisation inspects it on the map and accepts/verifies it. Nothing is
-- certified on anyone's behalf.

ALTER TABLE public.boundary_proposals DROP CONSTRAINT IF EXISTS boundary_proposals_source_check;
ALTER TABLE public.boundary_proposals ADD CONSTRAINT boundary_proposals_source_check CHECK (source = ANY (ARRAY[
  'linz_parcel'::text, 'linz_building'::text, 'council_gis'::text, 'nzta'::text, 'google_point_radius'::text,
  'user_drawn'::text, 'bob'::text, 'imported_geojson'::text, 'canonical_place_inherited'::text]));

-- A site with no geometry is provisional and unverified, whatever wrote it.
CREATE OR REPLACE FUNCTION public.tg_client_sites_boundary_truth()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.boundary IS NULL THEN
    NEW.boundary_status := 'provisional';
    NEW.boundary_verification := 'unverified';
    NEW.boundary_verified_by := NULL;
    NEW.boundary_verified_at := NULL;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.tg_client_sites_boundary_truth() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_client_sites_boundary_truth ON public.client_sites;
CREATE TRIGGER trg_client_sites_boundary_truth
  BEFORE INSERT OR UPDATE OF boundary, boundary_status, boundary_verification ON public.client_sites
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_sites_boundary_truth();

UPDATE public.client_sites
SET boundary_status = 'provisional', boundary_verification = 'unverified', boundary_verified_by = NULL, boundary_verified_at = NULL
WHERE boundary IS NULL
  AND (boundary_status IS DISTINCT FROM 'provisional' OR boundary_verification IS DISTINCT FROM 'unverified'
       OR boundary_verified_by IS NOT NULL OR boundary_verified_at IS NOT NULL);

-- Stage the place's shared boundary on every sibling site that has none and no open proposal.
CREATE OR REPLACE FUNCTION public.stage_canonical_boundary_for_siblings(p_canonical_place_id uuid, p_from_site_id uuid DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_boundary geometry;
  v_area numeric;
  v_gate record;
  v_site record;
  v_id uuid;
  v_count integer := 0;
BEGIN
  SELECT boundary INTO v_boundary FROM public.canonical_places WHERE id = p_canonical_place_id;
  IF v_boundary IS NULL OR ST_IsEmpty(v_boundary) OR NOT ST_IsValid(v_boundary) OR ST_NumGeometries(v_boundary) <> 1 THEN
    RETURN 0;
  END IF;
  v_area := ST_Area(v_boundary::geography);
  SELECT * INTO v_gate FROM public.geofence_area_gate(v_area, 'site');

  FOR v_site IN
    SELECT s.id, s.client_organization_id
    FROM public.client_sites s
    JOIN public.locations l ON l.id = s.location_id
    WHERE l.canonical_place_id = p_canonical_place_id
      AND s.active AND s.boundary IS NULL
      AND s.id IS DISTINCT FROM p_from_site_id
      AND NOT EXISTS (SELECT 1 FROM public.boundary_proposals p
                      WHERE p.entity_type = 'client_site' AND p.entity_id = s.id AND p.status = 'proposed')
  LOOP
    INSERT INTO public.boundary_proposals (
      organization_id, entity_type, entity_id, proposed_boundary, center_point, area_m2,
      source, source_ref, zone_type, gate_ok, gate_reason, proposed_by, proposed_via)
    VALUES (
      v_site.client_organization_id, 'client_site', v_site.id, v_boundary, ST_Centroid(v_boundary), v_area,
      'canonical_place_inherited', jsonb_build_object('canonical_place_id', p_canonical_place_id, 'from_site_id', p_from_site_id),
      'site', v_gate.ok, v_gate.reason, auth.uid(), 'canonical_place_seed')
    RETURNING id INTO v_id;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_site.client_organization_id, auth.uid(), 'boundary_proposed', 'boundary_proposals', v_id,
      jsonb_build_object('entity_type', 'client_site', 'entity_id', v_site.id, 'source', 'canonical_place_inherited',
        'canonical_place_id', p_canonical_place_id, 'from_site_id', p_from_site_id, 'area_m2', round(v_area)));
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $function$;
COMMENT ON FUNCTION public.stage_canonical_boundary_for_siblings(uuid, uuid) IS
  'Stages the canonical place boundary as an unverified proposal on every active sibling site (any organisation) that has no boundary and no open proposal. Never writes a live boundary or verification.';
REVOKE ALL ON FUNCTION public.stage_canonical_boundary_for_siblings(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- When a person verifies a site boundary, the place learns it (only if it has none) and siblings get a proposal.
CREATE OR REPLACE FUNCTION public.tg_client_sites_share_verified_boundary()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cp uuid;
BEGIN
  SELECT l.canonical_place_id INTO v_cp FROM public.locations l WHERE l.id = NEW.location_id;
  IF v_cp IS NULL THEN RETURN NEW; END IF;
  UPDATE public.canonical_places
    SET boundary = ST_Multi(NEW.boundary), updated_at = now()
    WHERE id = v_cp AND boundary IS NULL;
  PERFORM public.stage_canonical_boundary_for_siblings(v_cp, NEW.id);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Sharing is an enrichment; it must never undo the verification a person just made.
  RAISE WARNING 'canonical boundary sharing skipped for site %: %', NEW.id, SQLERRM;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.tg_client_sites_share_verified_boundary() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_client_sites_share_verified_boundary ON public.client_sites;
CREATE TRIGGER trg_client_sites_share_verified_boundary
  AFTER UPDATE OF boundary_verification ON public.client_sites
  FOR EACH ROW
  WHEN (NEW.boundary_verification = 'verified' AND OLD.boundary_verification IS DISTINCT FROM 'verified' AND NEW.boundary IS NOT NULL)
  EXECUTE FUNCTION public.tg_client_sites_share_verified_boundary();

-- Backfill: places that already know their boundary from a verified site.
UPDATE public.canonical_places cp
SET boundary = ST_Multi(s.boundary), updated_at = now()
FROM (
  SELECT DISTINCT ON (l.canonical_place_id) l.canonical_place_id, cs.boundary
  FROM public.client_sites cs JOIN public.locations l ON l.id = cs.location_id
  WHERE cs.active AND cs.boundary IS NOT NULL AND cs.boundary_verification = 'verified' AND l.canonical_place_id IS NOT NULL
  ORDER BY l.canonical_place_id, cs.boundary_verified_at DESC NULLS LAST
) s
WHERE cp.id = s.canonical_place_id AND cp.boundary IS NULL;

SELECT public.stage_canonical_boundary_for_siblings(cp.id, NULL)
FROM public.canonical_places cp
WHERE cp.boundary IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.locations l JOIN public.client_sites s ON s.location_id = l.id
              WHERE l.canonical_place_id = cp.id AND s.active AND s.boundary IS NULL);
