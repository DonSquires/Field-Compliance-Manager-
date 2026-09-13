-- Migrate the first high-volume module event producer safely. An AFTER INSERT
-- trigger keeps the observation, canonical location_events row, and immutable
-- context snapshot in one database transaction; no best-effort edge dual-write.
CREATE OR REPLACE FUNCTION public.sync_observation_to_location_event()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_event_id uuid;
BEGIN
  IF NEW.site_id IS NOT NULL AND NEW.zone_id IS NOT NULL THEN
    RAISE EXCEPTION 'Observation must reference a Site or Zone, not both';
  END IF;

  -- Unresolved historical-style captures remain in the source table and receive
  -- context provenance, but do not create an invalid location_events row.
  IF NEW.site_id IS NULL AND NEW.zone_id IS NULL THEN
    INSERT INTO public.event_context_snapshots (
      source_table, source_event_id, location_id, module_key, provider_organization_id,
      client_organization_id, authority_snapshot, source_refs, captured_at
    ) VALUES (
      'observations', NEW.id, NEW.location_id, NEW.module_key, NEW.organization_id,
      NEW.client_org_id, jsonb_build_object('officer_id', NEW.officer_id),
      jsonb_build_object('source', 'observation_trigger', 'unresolved_reason', 'no_site_or_zone'), NEW.observed_at
    ) ON CONFLICT (source_table, source_event_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO public.location_events (
    organization_id, client_site_id, zone_id, event_type, module_key, occurred_at,
    status, source, external_ref, payload, observed_entity_type, observed_entity_id, created_by
  ) VALUES (
    NEW.organization_id, NEW.site_id, NEW.zone_id, 'observation', NEW.module_key, NEW.observed_at,
    coalesce(NEW.compliance_status, 'recorded'), 'observation_trigger', NEW.id::text,
    jsonb_build_object('observation_id', NEW.id, 'plate_number', NEW.plate_number,
      'compliance_status', NEW.compliance_status), 'vehicle', NEW.id, NEW.officer_id
  ) RETURNING id INTO v_event_id;

  INSERT INTO public.event_context_snapshots (
    source_table, source_event_id, location_id, client_site_id, zone_id, module_key,
    provider_organization_id, client_organization_id, authority_snapshot, source_refs, captured_at
  ) VALUES (
    'observations', NEW.id, NEW.location_id, NEW.site_id, NEW.zone_id, NEW.module_key,
    NEW.organization_id, NEW.client_org_id, jsonb_build_object('officer_id', NEW.officer_id),
    jsonb_build_object('location_event_id', v_event_id, 'source', 'observation_trigger'), NEW.observed_at
  ) ON CONFLICT (source_table, source_event_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_observations_location_event_context ON public.observations;
CREATE TRIGGER trg_observations_location_event_context
  AFTER INSERT ON public.observations
  FOR EACH ROW EXECUTE FUNCTION public.sync_observation_to_location_event();

REVOKE ALL ON FUNCTION public.sync_observation_to_location_event() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_observation_to_location_event() TO service_role;
