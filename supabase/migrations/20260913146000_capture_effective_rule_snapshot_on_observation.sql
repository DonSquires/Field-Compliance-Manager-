-- Capture the effective geofence/jurisdiction/module rule snapshot at the exact
-- observation time. This keeps the active rule context immutable even if the
-- zone or jurisdiction later changes.
CREATE OR REPLACE FUNCTION public.capture_observation_effective_rule_snapshot()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_ctx jsonb := coalesce(NEW.geofence_context, '{}'::jsonb);
  v_jur_id uuid := CASE WHEN NULLIF(v_ctx->>'governing_jurisdiction_id', '') IS NOT NULL THEN (v_ctx->>'governing_jurisdiction_id')::uuid ELSE NULL END;
  v_jur_name text := NULLIF(v_ctx->>'governing_jurisdiction_name', '');
  v_effective jsonb := coalesce(v_ctx->'effective_rules', '{}'::jsonb);
  v_status text := coalesce(NULLIF(v_ctx->>'resolution_status', ''), 'outside_all_geofences');
BEGIN
  IF NEW.module_key IS NULL OR NULLIF(trim(NEW.module_key), '') IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.effective_rule_snapshots (
    organization_id,
    module_key,
    governing_jurisdiction_id,
    governing_jurisdiction_name,
    matched_zone_id,
    matched_site_id,
    matched_location_id,
    effective_rules,
    resolution_status,
    source_event_table,
    source_event_id,
    captured_at
  ) VALUES (
    NEW.organization_id,
    NEW.module_key,
    v_jur_id,
    v_jur_name,
    NEW.zone_id,
    NEW.site_id,
    NEW.location_id,
    v_effective,
    v_status,
    'observations',
    NEW.id,
    NEW.observed_at
  )
  ON CONFLICT (source_event_table, source_event_id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        module_key = EXCLUDED.module_key,
        governing_jurisdiction_id = EXCLUDED.governing_jurisdiction_id,
        governing_jurisdiction_name = EXCLUDED.governing_jurisdiction_name,
        matched_zone_id = EXCLUDED.matched_zone_id,
        matched_site_id = EXCLUDED.matched_site_id,
        matched_location_id = EXCLUDED.matched_location_id,
        effective_rules = EXCLUDED.effective_rules,
        resolution_status = EXCLUDED.resolution_status,
        captured_at = EXCLUDED.captured_at;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_observations_capture_effective_rule_snapshot ON public.observations;
CREATE TRIGGER trg_observations_capture_effective_rule_snapshot
  AFTER INSERT OR UPDATE OF geofence_context ON public.observations
  FOR EACH ROW EXECUTE FUNCTION public.capture_observation_effective_rule_snapshot();

REVOKE ALL ON FUNCTION public.capture_observation_effective_rule_snapshot() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_observation_effective_rule_snapshot() TO service_role;
