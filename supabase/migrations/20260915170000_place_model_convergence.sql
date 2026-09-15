-- Place-model convergence (owner ruling 2026-09-15, recorded in docs/canon/LOCATION_HOUSE_MODEL.md).
--
--   * canonical_places is THE place registry: one row per real-world place, permanent, searchable by
--     anyone. place_kind is 'site' (a literal address / LINZ lot) or 'zone' (an area: a street, beach,
--     river). A site is keyed by its address so the same address in two organisations is ONE place.
--   * locations is an organisation's house = its link to a registry place. Sites (client_sites) and
--     zones (location_zones) are SIBLING facets under the house; neither hangs off the other.
--   * Every facet has a house. Every house has a canonical place. Facets inherit the house identity.
--   * Places are never deleted: retire or merge them. Deletion is blocked for everyone except the
--     test-dataset purge (GUC app.place_delete_scope) and a service/admin rollback of a row it created
--     in the last 15 minutes.
--   * One address key rule everywhere: public.address_match_key(text).
--
-- Removed as duplicates of the same fact: location_zones.site_id / parent_zone_id / boundary_legacy /
-- repeat_stay_radius_meters / address / suburb / postcode / address_match_key, the client_site_zones
-- table, and get_zone_for_gps (a P1-violating duplicate of resolve_context). client_sites.gps_lat/gps_lng
-- are kept for existing readers but are now derived from center_point by trigger.

