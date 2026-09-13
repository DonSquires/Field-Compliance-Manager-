-- Canonical rule snapshot contract for future event writes. This captures the
-- governed effective rule state at the moment of the event, so the event can be
-- audited even when the geofence or agreement later changes.
CREATE TABLE IF NOT EXISTS public.effective_rule_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  module_key text NOT NULL,
  governing_jurisdiction_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  governing_jurisdiction_name text,
  matched_zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  matched_site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  matched_location_id uuid REFERENCES public.locations(id) ON DELETE RESTRICT,
  rule_set_id uuid,
  rule_set_name text,
  jurisdiction_rule_set_id uuid REFERENCES public.jurisdiction_rule_sets(id) ON DELETE RESTRICT,
  effective_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolution_status text NOT NULL DEFAULT 'outside_all_geofences',
  source_event_table text,
  source_event_id uuid,
  captured_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT effective_rule_snapshots_source_unique UNIQUE (source_event_table, source_event_id)
);

COMMENT ON TABLE public.effective_rule_snapshots IS
  'Immutable geofence + jurisdiction + module rule snapshot captured at event time. The rule snapshot is context, not the place anchor.';

ALTER TABLE public.effective_rule_snapshots ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_effective_rule_snapshots_event ON public.effective_rule_snapshots (source_event_table, source_event_id);
CREATE INDEX IF NOT EXISTS idx_effective_rule_snapshots_module ON public.effective_rule_snapshots (module_key, governing_jurisdiction_id, captured_at DESC);

CREATE OR REPLACE FUNCTION public.capture_effective_rule_snapshot(
  p_organization_id uuid,
  p_module_key text,
  p_governing_jurisdiction_id uuid DEFAULT NULL,
  p_governing_jurisdiction_name text DEFAULT NULL,
  p_matched_zone_id uuid DEFAULT NULL,
  p_matched_site_id uuid DEFAULT NULL,
  p_matched_location_id uuid DEFAULT NULL,
  p_rule_set_id uuid DEFAULT NULL,
  p_rule_set_name text DEFAULT NULL,
  p_jurisdiction_rule_set_id uuid DEFAULT NULL,
  p_effective_rules jsonb DEFAULT '{}'::jsonb,
  p_resolution_status text DEFAULT 'outside_all_geofences',
  p_source_event_table text DEFAULT NULL,
  p_source_event_id uuid DEFAULT NULL,
  p_captured_at timestamptz DEFAULT now()
)
RETURNS public.effective_rule_snapshots
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_row public.effective_rule_snapshots%rowtype;
BEGIN
  IF p_organization_id IS NULL OR nullif(trim(coalesce(p_module_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'organization_id and module_key are required';
  END IF;

  INSERT INTO public.effective_rule_snapshots (
    organization_id, module_key, governing_jurisdiction_id, governing_jurisdiction_name,
    matched_zone_id, matched_site_id, matched_location_id, rule_set_id, rule_set_name,
    jurisdiction_rule_set_id, effective_rules, resolution_status,
    source_event_table, source_event_id, captured_at
  ) VALUES (
    p_organization_id, p_module_key, p_governing_jurisdiction_id,
    p_governing_jurisdiction_name, p_matched_zone_id, p_matched_site_id,
    p_matched_location_id, p_rule_set_id, p_rule_set_name,
    p_jurisdiction_rule_set_id, coalesce(p_effective_rules, '{}'::jsonb),
    coalesce(p_resolution_status, 'outside_all_geofences'),
    p_source_event_table, p_source_event_id, coalesce(p_captured_at, now())
  )
  ON CONFLICT (source_event_table, source_event_id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        module_key = EXCLUDED.module_key,
        governing_jurisdiction_id = EXCLUDED.governing_jurisdiction_id,
        governing_jurisdiction_name = EXCLUDED.governing_jurisdiction_name,
        matched_zone_id = EXCLUDED.matched_zone_id,
        matched_site_id = EXCLUDED.matched_site_id,
        matched_location_id = EXCLUDED.matched_location_id,
        rule_set_id = EXCLUDED.rule_set_id,
        rule_set_name = EXCLUDED.rule_set_name,
        jurisdiction_rule_set_id = EXCLUDED.jurisdiction_rule_set_id,
        effective_rules = EXCLUDED.effective_rules,
        resolution_status = EXCLUDED.resolution_status,
        captured_at = EXCLUDED.captured_at
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_effective_rule_snapshot(uuid,text,uuid,text,uuid,uuid,uuid,uuid,text,uuid,jsonb,text,text,uuid,timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_effective_rule_snapshot(uuid,text,uuid,text,uuid,uuid,uuid,uuid,text,uuid,jsonb,text,text,uuid,timestamptz) TO authenticated, service_role;
