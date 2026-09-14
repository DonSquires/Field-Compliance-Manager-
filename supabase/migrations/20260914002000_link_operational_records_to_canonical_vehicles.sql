-- Link operational records to the global canonical vehicle identity by
-- normalized plate. Vehicle history must follow the vehicle regardless of
-- which organization or module recorded it. The observation lock triggers
-- only guard frozen fact fields, so setting canonical_vehicle_id on locked
-- rows is a permitted derived-link write.

CREATE OR REPLACE FUNCTION public.normalize_plate_number(p_plate text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT NULLIF(left(upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g')), 10), '');
$$;

COMMENT ON FUNCTION public.normalize_plate_number(text) IS
  'Single plate identity rule shared with apps/web/src/lib/canonicalIdentity.ts and process-officer-scan: trim, uppercase, strip non-alphanumerics, max 10 chars.';

ALTER TABLE public.parking_chalk_records
  ADD COLUMN IF NOT EXISTS canonical_vehicle_id uuid REFERENCES public.canonical_vehicles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_parking_chalk_records_canonical_vehicle
  ON public.parking_chalk_records (organization_id, canonical_vehicle_id, chalked_at DESC)
  WHERE canonical_vehicle_id IS NOT NULL;

COMMENT ON COLUMN public.parking_chalk_records.canonical_vehicle_id IS
  'Persistent global vehicle identity resolved from plate; plate/organization fields retain the operational record context.';

CREATE OR REPLACE FUNCTION public.resolve_record_canonical_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_plate text;
BEGIN
  IF TG_TABLE_NAME = 'observations' THEN
    SELECT cpl.canonical_place_id INTO NEW.canonical_place_id
    FROM public.canonical_place_links cpl
    WHERE cpl.source_table = CASE WHEN NEW.location_id IS NOT NULL THEN 'locations' WHEN NEW.site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
      AND cpl.source_id = COALESCE(NEW.location_id, NEW.site_id, NEW.zone_id)
    LIMIT 1;
    SELECT cpl.canonical_person_id INTO NEW.canonical_person_id
    FROM public.canonical_person_links cpl
    WHERE cpl.source_table = 'person_records' AND cpl.source_id = NEW.person_record_id
    LIMIT 1;
    v_plate := public.normalize_plate_number(NEW.plate_number);
    SELECT scv.id INTO NEW.canonical_scv_id
    FROM public.canonical_scv scv
    WHERE public.normalize_plate_number(scv.plate_number) = v_plate
    ORDER BY scv.updated_at DESC
    LIMIT 1;
    IF NEW.canonical_vehicle_id IS NULL THEN
      SELECT cv.id INTO NEW.canonical_vehicle_id
      FROM public.canonical_vehicles cv
      WHERE cv.plate_number = v_plate
      LIMIT 1;
    END IF;
  ELSIF TG_TABLE_NAME = 'parking_chalk_records' THEN
    IF NEW.canonical_vehicle_id IS NULL THEN
      SELECT cv.id INTO NEW.canonical_vehicle_id
      FROM public.canonical_vehicles cv
      WHERE cv.plate_number = public.normalize_plate_number(NEW.plate)
      LIMIT 1;
    END IF;
  ELSIF TG_TABLE_NAME = 'incidents' THEN
    SELECT cpl.canonical_place_id INTO NEW.canonical_place_id
    FROM public.canonical_place_links cpl
    WHERE cpl.source_table = CASE WHEN NEW.location_id IS NOT NULL THEN 'locations' WHEN NEW.client_site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
      AND cpl.source_id = COALESCE(NEW.location_id, NEW.client_site_id, NEW.zone_id)
    LIMIT 1;
  ELSIF TG_TABLE_NAME = 'officer_field_reports' THEN
    SELECT cpl.canonical_place_id INTO NEW.canonical_place_id
    FROM public.canonical_place_links cpl
    WHERE cpl.source_table = CASE WHEN NEW.site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
      AND cpl.source_id = COALESCE(NEW.site_id, NEW.zone_id)
    LIMIT 1;
  ELSE
    SELECT cpl.canonical_place_id INTO NEW.canonical_place_id
    FROM public.canonical_place_links cpl
    WHERE cpl.source_table = CASE WHEN NEW.client_site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
      AND cpl.source_id = COALESCE(NEW.client_site_id, NEW.zone_id)
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_parking_chalk_records_resolve_canonical_identity ON public.parking_chalk_records;
CREATE TRIGGER trg_parking_chalk_records_resolve_canonical_identity
BEFORE INSERT OR UPDATE OF plate
ON public.parking_chalk_records
FOR EACH ROW EXECUTE FUNCTION public.resolve_record_canonical_identity();

-- Backfill: only the derived link column changes, so frozen-fact lock checks pass.
UPDATE public.observations o
SET canonical_vehicle_id = cv.id
FROM public.canonical_vehicles cv
WHERE o.canonical_vehicle_id IS NULL
  AND cv.plate_number = public.normalize_plate_number(o.plate_number);

UPDATE public.parking_chalk_records p
SET canonical_vehicle_id = cv.id
FROM public.canonical_vehicles cv
WHERE p.canonical_vehicle_id IS NULL
  AND cv.plate_number = public.normalize_plate_number(p.plate);

COMMENT ON COLUMN public.observations.canonical_vehicle_id IS
  'Persistent global vehicle identity resolved from normalized plate at write time; organization/zone fields retain access and operational context.';