-- ───────────────────────────── 0. single address key rule ─────────────────────────────
CREATE OR REPLACE FUNCTION public.address_match_key(p_address text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NULLIF(regexp_replace(lower(trim(coalesce(p_address, ''))), '[^a-z0-9]+', '', 'g'), '')
$$;
COMMENT ON FUNCTION public.address_match_key(text) IS
  'The single address dedup key: lowercase, every non-alphanumeric run removed. Used by triggers on locations/client_sites; edge code mirrors it.';

-- ───────────────────────────── 1. registry shape ─────────────────────────────
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid REFERENCES public.canonical_places(id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_locations_canonical_place ON public.locations (canonical_place_id);

ALTER TABLE public.canonical_places DROP CONSTRAINT IF EXISTS canonical_places_place_kind_check;

-- Find-or-create a registry place by key. Follows merges so a merged key resolves to its survivor.
CREATE OR REPLACE FUNCTION public.ensure_canonical_place(p_kind text, p_key text, p_name text, p_address text, p_meta jsonb DEFAULT '{}'::jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_into uuid; v_status text; v_hops integer := 0;
BEGIN
  IF p_key IS NULL OR p_kind NOT IN ('site', 'zone') THEN RETURN NULL; END IF;
  INSERT INTO public.canonical_places (place_kind, canonical_key, display_name, normalized_name, address, metadata)
  VALUES (p_kind, p_key, coalesce(nullif(trim(p_name), ''), p_address, p_key),
          regexp_replace(lower(trim(coalesce(p_name, ''))), '[^a-z0-9]+', '', 'g'), p_address, coalesce(p_meta, '{}'::jsonb))
  ON CONFLICT (canonical_key) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id, status, merged_into_id INTO v_id, v_status, v_into FROM public.canonical_places WHERE canonical_key = p_key;
    WHILE v_status = 'merged' AND v_into IS NOT NULL AND v_hops < 10 LOOP
      SELECT id, status, merged_into_id INTO v_id, v_status, v_into FROM public.canonical_places WHERE id = v_into;
      v_hops := v_hops + 1;
    END LOOP;
  END IF;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.ensure_canonical_place(text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- Identity of a house: site:<address key> when it has an address; otherwise <kind>:<house id>, where the
-- kind is the facet that created it (a site without an address is still a site, not an area).
CREATE OR REPLACE FUNCTION public.canonical_place_for_house(p_location_id uuid, p_org uuid, p_name text, p_address text, p_key text, p_kind_hint text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid; v_kind text;
BEGIN
  IF p_location_id IS NULL THEN RETURN NULL; END IF;
  v_kind := CASE WHEN p_key IS NOT NULL THEN 'site' WHEN p_kind_hint IN ('site', 'zone') THEN p_kind_hint ELSE 'zone' END;
  v_id := CASE WHEN p_key IS NOT NULL
    THEN public.ensure_canonical_place('site', 'site:' || p_key, p_name, p_address, jsonb_build_object('created_from', 'locations', 'source_id', p_location_id))
    ELSE public.ensure_canonical_place(v_kind, v_kind || ':' || p_location_id::text, p_name, NULL, jsonb_build_object('created_from', 'locations', 'source_id', p_location_id)) END;
  INSERT INTO public.canonical_place_links (canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata)
  VALUES (v_id, 'locations', p_location_id, p_org, 'projection', p_location_id::text, '{}'::jsonb)
  ON CONFLICT (source_table, source_id) DO UPDATE SET canonical_place_id = EXCLUDED.canonical_place_id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.canonical_place_for_house(uuid, uuid, text, text, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.ensure_canonical_place_for_house(p_location_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_house public.locations%rowtype; v_id uuid;
BEGIN
  SELECT * INTO v_house FROM public.locations WHERE id = p_location_id;
  IF v_house.id IS NULL THEN RETURN NULL; END IF;
  IF v_house.canonical_place_id IS NOT NULL THEN RETURN v_house.canonical_place_id; END IF;
  v_id := public.canonical_place_for_house(v_house.id, v_house.organization_id, v_house.name, v_house.address, v_house.address_match_key,
    CASE WHEN EXISTS (SELECT 1 FROM public.client_sites s WHERE s.location_id = v_house.id) THEN 'site' ELSE 'zone' END);
  UPDATE public.locations SET canonical_place_id = v_id, updated_at = now() WHERE id = v_house.id;
  RETURN v_id;
END $$;
REVOKE ALL ON FUNCTION public.ensure_canonical_place_for_house(uuid) FROM PUBLIC, anon, authenticated;

-- Converge two registry rows that are the same place. Nothing is deleted: the loser is marked merged
-- and every reference is re-pointed at the survivor.
CREATE OR REPLACE FUNCTION public.merge_canonical_place(p_from uuid, p_into uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_from IS NULL OR p_into IS NULL OR p_from = p_into THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.canonical_places WHERE id = p_into AND status <> 'merged') THEN
    RAISE EXCEPTION 'Merge target % is not an active canonical place', p_into;
  END IF;
  UPDATE public.observations SET canonical_place_id = p_into WHERE canonical_place_id = p_from;
  UPDATE public.incidents SET canonical_place_id = p_into WHERE canonical_place_id = p_from;
  UPDATE public.location_events SET canonical_place_id = p_into WHERE canonical_place_id = p_from;
  UPDATE public.officer_field_reports SET canonical_place_id = p_into WHERE canonical_place_id = p_from;
  UPDATE public.canonical_place_links SET canonical_place_id = p_into WHERE canonical_place_id = p_from;
  UPDATE public.locations SET canonical_place_id = p_into, updated_at = now() WHERE canonical_place_id = p_from;
  UPDATE public.canonical_places SET merged_into_id = p_into WHERE merged_into_id = p_from;
  UPDATE public.canonical_places SET status = 'merged', merged_into_id = p_into, updated_at = now() WHERE id = p_from;
END $$;
REVOKE ALL ON FUNCTION public.merge_canonical_place(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.merge_canonical_place(uuid, uuid) TO service_role;

-- ───────────────────────────── 2. data: keys, houses, registry re-key ─────────────────────────────
-- Runs before the triggers exist so every step is explicit and verifiable.
UPDATE public.locations SET address = nullif(trim(address), '') WHERE address IS NOT NULL AND address <> nullif(trim(address), '');
UPDATE public.locations SET address_match_key = public.address_match_key(address)
 WHERE address IS NOT NULL AND address_match_key IS DISTINCT FROM public.address_match_key(address);
UPDATE public.client_sites SET address = nullif(trim(address), '') WHERE address IS NOT NULL AND address <> nullif(trim(address), '');
UPDATE public.client_sites SET address_match_key = public.address_match_key(address)
 WHERE address IS NOT NULL AND address_match_key IS DISTINCT FROM public.address_match_key(address);

DO $$
DECLARE r record; v_house uuid; v_canon uuid; v_key text; v_target text; v_kind text; v_holder uuid; v_hstatus text; v_hinto uuid; v_hops integer;
BEGIN
  -- Sites already on a house stay there: where their address keys differ it is almost always the same
  -- address at a different precision ("37 Halifax Street" vs "37 Halifax Street, Nelson 7010"), and
  -- re-homing on the key alone would manufacture duplicate houses.

  -- 2b. Houseless sites: find the owner's house by address key, else create one. The site's existing
  --     registry row (site:<uuid>) becomes the house's registry row so its identity is preserved.
  FOR r IN
    SELECT s.id, s.client_organization_id AS org, s.name, s.address, s.address_match_key AS key
    FROM public.client_sites s WHERE s.location_id IS NULL ORDER BY s.created_at
  LOOP
    v_house := NULL;
    IF r.key IS NOT NULL THEN
      SELECT id INTO v_house FROM public.locations WHERE organization_id = r.org AND address_match_key = r.key ORDER BY created_at LIMIT 1;
    END IF;
    IF v_house IS NULL THEN
      INSERT INTO public.locations (organization_id, name, address, address_match_key, notes)
      VALUES (r.org, coalesce(nullif(trim(r.name), ''), r.address, 'Unnamed place'), r.address, r.key, 'House created by place-model convergence for an existing site.')
      RETURNING id INTO v_house;
      SELECT canonical_place_id INTO v_canon FROM public.canonical_place_links WHERE source_table = 'client_sites' AND source_id = r.id;
      IF v_canon IS NOT NULL THEN
        INSERT INTO public.canonical_place_links (canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata)
        VALUES (v_canon, 'locations', v_house, r.org, 'projection', v_house::text, '{}'::jsonb)
        ON CONFLICT (source_table, source_id) DO NOTHING;
      END IF;
    END IF;
    UPDATE public.client_sites SET location_id = v_house WHERE id = r.id;
  END LOOP;

  -- 2c. Houseless zones: the zone's own registry row (zone:<uuid>) becomes its new house's row.
  FOR r IN SELECT z.id, z.organization_id AS org, z.name FROM public.location_zones z WHERE z.location_id IS NULL LOOP
    SELECT id INTO v_house FROM public.locations WHERE organization_id = r.org AND lower(name) = lower(r.name) ORDER BY created_at LIMIT 1;
    IF v_house IS NULL THEN
      INSERT INTO public.locations (organization_id, name, notes)
      VALUES (r.org, r.name, 'House created by place-model convergence for an existing zone.')
      RETURNING id INTO v_house;
      SELECT canonical_place_id INTO v_canon FROM public.canonical_place_links WHERE source_table = 'location_zones' AND source_id = r.id;
      IF v_canon IS NOT NULL THEN
        INSERT INTO public.canonical_place_links (canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata)
        VALUES (v_canon, 'locations', v_house, r.org, 'projection', v_house::text, '{}'::jsonb)
        ON CONFLICT (source_table, source_id) DO NOTHING;
      END IF;
    END IF;
    UPDATE public.location_zones SET location_id = v_house WHERE id = r.id;
  END LOOP;

  -- 2d. Every house gets its registry identity. An existing row is re-keyed in place (uuid kept);
  --     when the target key is already held by another row the two are the same place: merge.
  FOR r IN
    SELECT l.id, l.organization_id AS org, l.name, l.address, l.address_match_key AS key,
           EXISTS (SELECT 1 FROM public.client_sites s WHERE s.location_id = l.id) AS has_site
    FROM public.locations l ORDER BY l.created_at
  LOOP
    v_kind := CASE WHEN r.key IS NOT NULL OR r.has_site THEN 'site' ELSE 'zone' END;
    v_target := CASE WHEN r.key IS NOT NULL THEN 'site:' || r.key ELSE v_kind || ':' || r.id::text END;
    SELECT k.canonical_place_id INTO v_canon FROM public.canonical_place_links k WHERE k.source_table = 'locations' AND k.source_id = r.id;
    IF v_canon IS NOT NULL THEN
      SELECT id, status, merged_into_id INTO v_holder, v_hstatus, v_hinto
        FROM public.canonical_places WHERE canonical_key = v_target AND id <> v_canon;
      v_hops := 0;
      WHILE v_holder IS NOT NULL AND v_hstatus = 'merged' AND v_hinto IS NOT NULL AND v_hops < 10 LOOP
        SELECT id, status, merged_into_id INTO v_holder, v_hstatus, v_hinto FROM public.canonical_places WHERE id = v_hinto;
        v_hops := v_hops + 1;
      END LOOP;
      IF v_holder IS NULL THEN
        UPDATE public.canonical_places SET canonical_key = v_target, place_kind = v_kind,
          address = coalesce(address, r.address), display_name = coalesce(nullif(display_name, ''), r.name), updated_at = now()
        WHERE id = v_canon;
      ELSIF v_holder <> v_canon THEN
        PERFORM public.merge_canonical_place(v_canon, v_holder);
        v_canon := v_holder;
      END IF;
    ELSE
      v_canon := public.canonical_place_for_house(r.id, r.org, r.name, r.address, r.key, v_kind);
    END IF;
    UPDATE public.locations SET canonical_place_id = v_canon WHERE id = r.id;
  END LOOP;

  -- 2e. Facet links follow their house.
  UPDATE public.canonical_place_links k SET canonical_place_id = l.canonical_place_id
  FROM public.client_sites s JOIN public.locations l ON l.id = s.location_id
  WHERE k.source_table = 'client_sites' AND k.source_id = s.id AND k.canonical_place_id <> l.canonical_place_id;
  UPDATE public.canonical_place_links k SET canonical_place_id = l.canonical_place_id
  FROM public.location_zones z JOIN public.locations l ON l.id = z.location_id
  WHERE k.source_table = 'location_zones' AND k.source_id = z.id AND k.canonical_place_id <> l.canonical_place_id;
  INSERT INTO public.canonical_place_links (canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata)
  SELECT l.canonical_place_id, 'client_sites', s.id, s.client_organization_id, 'projection', s.id::text, '{}'::jsonb
  FROM public.client_sites s JOIN public.locations l ON l.id = s.location_id
  ON CONFLICT (source_table, source_id) DO NOTHING;
  INSERT INTO public.canonical_place_links (canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata)
  SELECT l.canonical_place_id, 'location_zones', z.id, z.organization_id, 'projection', z.id::text, '{}'::jsonb
  FROM public.location_zones z JOIN public.locations l ON l.id = z.location_id
  ON CONFLICT (source_table, source_id) DO NOTHING;

  -- 2f. Registry rows that no house points at any more (their facets moved) become merged into the
  --     row their facets now use, or are retired when nothing references them.
  FOR r IN
    SELECT cp.id FROM public.canonical_places cp
    WHERE cp.status = 'active' AND NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.canonical_place_id = cp.id)
  LOOP
    SELECT l.canonical_place_id INTO v_holder
    FROM public.canonical_place_links k
    JOIN public.client_sites s ON k.source_table = 'client_sites' AND k.source_id = s.id
    JOIN public.locations l ON l.id = s.location_id
    WHERE k.canonical_place_id = r.id LIMIT 1;
    IF v_holder IS NOT NULL AND v_holder <> r.id THEN
      PERFORM public.merge_canonical_place(r.id, v_holder);
    ELSIF NOT EXISTS (SELECT 1 FROM public.observations WHERE canonical_place_id = r.id)
      AND NOT EXISTS (SELECT 1 FROM public.canonical_place_links WHERE canonical_place_id = r.id) THEN
      UPDATE public.canonical_places SET status = 'retired', updated_at = now() WHERE id = r.id;
    END IF;
  END LOOP;

  -- 2g. Registry rows keep a point/boundary from their facets so the registry is searchable on a map.
  UPDATE public.canonical_places cp SET
    center_point = coalesce(cp.center_point, f.center_point),
    boundary = coalesce(cp.boundary, f.boundary),
    updated_at = now()
  FROM (
    SELECT l.canonical_place_id AS id,
      (array_remove(array_agg(coalesce(s.center_point, z.center_point) ORDER BY s.created_at), NULL))[1] AS center_point,
      (array_remove(array_agg(CASE WHEN s.boundary IS NOT NULL THEN ST_Multi(s.boundary) WHEN z.boundary IS NOT NULL THEN ST_Multi(z.boundary) END ORDER BY s.created_at), NULL))[1] AS boundary
    FROM public.locations l
    LEFT JOIN public.client_sites s ON s.location_id = l.id
    LEFT JOIN public.location_zones z ON z.location_id = l.id
    GROUP BY l.canonical_place_id
  ) f
  WHERE f.id = cp.id AND (cp.center_point IS NULL OR cp.boundary IS NULL);
END $$;

-- Known same-place fork (two organisations' Lowburn zones): converge at the registry, delete nothing.
DO $$
DECLARE v_from uuid; v_into uuid;
BEGIN
  SELECT l.canonical_place_id INTO v_into FROM public.location_zones z JOIN public.locations l ON l.id = z.location_id
   WHERE z.id = 'd496626f-9429-4893-9891-43dd6c652b8d';
  SELECT l.canonical_place_id INTO v_from FROM public.location_zones z JOIN public.locations l ON l.id = z.location_id
   WHERE z.id = '27067e15-65a0-48f0-8e29-fa93d7ac1539';
  IF v_from IS NOT NULL AND v_into IS NOT NULL AND v_from <> v_into THEN
    PERFORM public.merge_canonical_place(v_from, v_into);
  END IF;
END $$;

UPDATE public.canonical_places SET place_kind = CASE WHEN canonical_key LIKE 'site:%' THEN 'site' ELSE 'zone' END
 WHERE place_kind IS DISTINCT FROM CASE WHEN canonical_key LIKE 'site:%' THEN 'site' ELSE 'zone' END;
ALTER TABLE public.canonical_places
  ADD CONSTRAINT canonical_places_place_kind_check CHECK (place_kind IN ('site', 'zone'));

-- ───────────────────────────── 3. invariants ─────────────────────────────
ALTER TABLE public.locations ALTER COLUMN canonical_place_id SET NOT NULL;
ALTER TABLE public.client_sites ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE public.location_zones ALTER COLUMN location_id SET NOT NULL;

ALTER TABLE public.client_sites DROP CONSTRAINT IF EXISTS client_sites_location_id_fkey;
ALTER TABLE public.client_sites ADD CONSTRAINT client_sites_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;
ALTER TABLE public.location_zones DROP CONSTRAINT IF EXISTS location_zones_location_id_fkey;
ALTER TABLE public.location_zones ADD CONSTRAINT location_zones_location_id_fkey
  FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS public.idx_locations_org_match_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_locations_org_address_key
  ON public.locations (organization_id, address_match_key) WHERE address_match_key IS NOT NULL;

-- ───────────────────────────── 4. remove the duplicates ─────────────────────────────
DROP VIEW IF EXISTS public.module_rule_index_view;
DROP FUNCTION IF EXISTS public.get_zone_for_gps(double precision, double precision, uuid);
DROP FUNCTION IF EXISTS public.zones_for_site(uuid);
DROP TABLE IF EXISTS public.client_site_zones;
ALTER TABLE public.location_zones
  DROP COLUMN IF EXISTS site_id,
  DROP COLUMN IF EXISTS parent_zone_id,
  DROP COLUMN IF EXISTS boundary_legacy,
  DROP COLUMN IF EXISTS repeat_stay_radius_meters,
  DROP COLUMN IF EXISTS address,
  DROP COLUMN IF EXISTS suburb,
  DROP COLUMN IF EXISTS postcode,
  DROP COLUMN IF EXISTS address_match_key;

-- ───────────────────────────── 5. triggers: identity on write ─────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_locations_place_identity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.address := nullif(trim(NEW.address), '');
  IF NEW.address IS NOT NULL THEN
    NEW.address_match_key := public.address_match_key(NEW.address);
  ELSIF NEW.address_match_key IS NOT NULL THEN
    NEW.address_match_key := public.address_match_key(NEW.address_match_key);
  END IF;
  IF NEW.canonical_place_id IS NULL
     OR (TG_OP = 'UPDATE' AND NEW.address_match_key IS DISTINCT FROM OLD.address_match_key AND NEW.address_match_key IS NOT NULL) THEN
    NEW.canonical_place_id := public.canonical_place_for_house(NEW.id, NEW.organization_id, NEW.name, NEW.address, NEW.address_match_key,
      CASE WHEN TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM public.client_sites s WHERE s.location_id = NEW.id) THEN 'site' ELSE 'zone' END);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_locations_place_identity ON public.locations;
CREATE TRIGGER zz_locations_place_identity BEFORE INSERT OR UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.tg_locations_place_identity();

-- A facet always has a house in its owner organisation; a missing one is found by address key (sites)
-- or name (zones), else created. A facet never hangs off another organisation's house.
CREATE OR REPLACE FUNCTION public.tg_client_sites_place_house()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_owner uuid := coalesce(NEW.client_organization_id, NEW.organization_id); v_house_org uuid; v_house uuid;
BEGIN
  NEW.address := nullif(trim(NEW.address), '');
  IF NEW.address IS NOT NULL THEN
    NEW.address_match_key := public.address_match_key(NEW.address);
  ELSIF NEW.address_match_key IS NOT NULL THEN
    NEW.address_match_key := public.address_match_key(NEW.address_match_key);
  END IF;
  -- center_point is the one geometry fact; gps_lat/gps_lng are a derived view of it kept for old readers.
  IF NEW.gps_lat IS NOT NULL AND NEW.gps_lng IS NOT NULL AND (
       NEW.center_point IS NULL
       OR (TG_OP = 'UPDATE' AND (NEW.gps_lat IS DISTINCT FROM OLD.gps_lat OR NEW.gps_lng IS DISTINCT FROM OLD.gps_lng)
           AND NEW.center_point IS NOT DISTINCT FROM OLD.center_point)) THEN
    NEW.center_point := ST_SetSRID(ST_MakePoint(NEW.gps_lng, NEW.gps_lat), 4326);
  END IF;
  IF NEW.center_point IS NOT NULL THEN
    NEW.gps_lat := ST_Y(NEW.center_point::geometry);
    NEW.gps_lng := ST_X(NEW.center_point::geometry);
  END IF;
  IF NEW.location_id IS NULL AND v_owner IS NOT NULL THEN
    IF NEW.address_match_key IS NOT NULL THEN
      SELECT id INTO NEW.location_id FROM public.locations
       WHERE organization_id = v_owner AND address_match_key = NEW.address_match_key ORDER BY created_at LIMIT 1;
    ELSIF NEW.name IS NOT NULL THEN
      SELECT id INTO NEW.location_id FROM public.locations
       WHERE organization_id = v_owner AND lower(name) = lower(NEW.name) ORDER BY created_at LIMIT 1;
    END IF;
    IF NEW.location_id IS NULL THEN
      v_house := gen_random_uuid();
      INSERT INTO public.locations (id, organization_id, name, address, address_match_key, created_by, canonical_place_id)
      VALUES (v_house, v_owner, coalesce(nullif(trim(NEW.name), ''), NEW.address, 'Unnamed place'), NEW.address, NEW.address_match_key,
              (SELECT up.id FROM public.user_profiles up WHERE up.id = auth.uid()),
              public.canonical_place_for_house(v_house, v_owner, coalesce(nullif(trim(NEW.name), ''), NEW.address, 'Unnamed place'), NEW.address, NEW.address_match_key, 'site'));
      NEW.location_id := v_house;
    END IF;
  END IF;
  IF NEW.location_id IS NOT NULL THEN
    SELECT organization_id INTO v_house_org FROM public.locations WHERE id = NEW.location_id;
    IF v_house_org IS NULL THEN
      RAISE EXCEPTION 'Location house % does not exist', NEW.location_id;
    END IF;
    IF v_owner IS NOT NULL AND v_house_org <> v_owner THEN
      RAISE EXCEPTION 'Site % cannot hang off a house owned by another organisation', coalesce(NEW.name, NEW.id::text);
    END IF;
    UPDATE public.canonical_places cp SET
      center_point = coalesce(cp.center_point, NEW.center_point),
      boundary = coalesce(cp.boundary, CASE WHEN NEW.boundary IS NULL THEN NULL ELSE ST_Multi(NEW.boundary) END),
      updated_at = now()
    FROM public.locations l
    WHERE l.id = NEW.location_id AND cp.id = l.canonical_place_id
      AND ((cp.center_point IS NULL AND NEW.center_point IS NOT NULL) OR (cp.boundary IS NULL AND NEW.boundary IS NOT NULL));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_client_sites_place_house ON public.client_sites;
CREATE TRIGGER zz_client_sites_place_house BEFORE INSERT OR UPDATE ON public.client_sites
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_sites_place_house();

CREATE OR REPLACE FUNCTION public.tg_location_zones_place_house()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_house_org uuid;
BEGIN
  IF NEW.location_id IS NULL AND NEW.organization_id IS NOT NULL THEN
    IF NEW.name IS NOT NULL THEN
      SELECT id INTO NEW.location_id FROM public.locations
       WHERE organization_id = NEW.organization_id AND lower(name) = lower(NEW.name) ORDER BY created_at LIMIT 1;
    END IF;
    IF NEW.location_id IS NULL THEN
      INSERT INTO public.locations (organization_id, name, created_by)
      VALUES (NEW.organization_id, coalesce(nullif(trim(NEW.name), ''), 'Unnamed zone'), (SELECT up.id FROM public.user_profiles up WHERE up.id = auth.uid()))
      RETURNING id INTO NEW.location_id;
    END IF;
  END IF;
  IF NEW.location_id IS NOT NULL THEN
    SELECT organization_id INTO v_house_org FROM public.locations WHERE id = NEW.location_id;
    IF v_house_org IS NULL THEN
      RAISE EXCEPTION 'Location house % does not exist', NEW.location_id;
    END IF;
    IF NEW.organization_id IS NOT NULL AND v_house_org <> NEW.organization_id THEN
      RAISE EXCEPTION 'Zone % cannot hang off a house owned by another organisation', coalesce(NEW.name, NEW.id::text);
    END IF;
    UPDATE public.canonical_places cp SET
      center_point = coalesce(cp.center_point, NEW.center_point),
      boundary = coalesce(cp.boundary, CASE WHEN NEW.boundary IS NULL THEN NULL ELSE ST_Multi(NEW.boundary) END),
      updated_at = now()
    FROM public.locations l
    WHERE l.id = NEW.location_id AND cp.id = l.canonical_place_id
      AND ((cp.center_point IS NULL AND NEW.center_point IS NOT NULL) OR (cp.boundary IS NULL AND NEW.boundary IS NOT NULL));
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zz_location_zones_place_house ON public.location_zones;
CREATE TRIGGER zz_location_zones_place_house BEFORE INSERT OR UPDATE ON public.location_zones
  FOR EACH ROW EXECUTE FUNCTION public.tg_location_zones_place_house();

-- ───────────────────────────── 6. permanence ─────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_place_permanence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('app.place_delete_scope', true) = 'test_dataset_purge' THEN RETURN OLD; END IF;
  -- A service or admin session may roll back a row it created moments ago (proposal compensation).
  IF (auth.role() = 'service_role' OR session_user IN ('postgres', 'supabase_admin'))
     AND OLD.created_at > clock_timestamp() - interval '15 minutes' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Places are permanent: %.% cannot be deleted. Retire or merge it instead.', TG_TABLE_NAME, OLD.id
    USING ERRCODE = 'P0001', HINT = 'docs/canon/LOCATION_HOUSE_MODEL.md, ruling 2026-09-15';
END $$;
DROP TRIGGER IF EXISTS zz_place_permanence ON public.locations;
CREATE TRIGGER zz_place_permanence BEFORE DELETE ON public.locations FOR EACH ROW EXECUTE FUNCTION public.tg_place_permanence();
DROP TRIGGER IF EXISTS zz_place_permanence ON public.client_sites;
CREATE TRIGGER zz_place_permanence BEFORE DELETE ON public.client_sites FOR EACH ROW EXECUTE FUNCTION public.tg_place_permanence();
DROP TRIGGER IF EXISTS zz_place_permanence ON public.location_zones;
CREATE TRIGGER zz_place_permanence BEFORE DELETE ON public.location_zones FOR EACH ROW EXECUTE FUNCTION public.tg_place_permanence();
DROP TRIGGER IF EXISTS zz_place_permanence ON public.canonical_places;
CREATE TRIGGER zz_place_permanence BEFORE DELETE ON public.canonical_places FOR EACH ROW EXECUTE FUNCTION public.tg_place_permanence();

REVOKE DELETE, TRUNCATE ON public.locations, public.client_sites, public.location_zones, public.canonical_places, public.canonical_place_links
  FROM anon, authenticated;
DROP POLICY IF EXISTS locations_delete ON public.locations;
DROP POLICY IF EXISTS location_zones_delete ON public.location_zones;

-- ───────────────────────────── 7. re-issue dependents ─────────────────────────────
-- Facets project their house's registry identity.
CREATE OR REPLACE FUNCTION public.ensure_canonical_place_for_projection(p_source_table text, p_source_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_house uuid; v_org uuid; v_id uuid;
BEGIN
  IF p_source_id IS NULL THEN RETURN NULL; END IF;
  IF p_source_table = 'locations' THEN
    v_house := p_source_id;
  ELSIF p_source_table = 'client_sites' THEN
    SELECT location_id, client_organization_id INTO v_house, v_org FROM public.client_sites WHERE id = p_source_id;
  ELSIF p_source_table = 'location_zones' THEN
    SELECT location_id, organization_id INTO v_house, v_org FROM public.location_zones WHERE id = p_source_id;
  ELSE
    RETURN NULL;
  END IF;
  IF v_house IS NULL THEN RETURN NULL; END IF;
  SELECT canonical_place_id INTO v_id FROM public.locations WHERE id = v_house;
  IF v_id IS NULL THEN v_id := public.ensure_canonical_place_for_house(v_house); END IF;
  IF v_id IS NULL THEN RETURN NULL; END IF;
  IF p_source_table <> 'locations' THEN
    INSERT INTO public.canonical_place_links (canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata)
    VALUES (v_id, p_source_table, p_source_id, v_org, 'projection', p_source_id::text, jsonb_build_object('location_id', v_house))
    ON CONFLICT (source_table, source_id) DO UPDATE SET canonical_place_id = EXCLUDED.canonical_place_id;
  END IF;
  RETURN v_id;
END $$;

-- Sibling zones under the same house as a site.
CREATE FUNCTION public.zones_for_site(p_site_id uuid)
RETURNS TABLE(zone_id uuid, zone_name text, boundary geometry)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT z.id, z.name, z.boundary
  FROM public.location_zones z
  WHERE z.location_id = (SELECT s.location_id FROM public.client_sites s WHERE s.id = p_site_id)
  ORDER BY z.name;
$$;

CREATE VIEW public.module_rule_index_view
WITH (security_invoker = true)
AS
SELECT
  om.organization_id,
  om.module_key,
  om.enabled,
  mrs.id AS module_rule_set_id,
  mrs.name AS module_rule_set_name,
  mrs.evidence_requirements,
  mrs.approval_policy,
  mrs.report_template_code,
  jrs.id AS jurisdiction_rule_set_id,
  jrs.name AS jurisdiction_rule_set_name,
  jrs.jurisdiction_name,
  jrs.rules AS jurisdiction_rules,
  z.id AS zone_id,
  z.location_id,
  z.organization_id AS zone_organization_id,
  COALESCE(z.jurisdiction_rule_set_id, jrs.id) AS active_rule_set_id,
  CASE
    WHEN z.id IS NOT NULL THEN 'zone'
    WHEN cs.id IS NOT NULL THEN 'site'
    ELSE 'organization'
  END AS place_scope
FROM public.organization_modules om
LEFT JOIN public.module_rule_sets mrs
  ON mrs.organization_id = om.organization_id
 AND mrs.module_key = om.module_key
LEFT JOIN public.jurisdiction_rule_sets jrs
  ON jrs.organization_id = om.organization_id
 AND jrs.module_key = om.module_key
LEFT JOIN public.location_zones z
  ON z.organization_id = om.organization_id
 AND z.module_key = om.module_key
LEFT JOIN public.client_sites cs
  ON cs.organization_id = om.organization_id
 AND cs.site_type IS NOT NULL
ORDER BY om.organization_id, om.module_key, z.id;
COMMENT ON VIEW public.module_rule_index_view IS
  'Read-only lookup view for active module rule sets keyed by organization, module, and governing place context. This supports multi-jurisdiction service-provider rule resolution without hidden org assumptions.';
REVOKE ALL ON public.module_rule_index_view FROM anon;
GRANT SELECT ON public.module_rule_index_view TO authenticated, service_role;

-- resolve_context: the site is the sibling site facet on the matched zone's house; the owner is the house.
CREATE OR REPLACE FUNCTION public.resolve_context(p_lat double precision, p_lng double precision, p_org_id uuid, p_module_key text DEFAULT NULL::text, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(in_operating_bounds boolean, out_of_bounds_district text, governing_jurisdiction_id uuid, governing_jurisdiction_name text, on_site boolean, site_id uuid, client_org_id uuid, matched_zone_id uuid, matched_module_key text, effective_rules jsonb, resolution_status text, governor_overlap_flag boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
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
  v_client_org   uuid := null;
  v_rules        jsonb := '{}'::jsonb;
  v_resolution   text := 'outside_all_geofences';
  v_gov_overlap  boolean := false;
  v_org_jur_verification text;
  v_org_jur_geom_exists  boolean;
  v_org_jur_geom_valid   boolean;
  v_governor_count integer := 0;
BEGIN
  -- Layer 1: operating bounds (P1/P2: no-geofence / unverified / invalid / outside / inside are distinct).
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

  IF NOT COALESCE(v_org_jur_geom_exists, false) THEN
    v_resolution := 'unresolved_no_geofence';
  ELSIF NOT COALESCE(v_org_jur_geom_valid, false) THEN
    v_resolution := 'unresolved_invalid';
  ELSIF COALESCE(v_org_jur_verification, 'unverified') <> 'verified' THEN
    v_resolution := 'unresolved_unverified';
  ELSE
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

  -- Layer 2: governing council jurisdiction (role-aware; unchanged).
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

  IF v_governor_count > 1 THEN
    v_gov_overlap := true;
  END IF;

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

  -- Layer 3: verified zone geofence. Matching is unchanged; the site and owner now come from the house.
  SELECT z.id, z.location_id, z.module_key, z.onsite_profile, z.boundary,
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
  ORDER BY st_area(z.boundary) ASC
  LIMIT 1;

  IF v_zone.id IS NOT NULL THEN
    v_resolution := 'resolved';

    -- The owner is the house (locations.organization_id); the zone's own org is the fallback.
    SELECT loc.organization_id INTO v_client_org FROM public.locations loc WHERE loc.id = v_zone.location_id;
    v_client_org := COALESCE(v_client_org, p_org_id);

    -- The site facet on the same house, preferring one whose geometry holds the point.
    SELECT cs.id,
           CASE
             WHEN v_zone.onsite_profile = 'approach_10m'
               THEN st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography, v_point::geography, 10)
             ELSE
               (cs.boundary IS NOT NULL AND st_contains(cs.boundary, v_point))
               OR st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography,
                             v_point::geography,
                             COALESCE(cs.onsite_radius_meters, 10))
           END
      INTO v_site_id, v_on_site
    FROM public.client_sites cs
    WHERE cs.location_id = v_zone.location_id
      AND cs.active
    ORDER BY (cs.boundary IS NOT NULL AND st_contains(cs.boundary, v_point)) DESC,
             st_dwithin(COALESCE(cs.center_point, cs.boundary)::geography, v_point::geography, COALESCE(cs.onsite_radius_meters, 10)) DESC,
             cs.created_at
    LIMIT 1;
    v_on_site := COALESCE(v_on_site, false);

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

CREATE OR REPLACE FUNCTION public.resolve_active_rules(p_organization_id uuid, p_module_key text, p_lat double precision DEFAULT NULL::double precision, p_lng double precision DEFAULT NULL::double precision, p_zone_id uuid DEFAULT NULL::uuid, p_site_id uuid DEFAULT NULL::uuid, p_location_id uuid DEFAULT NULL::uuid, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(organization_id uuid, module_key text, enabled boolean, dominant_anchor_kind text, active_zone_id uuid, active_site_id uuid, active_location_id uuid, governing_jurisdiction_id uuid, governing_jurisdiction_name text, module_rule_set_id uuid, module_rule_set_name text, evidence_requirements jsonb, approval_policy jsonb, report_template_code text, jurisdiction_rule_set_id uuid, jurisdiction_rule_set_name text, jurisdiction_name text, jurisdiction_rules jsonb, resolution_status text, effective_rules jsonb, policy_status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_zone_id uuid := p_zone_id;
  v_site_id uuid := p_site_id;
  v_location_id uuid := p_location_id;
  v_rule jsonb := '{}'::jsonb;
  v_jur_id uuid := NULL;
  v_jur_name text := NULL;
  v_module_rule_set_id uuid := NULL;
  v_module_rule_set_name text := NULL;
  v_module_evidence_requirements jsonb := '{}'::jsonb;
  v_module_approval_policy jsonb := '{}'::jsonb;
  v_module_report_template_code text := NULL;
  v_jurisdiction_rule_set_id uuid := NULL;
  v_jurisdiction_rule_set_name text := NULL;
  v_jurisdiction_name text := NULL;
  v_jurisdiction_rules jsonb := '{}'::jsonb;
  v_resolution text := 'outside_all_geofences';
  v_enabled boolean := false;
  v_anchor text := 'unresolved';
BEGIN
  IF p_organization_id IS NULL OR NULLIF(trim(COALESCE(p_module_key, '')), '') IS NULL THEN
    RETURN;
  END IF;

  SELECT om.enabled INTO v_enabled
  FROM public.organization_modules om
  WHERE om.organization_id = p_organization_id
    AND om.module_key = p_module_key
  LIMIT 1;

  IF v_enabled IS NULL THEN
    v_enabled := false;
  END IF;

  IF p_zone_id IS NOT NULL THEN
    -- The zone's sibling site lives on the same house.
    SELECT z.id,
           (SELECT cs.id FROM public.client_sites cs WHERE cs.location_id = z.location_id AND cs.active ORDER BY cs.created_at LIMIT 1),
           z.location_id, z.jurisdiction_rule_set_id,
           COALESCE(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, COALESCE(jrs.rules, '{}'::jsonb),
           COALESCE(z.module_key, p_module_key),
           CASE WHEN z.boundary IS NOT NULL THEN 'zone' ELSE 'unresolved' END
      INTO v_zone_id, v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules,
           p_module_key, v_anchor
    FROM public.location_zones z
    LEFT JOIN public.jurisdiction_rule_sets jrs
      ON jrs.id = z.jurisdiction_rule_set_id
    WHERE z.id = p_zone_id
    LIMIT 1;

    v_resolution := 'resolved';
  ELSIF p_site_id IS NOT NULL THEN
    SELECT cs.id, cs.location_id, COALESCE(z.jurisdiction_rule_set_id, NULL),
           COALESCE(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, COALESCE(jrs.rules, '{}'::jsonb),
           'site'
      INTO v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules, v_anchor
    FROM public.client_sites cs
    LEFT JOIN public.location_zones z ON z.location_id = cs.location_id AND z.module_key = p_module_key
    LEFT JOIN public.jurisdiction_rule_sets jrs ON jrs.id = z.jurisdiction_rule_set_id
    WHERE cs.id = p_site_id
    ORDER BY z.created_at
    LIMIT 1;

    v_resolution := 'resolved';
  ELSIF p_lat IS NOT NULL AND p_lng IS NOT NULL THEN
    SELECT rc.matched_zone_id, rc.site_id, rc.client_org_id, rc.governing_jurisdiction_id,
           rc.governing_jurisdiction_name, rc.effective_rules, rc.resolution_status
      INTO v_zone_id, v_site_id, v_location_id, v_jur_id, v_jur_name, v_rule, v_resolution
    FROM public.resolve_context(p_lat, p_lng, p_organization_id, p_module_key, p_at) rc
    LIMIT 1;

    IF v_zone_id IS NOT NULL THEN
      SELECT z.location_id INTO v_location_id FROM public.location_zones z WHERE z.id = v_zone_id LIMIT 1;
    END IF;

    v_anchor := CASE WHEN v_zone_id IS NOT NULL THEN 'zone' WHEN v_site_id IS NOT NULL THEN 'site' ELSE 'unresolved' END;
  END IF;

  SELECT mrs.id, mrs.name, mrs.evidence_requirements, mrs.approval_policy, mrs.report_template_code
    INTO v_module_rule_set_id, v_module_rule_set_name, v_module_evidence_requirements, v_module_approval_policy, v_module_report_template_code
  FROM public.module_rule_sets mrs
  WHERE mrs.organization_id = p_organization_id
    AND mrs.module_key = p_module_key
  ORDER BY mrs.created_at DESC
  LIMIT 1;

  IF v_jurisdiction_rule_set_id IS NULL AND p_organization_id IS NOT NULL AND p_module_key IS NOT NULL THEN
    SELECT jrs.id, jrs.name, jrs.jurisdiction_name, jrs.rules
      INTO v_jurisdiction_rule_set_id, v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules
    FROM public.jurisdiction_rule_sets jrs
    WHERE jrs.organization_id = p_organization_id
      AND jrs.module_key = p_module_key
    ORDER BY jrs.created_at DESC
    LIMIT 1;
  END IF;

  IF v_rule = '{}'::jsonb THEN
    v_rule := COALESCE(v_jurisdiction_rules, '{}'::jsonb);
  END IF;

  RETURN QUERY
  SELECT
    p_organization_id,
    p_module_key,
    v_enabled,
    v_anchor,
    v_zone_id,
    v_site_id,
    v_location_id,
    v_jur_id,
    v_jur_name,
    v_module_rule_set_id,
    v_module_rule_set_name,
    v_module_evidence_requirements,
    v_module_approval_policy,
    v_module_report_template_code,
    v_jurisdiction_rule_set_id,
    v_jurisdiction_rule_set_name,
    v_jurisdiction_name,
    v_jurisdiction_rules,
    v_resolution,
    v_rule,
    CASE
      WHEN v_enabled = false THEN 'disabled'
      WHEN v_resolution IN ('unresolved_no_geofence','unresolved_invalid','unresolved_unverified','outside_all_geofences') THEN 'needs_resolution'
      WHEN v_module_rule_set_id IS NULL THEN 'missing_module_rule_set'
      WHEN v_jurisdiction_rule_set_id IS NULL THEN 'missing_jurisdiction_rule_set'
      ELSE 'effective_rules_ready'
    END AS policy_status;
END;
$function$;

-- Zone address is the house address.
CREATE OR REPLACE FUNCTION public.get_crm_operational_geography()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return jsonb_build_object(
    'locations',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from(
      select distinct l.id,l.organization_id,l.canonical_place_id,l.name,l.address,l.suburb,l.postcode,l.notes
      from public.locations l
      where l.organization_id=v_provider or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        left join public.client_sites s on s.id=sal.site_id left join public.location_zones z on z.id=sal.zone_id
        where sa.provider_organization_id=v_provider and sa.invitation_status='accepted' and sa.agreement_type='operational' and (s.location_id=l.id or z.location_id=l.id)
      )
    )x),
    'sites',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from(
      select distinct s.id,s.client_organization_id,s.location_id,s.name,s.address,s.site_type,s.active,s.gps_lat,s.gps_lng,st_asgeojson(s.boundary)::jsonb boundary,s.boundary_status,s.boundary_verification
      from public.client_sites s
      where s.client_organization_id=v_provider or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        where sa.provider_organization_id=v_provider and sa.invitation_status='accepted' and sa.agreement_type='operational' and sal.site_id=s.id
      )
    )x),
    'zones',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from(
      select distinct z.id,z.organization_id,z.location_id,z.name,l.address,z.zone_type,z.module_key,z.rule_type,z.is_active,z.active_schedule,z.onsite_profile,z.enforcement_workflow_override,st_asgeojson(z.boundary)::jsonb boundary,st_asgeojson(z.center_point)::jsonb center_point,z.boundary_status,z.boundary_verification,z.bylaw_clause,z.bylaw_source_url,z.nightly_limit_consecutive,z.nightly_limit_monthly,z.scv_required
      from public.location_zones z
      left join public.locations l on l.id=z.location_id
      where z.organization_id=v_provider or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        where sa.provider_organization_id=v_provider and sa.invitation_status='accepted' and sa.agreement_type='operational' and sal.zone_id=z.id
      )
    )x)
  );
end;$function$;

CREATE OR REPLACE FUNCTION public.get_geofence_review_queue(p_organization_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(entity_type text, entity_id uuid, name text, address text, organization_id uuid, organization_name text, zone_type text, module_key text, boundary_state text, boundary_status text, boundary_verification text, has_boundary boolean, boundary_geojson jsonb, center_lat double precision, center_lng double precision, active_agreements integer, open_proposal_id uuid, open_proposal_source text, open_proposal_gate_ok boolean, open_proposal_area_m2 numeric, open_proposal_drift_m double precision, open_proposal_geojson jsonb, configuration_version integer, priority integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    SELECT 'location_zone'::text, z.id, z.name, l.address, z.organization_id, z.zone_type, z.module_key, z.boundary_status, z.boundary_verification, z.boundary, z.center_point,
      (SELECT count(*)::integer FROM public.service_agreement_locations sal JOIN public.service_agreements sa ON sa.id = sal.service_agreement_id
        WHERE sal.zone_id = z.id AND sal.status = 'active'
          AND (sa.starts_on IS NULL OR sa.starts_on <= current_date) AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)),
      z.configuration_version
    FROM public.location_zones z
    LEFT JOIN public.locations l ON l.id = z.location_id
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
$function$;

CREATE OR REPLACE FUNCTION public.get_officer_data_package(p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_zones jsonb;
  v_matrix jsonb;
  v_flags jsonb;
  v_rules jsonb;
  v_stops jsonb;
  v_welfare jsonb;
  v_package jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active officer profile required for data package download'; end if;

  if p_shift_id is not null and not exists (select 1 from public.shifts s where s.id = p_shift_id and s.organization_id = v_org_id) then
    raise exception 'Shift does not belong to the officer organisation';
  end if;

  -- 1. Active location zones (address is the house address)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', z.id,
    'location_id', z.location_id,
    'name', z.name,
    'address', l.address,
    'zone_type', z.zone_type,
    'module_key', z.module_key,
    'rule_type', z.rule_type,
    'is_active', z.is_active
  )), '[]'::jsonb) into v_zones
  from public.location_zones z
  left join public.locations l on l.id = z.location_id
  where z.organization_id = v_org_id and z.is_active = true;

  -- 2. Current zone compliance matrix
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'zone_id', m.zone_id,
    'max_consecutive_nights', m.max_consecutive_nights,
    'max_nights_per_month', m.max_nights_per_month,
    'scv_required', m.scv_required,
    'is_current', m.is_current
  )), '[]'::jsonb) into v_matrix
  from public.zone_compliance_matrix m
  where m.organization_id = v_org_id and m.is_current = true;

  -- 3. Active entity flags (vehicle/person)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'entity_type', f.entity_type,
    'plate_number', f.plate_number,
    'flag_type', f.flag_type,
    'flag_reason', f.flag_reason,
    'severity', f.severity,
    'is_active', f.is_active
  )), '[]'::jsonb) into v_flags
  from public.entity_flags f
  where f.organization_id = v_org_id and f.is_active = true;

  -- 4. Module rule sets
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'module_key', r.module_key,
    'name', r.name,
    'evidence_requirements', r.evidence_requirements,
    'approval_policy', r.approval_policy
  )), '[]'::jsonb) into v_rules
  from public.module_rule_sets r
  where r.organization_id = v_org_id;

  -- 5. Patrol stops for current shift if supplied
  if p_shift_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', st.id,
      'site_id', st.site_id,
      'zone_id', st.zone_id,
      'status', st.status,
      'sla_respond_by', st.sla_respond_by,
      'notes', st.notes
    )), '[]'::jsonb) into v_stops
    from public.shift_stops st
    where st.shift_id = p_shift_id and st.organization_id = v_org_id;
  else
    v_stops := '[]'::jsonb;
  end if;

  -- 6. Welfare settings
  select to_jsonb(w.*) into v_welfare
  from public.officer_welfare_settings w
  where w.organization_id = v_org_id limit 1;

  v_package := jsonb_build_object(
    'package_timestamp', clock_timestamp(),
    'organization_id', v_org_id,
    'officer_id', v_user_id,
    'shift_id', p_shift_id,
    'location_zones', v_zones,
    'zone_compliance_matrix', v_matrix,
    'entity_flags', v_flags,
    'module_rule_sets', v_rules,
    'shift_stops', v_stops,
    'welfare_settings', coalesce(v_welfare, '{}'::jsonb)
  );

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'officer_data_package_downloaded', 'user_profiles', v_user_id,
    jsonb_build_object('shift_id', p_shift_id, 'zone_count', jsonb_array_length(v_zones), 'flag_count', jsonb_array_length(v_flags))
  );

  return v_package;
