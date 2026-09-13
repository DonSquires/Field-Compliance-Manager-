-- Backfill the global place index without duplicating the existing house/site/zone
-- projections. A location house is the canonical identity; its site and zone facets
-- link to the same canonical_place_id.

INSERT INTO public.canonical_places (
  place_kind, canonical_key, display_name, normalized_name, address, metadata
)
SELECT
  'location',
  'location:' || l.id::text,
  l.name,
  regexp_replace(lower(trim(coalesce(l.name, ''))), '[^a-z0-9]+', '', 'g'),
  l.address,
  jsonb_build_object('backfilled_from', 'locations', 'source_id', l.id)
FROM public.locations l
ON CONFLICT (canonical_key) DO NOTHING;

INSERT INTO public.canonical_places (
  place_kind, canonical_key, display_name, normalized_name, address, boundary, center_point, metadata
)
SELECT
  'location',
  'site:' || s.id::text,
  s.name,
  regexp_replace(lower(trim(coalesce(s.name, ''))), '[^a-z0-9]+', '', 'g'),
  s.address,
  CASE WHEN s.boundary IS NULL THEN NULL ELSE ST_Multi(s.boundary) END,
  s.center_point,
  jsonb_build_object('backfilled_from', 'client_sites', 'source_id', s.id)
FROM public.client_sites s
WHERE s.location_id IS NULL
ON CONFLICT (canonical_key) DO NOTHING;

INSERT INTO public.canonical_places (
  place_kind, canonical_key, display_name, normalized_name, address, boundary, center_point, metadata
)
SELECT
  'location',
  'zone:' || z.id::text,
  z.name,
  regexp_replace(lower(trim(coalesce(z.name, ''))), '[^a-z0-9]+', '', 'g'),
  z.address,
  z.boundary,
  z.center_point,
  jsonb_build_object('backfilled_from', 'location_zones', 'source_id', z.id)
FROM public.location_zones z
WHERE z.location_id IS NULL AND z.site_id IS NULL
ON CONFLICT (canonical_key) DO NOTHING;

INSERT INTO public.canonical_place_links (
  canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata
)
SELECT cp.id, 'locations', l.id, l.organization_id, 'projection', l.id::text, '{}'::jsonb
FROM public.locations l
JOIN public.canonical_places cp ON cp.canonical_key = 'location:' || l.id::text
ON CONFLICT (source_table, source_id) DO NOTHING;

INSERT INTO public.canonical_place_links (
  canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata
)
SELECT COALESCE(location_cp.id, site_cp.id), 'client_sites', s.id, s.client_organization_id, 'projection', s.id::text, jsonb_build_object('location_id', s.location_id)
FROM public.client_sites s
LEFT JOIN public.canonical_places location_cp ON location_cp.canonical_key = 'location:' || s.location_id::text
LEFT JOIN public.canonical_places site_cp ON site_cp.canonical_key = 'site:' || s.id::text
WHERE COALESCE(location_cp.id, site_cp.id) IS NOT NULL
ON CONFLICT (source_table, source_id) DO NOTHING;

INSERT INTO public.canonical_place_links (
  canonical_place_id, source_table, source_id, organization_id, link_kind, source_key, metadata
)
SELECT COALESCE(location_cp.id, site_cp.canonical_place_id, zone_cp.id), 'location_zones', z.id, z.organization_id, 'projection', z.id::text, jsonb_build_object('location_id', z.location_id, 'site_id', z.site_id)
FROM public.location_zones z
LEFT JOIN public.canonical_places location_cp ON location_cp.canonical_key = 'location:' || z.location_id::text
LEFT JOIN public.canonical_place_links site_cp ON site_cp.source_table = 'client_sites' AND site_cp.source_id = z.site_id
LEFT JOIN public.canonical_places zone_cp ON zone_cp.canonical_key = 'zone:' || z.id::text
WHERE COALESCE(location_cp.id, site_cp.canonical_place_id, zone_cp.id) IS NOT NULL
ON CONFLICT (source_table, source_id) DO NOTHING;

COMMENT ON TABLE public.canonical_place_links IS
  'Global place index links. Location, Site, Zone, and LOI facets may all point to the same canonical_place_id; source uniqueness prevents duplicate projections.';
