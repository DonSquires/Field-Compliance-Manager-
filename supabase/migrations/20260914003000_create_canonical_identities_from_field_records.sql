-- Global identity rule: a field record that references a person, place, or
-- vehicle with no canonical record creates that canonical record from the
-- record's own data, with provenance, and is then assigned to it. Attributes
-- the source does not carry stay NULL; nothing is inferred.

CREATE OR REPLACE FUNCTION public.ensure_canonical_vehicle(
  p_plate text,
  p_make text,
  p_model text,
  p_colour text,
  p_source_table text,
  p_source_key text,
  p_observed_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alnum text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
  v_plate text := public.normalize_plate_number(p_plate);
  v_id uuid;
BEGIN
  IF v_plate IS NULL THEN RETURN NULL; END IF;
  -- A plate whose identity would be altered by the 10-char rule is not a valid
  -- vehicle identity; leave the record unlinked rather than assert a truncated one.
  IF length(v_alnum) > 10 THEN RETURN NULL; END IF;

  SELECT id INTO v_id FROM public.canonical_vehicles WHERE plate_number = v_plate;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO public.canonical_vehicles (plate_number, make, model, colour, last_seen_at)
  VALUES (v_plate, p_make, p_model, p_colour, p_observed_at)
  ON CONFLICT (plate_number) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- A concurrent writer created it between the SELECT and the INSERT.
    SELECT id INTO v_id FROM public.canonical_vehicles WHERE plate_number = v_plate;
    RETURN v_id;
  END IF;

  INSERT INTO public.canonical_vehicle_links (canonical_vehicle_id, source_system, source_table, source_key, metadata)
  VALUES (
    v_id, 'field_observation', p_source_table, p_source_key,
    jsonb_build_object('created_from_record', true, 'observed_at', p_observed_at, 'raw_plate', p_plate)
  )
  ON CONFLICT (source_system, source_table, source_key) DO NOTHING;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.ensure_canonical_vehicle(text, text, text, text, text, text, timestamptz) IS
  'Find-or-create the global vehicle identity for a normalized plate. On create, records a canonical_vehicle_links provenance row pointing at the field record that first observed it.';

CREATE OR REPLACE FUNCTION public.ensure_canonical_place_for_projection(
  p_source_table text,
  p_source_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_key text;
  v_name text;
  v_address text;
  v_boundary geometry;
  v_center geometry;
  v_org uuid;
  v_parent uuid;
  v_meta jsonb := '{}'::jsonb;
BEGIN
  IF p_source_id IS NULL THEN RETURN NULL; END IF;

  SELECT canonical_place_id INTO v_id
  FROM public.canonical_place_links
  WHERE source_table = p_source_table AND source_id = p_source_id
  LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  IF p_source_table = 'locations' THEN
    SELECT 'location:' || l.id::text, l.name, l.address, NULL, NULL, l.organization_id, NULL
    INTO v_key, v_name, v_address, v_boundary, v_center, v_org, v_parent
    FROM public.locations l WHERE l.id = p_source_id;
  ELSIF p_source_table = 'client_sites' THEN
    SELECT 'site:' || s.id::text, s.name, s.address,
           CASE WHEN s.boundary IS NULL THEN NULL ELSE ST_Multi(s.boundary) END, s.center_point,
           s.client_organization_id,
           CASE WHEN s.location_id IS NULL THEN NULL ELSE public.ensure_canonical_place_for_projection('locations', s.location_id) END,
           jsonb_build_object('location_id', s.location_id)
    INTO v_key, v_name, v_address, v_boundary, v_center, v_org, v_parent, v_meta
    FROM public.client_sites s WHERE s.id = p_source_id;
  ELSIF p_source_table = 'location_zones' THEN
    SELECT 'zone:' || z.id::text, z.name, z.address,
           CASE WHEN z.boundary IS NULL THEN NULL ELSE ST_Multi(z.boundary) END, z.center_point,
           z.organization_id,
           COALESCE(
             CASE WHEN z.location_id IS NULL THEN NULL ELSE public.ensure_canonical_place_for_projection('locations', z.location_id) END,
             CASE WHEN z.site_id IS NULL THEN NULL ELSE public.ensure_canonical_place_for_projection('client_sites', z.site_id) END
           ),
           jsonb_build_object('location_id', z.location_id, 'site_id', z.site_id)
    INTO v_key, v_name, v_address, v_boundary, v_center, v_org, v_parent, v_meta
    FROM public.location_zones z WHERE z.id = p_source_id;
  ELSE
    RETURN NULL;
  END IF;

  IF v_key IS NULL THEN RETURN NULL; END IF;

  IF v_parent IS NOT NULL THEN
    -- Site/zone facets of an existing house share its canonical identity.
    v_id := v_parent;
  ELSE
    INSERT INTO public.canonical_places (place_kind, canonical_key, display_name, normalized_name, address, boundary, center_point, metadata)
    VALUES (
      'location', v_key, coalesce(v_name, v_key),
      regexp_replace(lower(trim(coalesce(v_name, ''))), '[^a-z0-9]+', '', 'g'),
      v_address, v_boundary, v_center,
      v_meta || jsonb_build_object('created_from', p_source_table, 'source_id', p_source_id)
    )
    ON CONFLICT (canonical_key) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.canonical_places WHERE canonical_key = v_key;
    END IF;
  END IF;

  INSERT INTO public.canonical_place_links (canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata)
  VALUES (v_id, p_source_table, p_source_id, v_org, 'projection', p_source_id::text, v_meta)
  ON CONFLICT (source_table, source_id) DO NOTHING;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.ensure_canonical_place_for_projection(text, uuid) IS
  'Find-or-create the global place identity for a locations/client_sites/location_zones row, mirroring the backfill precedence: a facet with a house links to the house identity.';

CREATE OR REPLACE FUNCTION public.ensure_canonical_person_for_record(p_person_record_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_rec record;
  v_key text;
BEGIN
  IF p_person_record_id IS NULL THEN RETURN NULL; END IF;

  SELECT canonical_person_id INTO v_id
  FROM public.canonical_person_links
  WHERE source_table = 'person_records' AND source_id = p_person_record_id
  LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT id, display_name, organization_id, review_state INTO v_rec
  FROM public.person_records WHERE id = p_person_record_id;
  IF v_rec.id IS NULL THEN RETURN NULL; END IF;

  v_key := 'person_record:' || v_rec.id::text;
  INSERT INTO public.canonical_people (canonical_key, display_name, normalized_name, metadata, review_state)
  VALUES (
    v_key, v_rec.display_name,
    regexp_replace(lower(trim(coalesce(v_rec.display_name, ''))), '[^a-z0-9]+', '', 'g'),
    jsonb_build_object('created_from', 'person_records', 'source_id', v_rec.id, 'source_organization_id', v_rec.organization_id),
    coalesce(v_rec.review_state, 'draft')
  )
  ON CONFLICT (canonical_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.canonical_people WHERE canonical_key = v_key;
  END IF;

  INSERT INTO public.canonical_person_links (canonical_person_id, source_table, source_id, organization_id, link_kind, metadata)
  VALUES (v_id, 'person_records', v_rec.id, v_rec.organization_id, 'projection', jsonb_build_object('review_state', v_rec.review_state))
  ON CONFLICT (source_table, source_id) DO NOTHING;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.ensure_canonical_person_for_record(uuid) IS
  'Find-or-create the global person identity for a tenant-scoped person_records row. Cross-organization merges remain a human review action.';

-- SECURITY DEFINER: the trigger must be able to create canonical rows even when
-- the writing session is an authenticated tenant role with INSERT revoked.
CREATE OR REPLACE FUNCTION public.resolve_record_canonical_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_plate text;
BEGIN
  IF TG_TABLE_NAME = 'observations' THEN
    NEW.canonical_place_id := public.ensure_canonical_place_for_projection(
      CASE WHEN NEW.location_id IS NOT NULL THEN 'locations' WHEN NEW.site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END,
      COALESCE(NEW.location_id, NEW.site_id, NEW.zone_id));
    NEW.canonical_person_id := public.ensure_canonical_person_for_record(NEW.person_record_id);
    v_plate := public.normalize_plate_number(NEW.plate_number);
    SELECT scv.id INTO NEW.canonical_scv_id
    FROM public.canonical_scv scv
    WHERE public.normalize_plate_number(scv.plate_number) = v_plate
    ORDER BY scv.updated_at DESC
    LIMIT 1;
    IF NEW.canonical_vehicle_id IS NULL THEN
      NEW.canonical_vehicle_id := public.ensure_canonical_vehicle(
        NEW.plate_number, NEW.vehicle_make, NEW.vehicle_model, NEW.vehicle_colour,
        'observations', NEW.id::text, NEW.observed_at);
    END IF;
  ELSIF TG_TABLE_NAME = 'parking_chalk_records' THEN
    IF NEW.canonical_vehicle_id IS NULL THEN
      NEW.canonical_vehicle_id := public.ensure_canonical_vehicle(
        NEW.plate, NEW.vehicle_make, NEW.vehicle_model, NEW.vehicle_colour,
        'parking_chalk_records', NEW.id::text, NEW.chalked_at);
    END IF;
  ELSIF TG_TABLE_NAME = 'incidents' THEN
    NEW.canonical_place_id := public.ensure_canonical_place_for_projection(
      CASE WHEN NEW.location_id IS NOT NULL THEN 'locations' WHEN NEW.client_site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END,
      COALESCE(NEW.location_id, NEW.client_site_id, NEW.zone_id));
  ELSIF TG_TABLE_NAME = 'officer_field_reports' THEN
    NEW.canonical_place_id := public.ensure_canonical_place_for_projection(
      CASE WHEN NEW.site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END,
      COALESCE(NEW.site_id, NEW.zone_id));
  ELSE
    NEW.canonical_place_id := public.ensure_canonical_place_for_projection(
      CASE WHEN NEW.client_site_id IS NOT NULL THEN 'client_sites' ELSE 'location_zones' END,
      COALESCE(NEW.client_site_id, NEW.zone_id));
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_canonical_vehicle(text, text, text, text, text, text, timestamptz) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_canonical_place_for_projection(text, uuid) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.ensure_canonical_person_for_record(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_canonical_vehicle(text, text, text, text, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_canonical_place_for_projection(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_canonical_person_for_record(uuid) TO service_role;

-- Backfill through the trigger so history takes the exact live path. Each
-- statement assigns a column to itself; frozen fact values are unchanged, so the
-- observation lock enforcer permits the write.
UPDATE public.observations SET plate_number = plate_number
WHERE canonical_vehicle_id IS NULL AND public.normalize_plate_number(plate_number) IS NOT NULL;

UPDATE public.parking_chalk_records SET plate = plate
WHERE canonical_vehicle_id IS NULL AND public.normalize_plate_number(plate) IS NOT NULL;

UPDATE public.observations SET zone_id = zone_id
WHERE canonical_place_id IS NULL AND COALESCE(location_id, site_id, zone_id) IS NOT NULL;

UPDATE public.observations SET person_record_id = person_record_id
WHERE canonical_person_id IS NULL AND person_record_id IS NOT NULL;