end;
$function$;

-- Accepted quotes create facets under the client's house; a duplicate is the same house + module + name.
CREATE OR REPLACE FUNCTION public.activate_quote_proposal_places()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE place public.quote_proposal_places%rowtype;v_site_id uuid;v_zone_id uuid;v_point geometry;v_key text;v_house uuid;
BEGIN
  IF new.status='accepted' AND new.service_agreement_id IS NOT NULL AND old.status IS DISTINCT FROM 'accepted' THEN
    FOR place IN SELECT * FROM public.quote_proposal_places WHERE quote_id=new.id LOOP
      v_key:=public.address_match_key(place.address);
      IF place.place_kind='site' THEN
        IF place.resolution='use_existing' THEN v_site_id:=place.candidate_site_id;
        ELSE
          IF EXISTS(SELECT 1 FROM public.client_sites site WHERE site.client_organization_id=new.client_org_id AND site.address_match_key=v_key) THEN RAISE EXCEPTION 'Proposed Site requires duplicate resolution before acceptance';END IF;
          v_point:=CASE WHEN place.proposed_geometry IS NOT NULL AND place.proposed_geometry->>'type'='Point' THEN ST_SetSRID(ST_GeomFromGeoJSON(place.proposed_geometry::text),4326) ELSE NULL END;
          INSERT INTO public.client_sites(client_organization_id,name,address,address_match_key,site_type,active,site_origin,boundary_status,boundary_verification,center_point) VALUES(new.client_org_id,place.name,place.address,v_key,place.site_type,true,'contracted','provisional','unverified',v_point) RETURNING id INTO v_site_id;
        END IF;
        INSERT INTO public.service_agreement_locations(service_agreement_id,site_id,status,created_by) VALUES(new.service_agreement_id,v_site_id,'active',new.accepted_by) ON CONFLICT(service_agreement_id,site_id) DO UPDATE SET status='active',updated_at=clock_timestamp();
        INSERT INTO public.site_services(organization_id,service_agreement_id,module_key,site_id,service_hours,enabled,active,created_by) SELECT new.provider_org_id,new.service_agreement_id,place.module_key,v_site_id,'{}'::jsonb,true,true,new.accepted_by WHERE NOT EXISTS(SELECT 1 FROM public.site_services service WHERE service.service_agreement_id=new.service_agreement_id AND service.module_key=place.module_key AND service.site_id=v_site_id);
        UPDATE public.quote_proposal_places SET converted_site_id=v_site_id,converted_at=clock_timestamp() WHERE id=place.id;
      ELSE
        IF place.resolution='use_existing' THEN v_zone_id:=place.candidate_zone_id;
        ELSE
          SELECT id INTO v_house FROM public.locations house WHERE house.organization_id=new.client_org_id AND ((v_key IS NOT NULL AND house.address_match_key=v_key) OR (v_key IS NULL AND lower(house.name)=lower(place.name))) ORDER BY house.created_at LIMIT 1;
          IF v_house IS NOT NULL AND EXISTS(SELECT 1 FROM public.location_zones zone WHERE zone.organization_id=new.client_org_id AND zone.location_id=v_house AND zone.module_key=place.module_key AND lower(zone.name)=lower(place.name)) THEN RAISE EXCEPTION 'Proposed Zone requires duplicate resolution before acceptance';END IF;
          IF v_house IS NULL THEN
            INSERT INTO public.locations(organization_id,name,address,address_match_key,created_by) VALUES(new.client_org_id,place.name,place.address,v_key,new.accepted_by) RETURNING id INTO v_house;
          END IF;
          INSERT INTO public.location_zones(organization_id,location_id,name,zone_type,module_key,is_active,boundary_status,boundary_verification) VALUES(new.client_org_id,v_house,place.name,place.zone_type,place.module_key,true,'provisional','unverified') RETURNING id INTO v_zone_id;
        END IF;
        INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,status,created_by) VALUES(new.service_agreement_id,v_zone_id,'active',new.accepted_by) ON CONFLICT(service_agreement_id,zone_id) DO UPDATE SET status='active',updated_at=clock_timestamp();
        INSERT INTO public.site_services(organization_id,service_agreement_id,module_key,zone_id,service_hours,enabled,active,created_by) SELECT new.provider_org_id,new.service_agreement_id,place.module_key,v_zone_id,'{}'::jsonb,true,true,new.accepted_by WHERE NOT EXISTS(SELECT 1 FROM public.site_services service WHERE service.service_agreement_id=new.service_agreement_id AND service.module_key=place.module_key AND service.zone_id=v_zone_id);
        UPDATE public.quote_proposal_places SET converted_zone_id=v_zone_id,converted_at=clock_timestamp() WHERE id=place.id;
      END IF;
    END LOOP;
  END IF;
  RETURN new;
