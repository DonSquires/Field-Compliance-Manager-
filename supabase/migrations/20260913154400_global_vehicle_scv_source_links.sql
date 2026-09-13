CREATE TABLE IF NOT EXISTS public.canonical_vehicle_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_vehicle_id uuid NOT NULL REFERENCES public.canonical_vehicles(id) ON DELETE RESTRICT,
  source_system text NOT NULL,
  source_table text NOT NULL,
  source_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_system, source_table, source_key)
);

CREATE TABLE IF NOT EXISTS public.canonical_scv_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_scv_id uuid NOT NULL REFERENCES public.canonical_scv(id) ON DELETE RESTRICT,
  source_system text NOT NULL,
  source_table text NOT NULL,
  source_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(source_system, source_table, source_key)
);

CREATE INDEX IF NOT EXISTS canonical_vehicle_links_identity_idx ON public.canonical_vehicle_links(canonical_vehicle_id);
CREATE INDEX IF NOT EXISTS canonical_scv_links_identity_idx ON public.canonical_scv_links(canonical_scv_id);

ALTER TABLE public.canonical_vehicle_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_scv_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY canonical_vehicle_links_select ON public.canonical_vehicle_links FOR SELECT TO authenticated USING (true);
CREATE POLICY canonical_scv_links_select ON public.canonical_scv_links FOR SELECT TO authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE ON public.canonical_vehicle_links, public.canonical_scv_links FROM anon, authenticated;
GRANT SELECT ON public.canonical_vehicle_links, public.canonical_scv_links TO authenticated;
GRANT ALL ON public.canonical_vehicle_links, public.canonical_scv_links TO service_role;
