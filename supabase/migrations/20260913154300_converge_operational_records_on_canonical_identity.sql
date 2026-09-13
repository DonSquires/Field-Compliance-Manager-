-- Converge operational records on persistent global identity while retaining
-- organization/agreement/site/zone context for authorization and work history.

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS canonical_scv_id uuid REFERENCES public.canonical_scv(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS observations_canonical_scv_idx
  ON public.observations(canonical_scv_id, observed_at DESC)
  WHERE canonical_scv_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.resolve_record_canonical_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_scv uuid;
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
    v_plate := NULLIF(trim(NEW.plate_number), '');
    SELECT scv.id INTO NEW.canonical_scv_id
    FROM public.canonical_scv scv
    WHERE upper(trim(scv.plate_number)) = upper(v_plate)
    ORDER BY scv.updated_at DESC
    LIMIT 1;
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

DROP TRIGGER IF EXISTS trg_observations_resolve_canonical_identity ON public.observations;
CREATE TRIGGER trg_observations_resolve_canonical_identity
BEFORE INSERT OR UPDATE OF location_id, site_id, zone_id, person_record_id, plate_number
ON public.observations
FOR EACH ROW EXECUTE FUNCTION public.resolve_record_canonical_identity();

DROP TRIGGER IF EXISTS trg_incidents_resolve_canonical_identity ON public.incidents;
CREATE TRIGGER trg_incidents_resolve_canonical_identity
BEFORE INSERT OR UPDATE OF location_id, client_site_id, zone_id
ON public.incidents
FOR EACH ROW EXECUTE FUNCTION public.resolve_record_canonical_identity();

DROP TRIGGER IF EXISTS trg_officer_field_reports_resolve_canonical_identity ON public.officer_field_reports;
CREATE TRIGGER trg_officer_field_reports_resolve_canonical_identity
BEFORE INSERT OR UPDATE OF site_id, zone_id
ON public.officer_field_reports
FOR EACH ROW EXECUTE FUNCTION public.resolve_record_canonical_identity();

DROP TRIGGER IF EXISTS trg_location_events_resolve_canonical_identity ON public.location_events;
CREATE TRIGGER trg_location_events_resolve_canonical_identity
BEFORE INSERT OR UPDATE OF client_site_id, zone_id
ON public.location_events
FOR EACH ROW EXECUTE FUNCTION public.resolve_record_canonical_identity();

UPDATE public.observations o
SET canonical_place_id = cpl.canonical_place_id
FROM public.canonical_place_links cpl
WHERE o.canonical_place_id IS NULL
  AND cpl.source_table = CASE WHEN o.location_id IS NOT NULL THEN 'locations' WHEN o.site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
  AND cpl.source_id = COALESCE(o.location_id, o.site_id, o.zone_id);

UPDATE public.observations o
SET canonical_person_id = cpl.canonical_person_id
FROM public.canonical_person_links cpl
WHERE o.canonical_person_id IS NULL
  AND cpl.source_table = 'person_records'
  AND cpl.source_id = o.person_record_id;

UPDATE public.observations o
SET canonical_scv_id = scv.id
FROM public.canonical_scv scv
WHERE o.canonical_scv_id IS NULL
  AND upper(trim(scv.plate_number)) = upper(trim(o.plate_number));

UPDATE public.incidents i
SET canonical_place_id = cpl.canonical_place_id
FROM public.canonical_place_links cpl
WHERE i.canonical_place_id IS NULL
  AND cpl.source_table = CASE WHEN i.location_id IS NOT NULL THEN 'locations' WHEN i.client_site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
  AND cpl.source_id = COALESCE(i.location_id, i.client_site_id, i.zone_id);

UPDATE public.officer_field_reports r
SET canonical_place_id = cpl.canonical_place_id
FROM public.canonical_place_links cpl
WHERE r.canonical_place_id IS NULL
  AND cpl.source_table = CASE WHEN r.site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
  AND cpl.source_id = COALESCE(r.site_id, r.zone_id);

UPDATE public.location_events e
SET canonical_place_id = cpl.canonical_place_id
FROM public.canonical_place_links cpl
WHERE e.canonical_place_id IS NULL
  AND cpl.source_table = CASE WHEN e.client_site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END
  AND cpl.source_id = COALESCE(e.client_site_id, e.zone_id);

COMMENT ON COLUMN public.observations.canonical_place_id IS 'Persistent global place identity; organization/site/zone fields retain access and operational context.';
COMMENT ON COLUMN public.observations.canonical_person_id IS 'Persistent global person identity; person_record_id remains the tenant-scoped projection.';
COMMENT ON COLUMN public.observations.canonical_scv_id IS 'Global SCV registry identity matched by plate; observations retain their original operational context.';