END;$function$;

CREATE OR REPLACE FUNCTION public.import_approved_freedom_places(p_places jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid(); v_place jsonb; v_client uuid; v_provider uuid; v_agreement uuid; v_location uuid; v_site uuid; v_zone uuid; v_geojson jsonb; v_created jsonb := '[]'::jsonb;
BEGIN
  IF NOT has_table_privilege(current_user, 'public.locations', 'INSERT') THEN RAISE EXCEPTION 'Service role table privilege required'; END IF;
  IF jsonb_typeof(p_places) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Places must be a JSON array'; END IF;
  FOR v_place IN SELECT value FROM jsonb_array_elements(p_places) LOOP
    v_client := (v_place->>'client_organization_id')::uuid; v_provider := (v_place->>'provider_organization_id')::uuid; v_agreement := (v_place->>'service_agreement_id')::uuid;
    IF v_client IS NULL OR v_provider IS NULL OR v_agreement IS NULL THEN RAISE EXCEPTION 'Client, provider, and agreement are required'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.service_agreements WHERE id=v_agreement AND provider_organization_id=v_provider AND client_organization_id=v_client) THEN RAISE EXCEPTION 'Agreement does not bind the supplied organizations'; END IF;
    v_geojson := v_place->'geojson'; IF v_geojson IS NULL OR v_geojson->>'type' NOT IN ('Polygon','MultiPolygon') THEN RAISE EXCEPTION 'Approved place geometry must be Polygon or MultiPolygon'; END IF;
    SELECT id INTO v_location FROM public.locations WHERE organization_id=v_client AND lower(name)=lower(v_place->>'location_name') ORDER BY created_at LIMIT 1;
    IF v_location IS NULL THEN
      INSERT INTO public.locations(organization_id,name,address,notes,created_by) VALUES(v_client,v_place->>'location_name',NULL,'Imported from approved Freedom Camping jurisdiction source. Source project: '||coalesce(v_place->>'source_project','unknown')||'; source id: '||coalesce(v_place->>'source_id','unknown'),v_actor) RETURNING id INTO v_location;
    END IF;
    INSERT INTO public.client_sites(client_organization_id,organization_id,location_id,name,address,active,site_origin,ownership_status,ownership_signals,boundary,boundary_status,boundary_verification,boundary_verified_by,boundary_verified_at,external_refs) VALUES(v_client,v_client,v_location,v_place->>'site_name',NULL,true,'contracted','resolved',jsonb_build_object('source','FreedomCamp-Manager','approval','user_directed_live_import'),ST_GeomFromGeoJSON(v_geojson::text),'authoritative','verified',v_actor,clock_timestamp(),jsonb_build_object('source_project',v_place->>'source_project','source_id',v_place->>'source_id','source_sha256',v_place->>'source_sha256')) ON CONFLICT DO NOTHING RETURNING id INTO v_site;
    IF v_site IS NULL THEN SELECT id INTO v_site FROM public.client_sites WHERE client_organization_id=v_client AND location_id=v_location AND name=v_place->>'site_name' ORDER BY created_at DESC LIMIT 1; END IF;
    INSERT INTO public.location_zones(organization_id,location_id,name,zone_type,module_key,is_active,boundary,boundary_verification,boundary_status,boundary_verified_by,boundary_verified_at,metadata,bylaw_clause,nightly_limit_consecutive,nightly_limit_monthly,scv_required) VALUES(v_client,v_location,v_place->>'zone_name',coalesce(v_place->>'zone_type','freedom_camping'),v_place->>'module_key',true,ST_Multi(ST_GeomFromGeoJSON(v_geojson::text)),'verified','authoritative',v_actor,clock_timestamp(),jsonb_build_object('source_project',v_place->>'source_project','source_id',v_place->>'source_id','source_sha256',v_place->>'source_sha256','source_policy',v_place->'policy'),(v_place->'policy'->>'bylaw_clause'),(v_place->'policy'->>'nightly_limit_consecutive')::integer,(v_place->'policy'->>'nightly_limit_monthly')::integer,coalesce((v_place->'policy'->>'scv_required')::boolean,false)) ON CONFLICT DO NOTHING RETURNING id INTO v_zone;
    IF v_zone IS NULL THEN SELECT id INTO v_zone FROM public.location_zones WHERE organization_id=v_client AND location_id=v_location AND name=v_place->>'zone_name' ORDER BY created_at DESC LIMIT 1; END IF;
    INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,status,created_by) VALUES(v_agreement,v_zone,'active',v_actor) ON CONFLICT DO NOTHING;
    v_created := v_created || jsonb_build_object('location_id',v_location,'site_id',v_site,'zone_id',v_zone,'agreement_id',v_agreement,'source_id',v_place->>'source_id');
  END LOOP;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES((p_places->0->>'provider_organization_id')::uuid,v_actor,'freedom_places_imported','service_agreement_locations',NULL,jsonb_build_object('count',jsonb_array_length(p_places),'source_project',p_places->0->>'source_project','approval','user_directed_live_import'));
  RETURN v_created;
