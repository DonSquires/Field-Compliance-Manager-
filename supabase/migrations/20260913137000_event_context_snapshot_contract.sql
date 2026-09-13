-- Immutable context contract for future event writes. This is deliberately
-- separate from the physical anchor: Site/Zone/Checkpoint/House answer where;
-- these fields preserve which module/agreement/jurisdiction/actors/authority
-- context existed when the event was created.
CREATE TABLE IF NOT EXISTS public.event_context_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_table text NOT NULL,
  source_event_id uuid NOT NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  client_site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  checkpoint_id uuid REFERENCES public.patrol_checkpoints(id) ON DELETE RESTRICT,
  module_key text,
  service_agreement_id uuid REFERENCES public.service_agreements(id) ON DELETE RESTRICT,
  provider_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  client_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  jurisdiction_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  jurisdiction_rule_set_id uuid REFERENCES public.jurisdiction_rule_sets(id) ON DELETE RESTRICT,
  authority_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_context_snapshots_source_key UNIQUE (source_table, source_event_id),
  CONSTRAINT event_context_snapshots_facet_xor CHECK (num_nonnulls(client_site_id, zone_id) <= 1)
);

COMMENT ON TABLE public.event_context_snapshots IS
  'Immutable future-write context: physical anchor fields are separate from module, agreement, jurisdiction, actor/authority, and source provenance. Historical backfill is intentionally a later reconciliation slice.';
COMMENT ON COLUMN public.event_context_snapshots.authority_snapshot IS
  'Immutable JSON snapshot of the authority/actor decisions in force at event creation; not a live profile lookup.';
COMMENT ON COLUMN public.event_context_snapshots.source_refs IS
  'External/source identifiers used to prove provenance without making mutable provider/person records the event anchor.';

ALTER TABLE public.event_context_snapshots ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_event_context_snapshots_source ON public.event_context_snapshots (source_table, source_event_id);
CREATE INDEX IF NOT EXISTS idx_event_context_snapshots_location ON public.event_context_snapshots (location_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_context_snapshots_module ON public.event_context_snapshots (module_key, captured_at DESC);

DROP POLICY IF EXISTS event_context_snapshots_select ON public.event_context_snapshots;
CREATE POLICY event_context_snapshots_select ON public.event_context_snapshots
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(coalesce(provider_organization_id, client_organization_id, jurisdiction_organization_id)));

REVOKE ALL ON TABLE public.event_context_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.event_context_snapshots TO authenticated;
GRANT ALL ON TABLE public.event_context_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.create_event_context_snapshot(
  p_source_table text,
  p_source_event_id uuid,
  p_location_id uuid DEFAULT NULL,
  p_client_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_checkpoint_id uuid DEFAULT NULL,
  p_module_key text DEFAULT NULL,
  p_service_agreement_id uuid DEFAULT NULL,
  p_provider_organization_id uuid DEFAULT NULL,
  p_client_organization_id uuid DEFAULT NULL,
  p_jurisdiction_organization_id uuid DEFAULT NULL,
  p_jurisdiction_rule_set_id uuid DEFAULT NULL,
  p_authority_snapshot jsonb DEFAULT '{}'::jsonb,
  p_source_refs jsonb DEFAULT '{}'::jsonb,
  p_captured_at timestamptz DEFAULT now()
)
RETURNS public.event_context_snapshots
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_row public.event_context_snapshots%rowtype;
  v_context_org uuid := coalesce(p_provider_organization_id, p_client_organization_id, p_jurisdiction_organization_id);
BEGIN
  IF nullif(trim(coalesce(p_source_table, '')), '') IS NULL OR p_source_event_id IS NULL THEN
    RAISE EXCEPTION 'source_table and source_event_id are required';
  END IF;
  IF auth.uid() IS NULL OR v_context_org IS NULL OR NOT public.org_access_allowed(v_context_org) THEN
    RAISE EXCEPTION 'Event context organization access denied';
  END IF;
  IF p_client_site_id IS NOT NULL AND p_zone_id IS NOT NULL THEN
    RAISE EXCEPTION 'Event context Site and Zone are mutually exclusive';
  END IF;
  IF p_client_site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_sites s
    WHERE s.id = p_client_site_id
      AND (p_location_id IS NULL OR s.location_id = p_location_id)
  ) THEN
    RAISE EXCEPTION 'Event context Site does not match the House';
  END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.location_zones z
    WHERE z.id = p_zone_id
      AND (p_location_id IS NULL OR z.location_id = p_location_id)
  ) THEN
    RAISE EXCEPTION 'Event context Zone does not match the House';
  END IF;
  IF p_service_agreement_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.service_agreements sa
    WHERE sa.id = p_service_agreement_id
      AND (p_provider_organization_id IS NULL OR sa.provider_organization_id = p_provider_organization_id)
      AND (p_client_organization_id IS NULL OR sa.client_organization_id = p_client_organization_id)
  ) THEN
    RAISE EXCEPTION 'Event context service agreement does not match its parties';
  END IF;
  IF p_checkpoint_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.patrol_checkpoints cp
      WHERE cp.id = p_checkpoint_id
        AND cp.organization_id = coalesce(p_provider_organization_id, p_client_organization_id, p_jurisdiction_organization_id)
        AND ((cp.client_site_id IS NOT NULL AND cp.client_site_id = p_client_site_id AND p_zone_id IS NULL)
          OR (cp.zone_id IS NOT NULL AND cp.zone_id = p_zone_id AND p_client_site_id IS NULL))
    ) THEN
      RAISE EXCEPTION 'Checkpoint does not match the event Site/Zone and organization';
    END IF;
  END IF;

  INSERT INTO public.event_context_snapshots (
    source_table, source_event_id, location_id, client_site_id, zone_id, checkpoint_id,
    module_key, service_agreement_id, provider_organization_id, client_organization_id,
    jurisdiction_organization_id, jurisdiction_rule_set_id, authority_snapshot, source_refs, captured_at
  ) VALUES (
    trim(p_source_table), p_source_event_id, p_location_id, p_client_site_id, p_zone_id, p_checkpoint_id,
    p_module_key, p_service_agreement_id, p_provider_organization_id, p_client_organization_id,
    p_jurisdiction_organization_id, p_jurisdiction_rule_set_id, coalesce(p_authority_snapshot, '{}'::jsonb),
    coalesce(p_source_refs, '{}'::jsonb), coalesce(p_captured_at, now())
  )
  ON CONFLICT (source_table, source_event_id) DO NOTHING
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.event_context_snapshots
    WHERE source_table = trim(p_source_table) AND source_event_id = p_source_event_id;
  END IF;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.create_event_context_snapshot(text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_event_context_snapshot(text,uuid,uuid,uuid,uuid,uuid,text,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,timestamptz) TO authenticated, service_role;
