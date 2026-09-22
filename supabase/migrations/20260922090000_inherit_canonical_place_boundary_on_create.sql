-- Pre-seeded canonical places actually pay off: when a new site or zone hangs off a
-- location house whose canonical_place already carries a boundary (e.g. seeded from a
-- verified council GIS source via geo_source_registry, or simply left behind by an
-- earlier site/zone at the same place), stage that shape as an open boundary proposal
-- on the new entity instead of leaving it geometry-less. This does NOT bypass human
-- review (GEOFENCE_PRINCIPLES P1/P2) — propose_boundary still stages it as unverified;
-- a person still accepts, edits, or rejects it on the map like any other proposal.
-- Runs AFTER INSERT (not folded into tg_client_sites_place_house / tg_location_zones_
-- place_house, both BEFORE triggers) because propose_boundary reads the entity back by
-- id, which only exists once the row is actually committed.

CREATE OR REPLACE FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cp record;
BEGIN
  IF NEW.boundary IS NOT NULL OR NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT cp.id AS canonical_place_id, cp.boundary INTO v_cp
  FROM public.locations l JOIN public.canonical_places cp ON cp.id = l.canonical_place_id
  WHERE l.id = NEW.location_id;
  IF v_cp.boundary IS NULL THEN RETURN NEW; END IF;
  BEGIN
    PERFORM public.propose_boundary(
      p_organization_id := NEW.client_organization_id,
      p_entity_type := 'client_site',
      p_entity_id := NEW.id,
      p_geojson := ST_AsGeoJSON(v_cp.boundary)::jsonb,
      p_source := 'canonical_place_inherited',
      p_source_ref := jsonb_build_object('canonical_place_id', v_cp.canonical_place_id),
      p_proposed_via := 'canonical_place_seed'
    );
  EXCEPTION WHEN OTHERS THEN
    -- Never let a pre-seed convenience block the site from being created.
    NULL;
  END;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"() FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"() TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"() TO "anon";
GRANT EXECUTE ON FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"() TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"() TO "service_role";

DROP TRIGGER IF EXISTS "trg_client_sites_inherit_canonical_boundary" ON "public"."client_sites";
CREATE TRIGGER "trg_client_sites_inherit_canonical_boundary"
  AFTER INSERT ON "public"."client_sites"
  FOR EACH ROW EXECUTE FUNCTION "public"."tg_client_sites_inherit_canonical_boundary"();

CREATE OR REPLACE FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_cp record;
BEGIN
  IF NEW.boundary IS NOT NULL OR NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT cp.id AS canonical_place_id, cp.boundary INTO v_cp
  FROM public.locations l JOIN public.canonical_places cp ON cp.id = l.canonical_place_id
  WHERE l.id = NEW.location_id;
  IF v_cp.boundary IS NULL THEN RETURN NEW; END IF;
  BEGIN
    PERFORM public.propose_boundary(
      p_organization_id := NEW.organization_id,
      p_entity_type := 'location_zone',
      p_entity_id := NEW.id,
      p_geojson := ST_AsGeoJSON(v_cp.boundary)::jsonb,
      p_source := 'canonical_place_inherited',
      p_source_ref := jsonb_build_object('canonical_place_id', v_cp.canonical_place_id),
      p_zone_type := NEW.zone_type,
      p_proposed_via := 'canonical_place_seed'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"() FROM PUBLIC, "anon", "authenticated", "service_role";
GRANT EXECUTE ON FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"() TO PUBLIC;
GRANT EXECUTE ON FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"() TO "postgres";
GRANT EXECUTE ON FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"() TO "anon";
GRANT EXECUTE ON FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"() TO "authenticated";
GRANT EXECUTE ON FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"() TO "service_role";

DROP TRIGGER IF EXISTS "trg_location_zones_inherit_canonical_boundary" ON "public"."location_zones";
CREATE TRIGGER "trg_location_zones_inherit_canonical_boundary"
  AFTER INSERT ON "public"."location_zones"
  FOR EACH ROW EXECUTE FUNCTION "public"."tg_location_zones_inherit_canonical_boundary"();