END;
$function$;

-- One place, many organisations: a house at an address another organisation already holds is a link to
-- the same registry place, not a conflict. The same address inside one organisation is its existing house.
CREATE OR REPLACE FUNCTION public.manage_crm_location(p_client_request_id uuid, p_organization_id uuid, p_action text, p_name text, p_address text DEFAULT NULL::text, p_suburb text DEFAULT NULL::text, p_postcode text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS locations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_actor uuid:=auth.uid();v_provider uuid;v_location public.locations%rowtype;v_name text:=nullif(trim(coalesce(p_name,'')), '');v_address text:=nullif(trim(coalesce(p_address,'')), '');v_address_key text:=public.address_match_key(p_address);
BEGIN
  SELECT organization_id INTO v_provider FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) OR NOT public.crm_actor_can_manage_account(p_organization_id) THEN RAISE EXCEPTION 'Active CRM administrator required for this organization'; END IF;
  IF p_action<>'create' OR p_client_request_id IS NULL OR v_name IS NULL OR char_length(v_name)>200 OR (v_address IS NOT NULL AND char_length(v_address)>500) THEN RAISE EXCEPTION 'Valid location creation request is required'; END IF;
  SELECT * INTO v_location FROM public.locations WHERE organization_id=p_organization_id AND client_request_id=p_client_request_id;
  IF FOUND THEN RETURN v_location; END IF;
  IF v_address_key IS NOT NULL THEN
    SELECT * INTO v_location FROM public.locations WHERE organization_id=p_organization_id AND address_match_key=v_address_key ORDER BY created_at LIMIT 1;
    IF FOUND THEN RETURN v_location; END IF;
  END IF;
  INSERT INTO public.locations(organization_id,name,address,address_match_key,suburb,postcode,notes,created_by,client_request_id) VALUES(p_organization_id,v_name,v_address,v_address_key,nullif(trim(coalesce(p_suburb,'')),''),nullif(trim(coalesce(p_postcode,'')),''),nullif(trim(coalesce(p_notes,'')),''),v_actor,p_client_request_id) RETURNING * INTO v_location;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_provider,v_actor,'crm_location_created','locations',v_location.id,jsonb_build_object('account_organization_id',p_organization_id,'address_match_key',v_address_key,'canonical_place_id',v_location.canonical_place_id));
  RETURN v_location;
