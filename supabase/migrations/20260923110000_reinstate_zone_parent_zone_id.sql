-- Reinstates location_zones.parent_zone_id, removed 2026-09-15 without lineage
-- access (docs/canon/LOCATION_HOUSE_MODEL.md "Ruling correction 2026-09-23").
-- The lineage prototype (DonSquires/FreedomCamp-Manager) proved this exact
-- same-organisation zone-hierarchy pattern (zone_type general/specific) for
-- a broad estate containing many named sub-areas - the real shape of R&M's
-- forestry clients' named forest blocks (e.g. OFO's "Golden Downs Forest"
-- contains "Te Hepe", "Berrymans", "Cains", ...). Grouping/reporting only -
-- deliberately NOT wired into resolve_context/geofence containment.
ALTER TABLE public.location_zones ADD COLUMN IF NOT EXISTS parent_zone_id uuid REFERENCES public.location_zones(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.location_zones.parent_zone_id IS 'Optional same-organisation parent zone for reporting/attribution (e.g. a named forest sub-block''s parent estate). Never crosses organization_id. Not used by resolve_context/geofence containment - see docs/canon/LOCATION_HOUSE_MODEL.md "Ruling correction 2026-09-23".';

CREATE OR REPLACE FUNCTION public.trg_location_zones_parent_same_org() RETURNS trigger
LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.parent_zone_id IS NOT NULL THEN
    IF NEW.parent_zone_id = NEW.id THEN
      RAISE EXCEPTION 'A zone cannot be its own parent';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.location_zones p
      WHERE p.id = NEW.parent_zone_id AND p.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'parent_zone_id must reference a zone owned by the same organisation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zz_location_zones_parent_same_org ON public.location_zones;
CREATE TRIGGER zz_location_zones_parent_same_org
  BEFORE INSERT OR UPDATE OF parent_zone_id ON public.location_zones
  FOR EACH ROW EXECUTE FUNCTION public.trg_location_zones_parent_same_org();

CREATE INDEX IF NOT EXISTS idx_location_zones_parent_zone_id ON public.location_zones (parent_zone_id) WHERE parent_zone_id IS NOT NULL;
