-- Enforce the most-specific event anchor contract for new/updated events.
-- A checkpoint already has exactly one parent facet (Site XOR Zone); an event
-- carrying that checkpoint must select the same facet and organization.
CREATE OR REPLACE FUNCTION public.validate_location_event_checkpoint_anchor()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_checkpoint public.patrol_checkpoints%rowtype;
BEGIN
  IF NEW.client_site_id IS NOT NULL AND NEW.zone_id IS NOT NULL THEN
    RAISE EXCEPTION 'Location event must reference a Site or Zone, not both';
  END IF;
  IF NEW.checkpoint_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_checkpoint FROM public.patrol_checkpoints WHERE id = NEW.checkpoint_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Checkpoint not found'; END IF;
  IF NEW.organization_id IS DISTINCT FROM v_checkpoint.organization_id THEN
    RAISE EXCEPTION 'Checkpoint and event organization do not match';
  END IF;
  IF v_checkpoint.client_site_id IS NOT NULL THEN
    IF NEW.client_site_id IS DISTINCT FROM v_checkpoint.client_site_id OR NEW.zone_id IS NOT NULL THEN
      RAISE EXCEPTION 'Checkpoint belongs to a different Site than the event anchor';
    END IF;
  ELSIF v_checkpoint.zone_id IS NOT NULL THEN
    IF NEW.zone_id IS DISTINCT FROM v_checkpoint.zone_id OR NEW.client_site_id IS NOT NULL THEN
      RAISE EXCEPTION 'Checkpoint belongs to a different Zone than the event anchor';
    END IF;
  ELSE
    RAISE EXCEPTION 'Checkpoint has no Site or Zone parent';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_location_event_checkpoint_anchor ON public.location_events;
CREATE TRIGGER trg_validate_location_event_checkpoint_anchor
  BEFORE INSERT OR UPDATE OF checkpoint_id, client_site_id, zone_id, organization_id
  ON public.location_events
  FOR EACH ROW EXECUTE FUNCTION public.validate_location_event_checkpoint_anchor();

REVOKE ALL ON FUNCTION public.validate_location_event_checkpoint_anchor() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.validate_location_event_checkpoint_anchor() TO authenticated, service_role;