END; $function$;

-- Test dataset purge is the one sanctioned place-deletion path.
CREATE OR REPLACE FUNCTION public.purge_aam_e2e_dataset(p_provider_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_account_id constant uuid := 'a1000000-0000-4000-8000-000000000001';
  v_agreement_id constant uuid := 'a1000000-0000-4000-8000-000000000004';
  v_location_id constant uuid := 'a1000000-0000-4000-8000-000000000002';
  v_site_id constant uuid := 'a1000000-0000-4000-8000-000000000003';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service role required'; END IF;
  IF EXISTS (SELECT 1 FROM public.organizations o WHERE o.id=v_account_id AND (o.parent_organization_id IS DISTINCT FROM p_provider_organization_id OR o.external_refs->>'dataset' IS DISTINCT FROM 'aam_e2e_20260831')) THEN RAISE EXCEPTION 'AAM dataset identity collision'; END IF;
  PERFORM set_config('app.place_delete_scope', 'test_dataset_purge', true);
  DELETE FROM public.debrief_followups WHERE shift_id IN (SELECT id FROM public.shifts WHERE organization_id=p_provider_organization_id AND notes LIKE '[AAM E2E]%');
  DELETE FROM public.shift_debriefs WHERE shift_id IN (SELECT id FROM public.shifts WHERE organization_id=p_provider_organization_id AND notes LIKE '[AAM E2E]%');
  DELETE FROM public.finance_service_item_consumption WHERE shift_id IN (SELECT id FROM public.shifts WHERE organization_id=p_provider_organization_id AND notes LIKE '[AAM E2E]%');
  DELETE FROM public.finance_inventory_transactions WHERE shift_id IN (SELECT id FROM public.shifts WHERE organization_id=p_provider_organization_id AND notes LIKE '[AAM E2E]%');
  DELETE FROM public.finance_service_costs WHERE shift_id IN (SELECT id FROM public.shifts WHERE organization_id=p_provider_organization_id AND notes LIKE '[AAM E2E]%');
  DELETE FROM public.observations WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id) OR site_id=v_site_id;
  DELETE FROM public.breach_alerts WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.breach_records WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.enforcement_cases WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.infringement_notices WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.notices_to_vacate WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.parking_sessions WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.patrol_checkpoint_visits WHERE checkpoint_id IN (SELECT id FROM public.patrol_checkpoints WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id));
  DELETE FROM public.patrol_checkpoints WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.patrols WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.vehicle_overnight_sessions WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.officer_field_reports WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.officer_gps_log WHERE detected_zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.location_events WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id) OR client_site_id=v_site_id;
  DELETE FROM public.location_notes WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id) OR site_id=v_site_id;
  DELETE FROM public.zone_compliance_matrix WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.zone_legal_config WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.zone_signage_evidence WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.client_site_patrol_config WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id) OR site_id=v_site_id;
  DELETE FROM public.site_services WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id) OR site_id=v_site_id;
  DELETE FROM public.site_financial_config WHERE zone_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id) OR site_id=v_site_id;
  DELETE FROM public.shifts WHERE organization_id=p_provider_organization_id AND notes LIKE '[AAM E2E]%';
  DELETE FROM public.roster_slots WHERE organization_id=p_provider_organization_id AND (notes LIKE '[AAM E2E]%' OR work_unit_id IN (SELECT id FROM public.roster_work_units WHERE organization_id=p_provider_organization_id AND name LIKE '[AAM E2E]%'));
  DELETE FROM public.shift_templates WHERE organization_id=p_provider_organization_id AND name LIKE '[AAM E2E]%';
  DELETE FROM public.roster_work_units WHERE organization_id=p_provider_organization_id AND name LIKE '[AAM E2E]%';
  DELETE FROM public.invoice_line_items WHERE invoice_id IN (SELECT id FROM public.invoices WHERE client_organization_id=v_account_id);
  DELETE FROM public.invoices WHERE client_organization_id=v_account_id;
  DELETE FROM public.crm_activation_handoff_tasks t USING public.crm_activation_handoffs h WHERE t.handoff_id=h.id AND h.account_organization_id=v_account_id;
  DELETE FROM public.crm_activation_handoffs WHERE account_organization_id=v_account_id;
  DELETE FROM public.crm_onboarding_events WHERE account_organization_id=v_account_id;
  DELETE FROM public.crm_onboarding_ledgers WHERE account_organization_id=v_account_id;
  DELETE FROM public.geofence_boundary_history WHERE (entity_type='client_site' AND entity_id=v_site_id) OR (entity_type='location_zone' AND entity_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id));
  DELETE FROM public.service_agreement_locations WHERE service_agreement_id=v_agreement_id;
  DELETE FROM public.service_agreement_modules WHERE service_agreement_id=v_agreement_id;
  DELETE FROM public.crm_commercial_settings WHERE service_agreement_id=v_agreement_id;
  DELETE FROM public.crm_contacts WHERE organization_id=v_account_id;
  DELETE FROM public.canonical_place_links WHERE source_table='location_zones' AND source_id IN (SELECT id FROM public.location_zones WHERE location_id=v_location_id);
  DELETE FROM public.canonical_place_links WHERE (source_table='client_sites' AND source_id=v_site_id) OR (source_table='locations' AND source_id=v_location_id);
  DELETE FROM public.location_zones WHERE location_id=v_location_id;
  DELETE FROM public.client_sites WHERE id=v_site_id;
  DELETE FROM public.locations WHERE id=v_location_id;
  DELETE FROM public.service_agreements WHERE id=v_agreement_id;
  DELETE FROM public.organizations WHERE id=v_account_id;
  RETURN jsonb_build_object('purged',true,'dataset','aam_e2e_20260831');
