-- Global identity spine: canonical entities are stable across owner/provider changes.
-- Existing organization-scoped tables remain projections/access surfaces; this migration
-- adds deduplicated global identities and nullable links without rewriting history.

CREATE TABLE IF NOT EXISTS public.canonical_places (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_kind text NOT NULL CHECK (place_kind IN ('location','site','zone','loi')),
  canonical_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  address text,
  boundary geometry(MultiPolygon,4326),
  center_point geometry(Point,4326),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','retired','needs_review')),
  merged_into_id uuid REFERENCES public.canonical_places(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS canonical_places_kind_name_idx
  ON public.canonical_places(place_kind, normalized_name);
CREATE INDEX IF NOT EXISTS canonical_places_boundary_gist_idx
  ON public.canonical_places USING gist(boundary);

CREATE TABLE IF NOT EXISTS public.canonical_place_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_place_id uuid NOT NULL REFERENCES public.canonical_places(id) ON DELETE RESTRICT,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  link_kind text NOT NULL DEFAULT 'projection' CHECK (link_kind IN ('projection','alias','imported','historical')),
  source_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_table, source_id),
  UNIQUE(canonical_place_id, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS canonical_place_links_identity_idx
  ON public.canonical_place_links(canonical_place_id);
CREATE INDEX IF NOT EXISTS canonical_place_links_org_idx
  ON public.canonical_place_links(organization_id);

CREATE TABLE IF NOT EXISTS public.canonical_people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL UNIQUE,
  display_name text,
  normalized_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_state text NOT NULL DEFAULT 'draft' CHECK (review_state IN ('draft','verified','rejected','manual_review_required')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','retired')),
  merged_into_id uuid REFERENCES public.canonical_people(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS canonical_people_name_idx
  ON public.canonical_people(normalized_name);

CREATE TABLE IF NOT EXISTS public.canonical_person_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_person_id uuid NOT NULL REFERENCES public.canonical_people(id) ON DELETE RESTRICT,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  link_kind text NOT NULL DEFAULT 'projection' CHECK (link_kind IN ('projection','alias','imported','historical')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_table, source_id),
  UNIQUE(canonical_person_id, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS canonical_person_links_identity_idx
  ON public.canonical_person_links(canonical_person_id);
CREATE INDEX IF NOT EXISTS canonical_person_links_org_idx
  ON public.canonical_person_links(organization_id);

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid REFERENCES public.canonical_places(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canonical_person_id uuid REFERENCES public.canonical_people(id) ON DELETE SET NULL;

ALTER TABLE public.incidents
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid REFERENCES public.canonical_places(id) ON DELETE SET NULL;

ALTER TABLE public.officer_field_reports
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid REFERENCES public.canonical_places(id) ON DELETE SET NULL;

ALTER TABLE public.location_events
  ADD COLUMN IF NOT EXISTS canonical_place_id uuid REFERENCES public.canonical_places(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS canonical_person_id uuid REFERENCES public.canonical_people(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS observations_canonical_place_idx
  ON public.observations(canonical_place_id, observed_at DESC)
  WHERE canonical_place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS observations_canonical_person_idx
  ON public.observations(canonical_person_id, observed_at DESC)
  WHERE canonical_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS incidents_canonical_place_idx
  ON public.incidents(canonical_place_id, occurred_at DESC)
  WHERE canonical_place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS officer_field_reports_canonical_place_idx
  ON public.officer_field_reports(canonical_place_id, reported_at DESC)
  WHERE canonical_place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS location_events_canonical_place_idx
  ON public.location_events(canonical_place_id, occurred_at DESC)
  WHERE canonical_place_id IS NOT NULL;

COMMENT ON TABLE public.canonical_places IS
  'Global deduplicated place identity index. Location, Site, Zone, and LOI are facets of persistent place identity; organization ownership and provider access remain on projections and agreement links.';
COMMENT ON TABLE public.canonical_place_links IS
  'Maps organization-owned or imported place projections to one global canonical place without duplicating the identity.';
COMMENT ON TABLE public.canonical_people IS
  'Global person identity index. Tenant-scoped person_records remain restricted projections linked through canonical_person_links.';
COMMENT ON COLUMN public.canonical_vehicles.id IS
  'Global vehicle identity. Observations and operational records reference this identity while retaining organization/place context.';
COMMENT ON COLUMN public.canonical_scv.id IS
  'Global SCV registry identity. Used for Freedom Camping self-contained vehicle search independently of organization ownership.';

ALTER TABLE public.canonical_places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_place_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_person_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY canonical_places_select ON public.canonical_places FOR SELECT TO authenticated USING (true);
CREATE POLICY canonical_people_select ON public.canonical_people FOR SELECT TO authenticated USING (true);
CREATE POLICY canonical_place_links_select ON public.canonical_place_links FOR SELECT TO authenticated USING (organization_id IS NULL OR public.org_access_allowed(organization_id));
CREATE POLICY canonical_person_links_select ON public.canonical_person_links FOR SELECT TO authenticated USING (organization_id IS NULL OR public.org_access_allowed(organization_id));

REVOKE INSERT, UPDATE, DELETE ON public.canonical_places, public.canonical_place_links, public.canonical_people, public.canonical_person_links FROM anon, authenticated;
GRANT SELECT ON public.canonical_places, public.canonical_place_links, public.canonical_people, public.canonical_person_links TO authenticated;
GRANT ALL ON public.canonical_places, public.canonical_place_links, public.canonical_people, public.canonical_person_links TO service_role;