END;
$function$;

CREATE OR REPLACE FUNCTION public.seed_aam_e2e_dataset(p_provider_organization_id uuid, p_owner_user_id uuid, p_admin_user_id uuid, p_admin_email text, p_officer_user_ids uuid[], p_officer_emails text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_account_id constant uuid:='a1000000-0000-4000-8000-000000000001';v_location_id constant uuid:='a1000000-0000-4000-8000-000000000002';v_site_id constant uuid:='a1000000-0000-4000-8000-000000000003';v_agreement_id constant uuid:='a1000000-0000-4000-8000-000000000004';v_contact_id constant uuid:='a1000000-0000-4000-8000-000000000005';v_commercial_id constant uuid:='a1000000-0000-4000-8000-000000000006';
  v_site_link_id uuid;v_static_module_id uuid;v_work_unit_id uuid;v_module text;v_zone_type text;v_zone_id uuid;v_index integer;v_shift_type text;v_start time;v_end time;
  v_operational_modules text[]:=array['access_control','biosecurity','ems','freedom_camping','noise_control','parking_enforcement','patrol','smoke_complaints','static_guarding'];
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required';end if;
  if not exists(select 1 from public.organizations o where o.id=p_provider_organization_id and o.active) then raise exception 'Active provider organization required';end if;
  if not exists(select 1 from public.user_profiles u where u.id=p_owner_user_id and u.organization_id=p_provider_organization_id and u.role in('grand_master','master','admin') and u.deactivated_at is null) then raise exception 'Active provider owner required';end if;
  if cardinality(p_officer_user_ids)<>5 or cardinality(p_officer_emails)<>5 then raise exception 'Exactly five AAM officers are required';end if;
  perform public.purge_aam_e2e_dataset(p_provider_organization_id);

  insert into public.user_profiles(id,organization_id,role,display_name,email,deactivated_at) values(p_admin_user_id,p_provider_organization_id,'admin','AAM E2E Administrator',p_admin_email,null) on conflict(id) do update set organization_id=excluded.organization_id,role=excluded.role,display_name=excluded.display_name,email=excluded.email,deactivated_at=null;
  for v_index in 1..5 loop
    insert into public.user_profiles(id,organization_id,role,display_name,email,deactivated_at) values(p_officer_user_ids[v_index],p_provider_organization_id,'officer','AAM E2E Officer '||v_index,p_officer_emails[v_index],null) on conflict(id) do update set organization_id=excluded.organization_id,role=excluded.role,display_name=excluded.display_name,email=excluded.email,deactivated_at=null;
    insert into public.staff_profiles(id,organization_id,employee_number,employment_type,start_date,user_id,work_ready,notes) values(p_officer_user_ids[v_index],p_provider_organization_id,'AAM-'||lpad(v_index::text,3,'0'),'casual',current_date,p_officer_user_ids[v_index],true,'AAM E2E retained test identity') on conflict(id) do update set organization_id=excluded.organization_id,employee_number=excluded.employee_number,user_id=excluded.user_id,work_ready=true,notes=excluded.notes;
  end loop;

  insert into public.organizations(id,name,organization_type,parent_organization_id,active,status,contact_email,billing_email,billing_address,account_notes,external_refs) values(v_account_id,'AAM End-to-End Test Account','client',p_provider_organization_id,false,'prospect','operations@aam-e2e.test','billing@aam-e2e.test','100 Test Avenue, Wellington','Controlled synthetic account. Safe to purge and reseed.',jsonb_build_object('dataset','aam_e2e_20260831'));
  insert into public.crm_contacts(id,organization_id,first_name,last_name,role_title,email,is_primary,is_emergency) values(v_contact_id,v_account_id,'Ari','AAM','Test Operations Lead','ari@aam-e2e.test',true,true);
  insert into public.locations(id,organization_id,name,address,address_match_key,suburb,postcode,notes,created_by) values(v_location_id,v_account_id,'AAM Test Operations House','100 Test Avenue, Wellington','100testavenuewellington','Te Aro','6011','Synthetic location for module, zone, and roster verification.',p_admin_user_id);
  insert into public.client_sites(id,client_organization_id,organization_id,location_id,name,address,address_match_key,site_type,risk_level,site_brief,access_instructions,hs_notes,active,site_origin,boundary,boundary_status,boundary_verification,boundary_verified_by,boundary_verified_at,external_refs) values(v_site_id,v_account_id,v_account_id,v_location_id,'AAM Test Operations Site','100 Test Avenue, Wellington','100testavenuewellington','commercial_premises','medium','Synthetic all-module operational test site.','Use the signed east service entrance. Test access code only.','Synthetic hazards: vehicle movement and wet-surface controls.',true,'contracted',st_geomfromtext('POLYGON((174.7750 -41.2920,174.7770 -41.2920,174.7770 -41.2900,174.7750 -41.2900,174.7750 -41.2920))',4326),'authoritative','verified',p_owner_user_id,clock_timestamp(),jsonb_build_object('dataset','aam_e2e_20260831'));
  insert into public.geofence_boundary_history(entity_type,entity_id,boundary,boundary_source,verification_state,verified_by,verified_at,changed_by,changed_via,change_reason,version) select 'client_site',v_site_id,s.boundary,'aam_e2e_seed','verified',p_owner_user_id,clock_timestamp(),p_owner_user_id,'backfill','AAM E2E verified test site boundary',1 from public.client_sites s where s.id=v_site_id;

  foreach v_module in array v_operational_modules loop
    v_zone_id:=(substr(md5('aam-e2e-zone-'||v_module),1,8)||'-'||substr(md5('aam-e2e-zone-'||v_module),9,4)||'-4'||substr(md5('aam-e2e-zone-'||v_module),14,3)||'-8'||substr(md5('aam-e2e-zone-'||v_module),18,3)||'-'||substr(md5('aam-e2e-zone-'||v_module),21,12))::uuid;
    v_zone_type:=case v_module when 'access_control' then 'access_control' when 'biosecurity' then 'biosecurity' when 'freedom_camping' then 'freedom_camping' when 'noise_control' then 'noise_control' when 'parking_enforcement' then 'parking' when 'patrol' then 'patrol_route' else 'general' end;
    insert into public.location_zones(id,organization_id,location_id,name,zone_type,module_key,rule_type,is_active,boundary,boundary_status,boundary_verification,boundary_verified_by,boundary_verified_at,center_point,metadata) values(v_zone_id,v_account_id,v_location_id,'AAM '||replace(initcap(v_module),'_',' ')||' Zone',v_zone_type,v_module,'restricted',true,st_multi(st_geomfromtext('POLYGON((174.7745 -41.2925,174.7775 -41.2925,174.7775 -41.2895,174.7745 -41.2895,174.7745 -41.2925))',4326)), 'authoritative','verified',p_owner_user_id,clock_timestamp(),st_geomfromtext('POINT(174.776 -41.291)',4326),jsonb_build_object('dataset','aam_e2e_20260831'));
    insert into public.geofence_boundary_history(entity_type,entity_id,boundary,boundary_source,verification_state,verified_by,verified_at,changed_by,changed_via,change_reason,version) select 'location_zone',v_zone_id,z.boundary,'aam_e2e_seed','verified',p_owner_user_id,clock_timestamp(),p_owner_user_id,'backfill','AAM E2E verified module zone',1 from public.location_zones z where z.id=v_zone_id;
  end loop;

  insert into public.service_agreements(id,provider_organization_id,client_organization_id,name,starts_on,agreement_type,invitation_status,client_portal_access_mode,client_portal_reports_enabled,enabled_modules,external_refs) select v_agreement_id,p_provider_organization_id,v_account_id,'AAM All-Module Service Agreement',current_date,'operational','accepted','full_modules',false,array_agg(mc.module_key order by mc.module_key),jsonb_build_object('dataset','aam_e2e_20260831') from public.module_catalog mc where mc.active;
  insert into public.service_agreement_modules(id,service_agreement_id,module_key,enabled,sla_minutes,allows_client_submission,allows_auto_dispatch,standalone_scan_enabled,settings) select gen_random_uuid(),v_agreement_id,mc.module_key,true,30,true,true,(mc.module_key in('freedom_camping','parking_enforcement')),jsonb_build_object('dataset','aam_e2e_20260831') from public.module_catalog mc where mc.active;
  insert into public.service_agreement_locations(id,service_agreement_id,site_id,status,created_by) values(gen_random_uuid(),v_agreement_id,v_site_id,'active',p_admin_user_id) returning id into v_site_link_id;
  insert into public.service_agreement_locations(id,service_agreement_id,zone_id,status,created_by) select gen_random_uuid(),v_agreement_id,z.id,'active',p_admin_user_id from public.location_zones z where z.location_id=v_location_id;
  insert into public.crm_commercial_settings(id,service_agreement_id,billing_cycle,payment_terms_days,currency,base_rate_per_hour,invoice_email,notes) values(v_commercial_id,v_agreement_id,'monthly',14,'NZD',85,'billing@aam-e2e.test','AAM E2E synthetic commercial readiness');
  select sam.id into v_static_module_id from public.service_agreement_modules sam where sam.service_agreement_id=v_agreement_id and sam.module_key='static_guarding';
  insert into public.roster_work_units(organization_id,name,work_unit_type,service_type,service_agreement_location_id,service_agreement_module_id,created_by) values(p_provider_organization_id,'[AAM E2E] Static Site Operations','static','static_guarding',v_site_link_id,v_static_module_id,p_admin_user_id) returning id into v_work_unit_id;

  for v_index in 1..5 loop
    v_shift_type:=(array['day','swing','night','overnight','split'])[v_index];
    v_start:=(array['08:00','14:00','20:00','22:00','07:00'])[v_index]::time;
    v_end:=(array['16:00','22:00','04:00','06:00','11:00'])[v_index]::time;
    insert into public.shift_templates(organization_id,name,description,shift_type,start_time,end_time,recurrence_type,active_days,required_staff_count,site_id,is_active,effective_from,notes,created_by) values(p_provider_organization_id,'[AAM E2E] '||initcap(v_shift_type)||' Shift','Synthetic canonical '||v_shift_type||' shift template',v_shift_type,v_start,v_end,'weekly',array[1,2,3,4,5,6,7],1,v_site_id,true,current_date,'[AAM E2E] retained test template',p_admin_user_id);
  end loop;
  return jsonb_build_object('dataset','aam_e2e_20260831','account_id',v_account_id,'agreement_id',v_agreement_id,'location_id',v_location_id,'site_id',v_site_id,'work_unit_id',v_work_unit_id,'admin_user_id',p_admin_user_id,'officer_user_ids',to_jsonb(p_officer_user_ids),'active_module_count',(select count(*) from public.module_catalog where active),'operational_zones',(select jsonb_agg(jsonb_build_object('zone_id',z.id,'module_key',z.module_key) order by z.module_key) from public.location_zones z where z.location_id=v_location_id));
end;$function$;

COMMENT ON TABLE public.canonical_places IS
  'The place registry. One permanent row per real-world place: site (an address / LINZ lot, keyed site:<address key>) or zone (an area, keyed zone:<house id>). Organisations link to it through locations; nothing here is deleted, only merged or retired.';
COMMENT ON TABLE public.locations IS
  'An organisation''s house: its link to one registry place (canonical_place_id). Site and zone facets hang off the house as siblings.';
COMMENT ON COLUMN public.locations.canonical_place_id IS 'The registry place this house is a link to. Assigned by trigger from the address key (site) or the house id (zone).';
COMMENT ON COLUMN public.client_sites.gps_lat IS 'Derived from center_point by trigger; do not write. Kept for existing readers.';
COMMENT ON COLUMN public.client_sites.gps_lng IS 'Derived from center_point by trigger; do not write. Kept for existing readers.';
