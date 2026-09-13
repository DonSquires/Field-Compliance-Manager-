-- Canonical future event writer. Inserts the place event and immutable context
-- snapshot in one transaction; no module should write location_events directly
-- once migrated to this entry point.
CREATE OR REPLACE FUNCTION public.create_location_event(
  p_organization_id uuid,
  p_event_type text,
  p_client_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_checkpoint_id uuid DEFAULT NULL,
  p_module_key text DEFAULT NULL,
  p_occurred_at timestamptz DEFAULT now(),
  p_status text DEFAULT NULL,
  p_source text DEFAULT NULL,
  p_external_ref text DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb,
  p_observed_entity_type text DEFAULT NULL,
  p_observed_entity_id uuid DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_service_agreement_id uuid DEFAULT NULL,
  p_provider_organization_id uuid DEFAULT NULL,
  p_client_organization_id uuid DEFAULT NULL,
  p_jurisdiction_organization_id uuid DEFAULT NULL,
  p_jurisdiction_rule_set_id uuid DEFAULT NULL,
  p_authority_snapshot jsonb DEFAULT '{}'::jsonb,
  p_source_refs jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE(event_id uuid, context_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_event public.location_events%rowtype;
  v_context public.event_context_snapshots%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Location event organization access denied';
  END IF;
  IF nullif(trim(coalesce(p_event_type, '')), '') IS NULL THEN
    RAISE EXCEPTION 'event_type is required';
  END IF;

  INSERT INTO public.location_events (
    organization_id, client_site_id, zone_id, checkpoint_id, event_type, module_key,
    occurred_at, status, source, external_ref, payload, observed_entity_type,
    observed_entity_id, created_by
  ) VALUES (
    p_organization_id, p_client_site_id, p_zone_id, p_checkpoint_id, trim(p_event_type), p_module_key,
    coalesce(p_occurred_at, now()), p_status, p_source, p_external_ref, coalesce(p_payload, '{}'::jsonb),
    p_observed_entity_type, p_observed_entity_id, v_actor
  ) RETURNING * INTO v_event;

  SELECT * INTO v_context
  FROM public.create_event_context_snapshot(
    'location_events', v_event.id, p_location_id, p_client_site_id, p_zone_id, p_checkpoint_id,
    p_module_key, p_service_agreement_id, p_provider_organization_id, p_client_organization_id,
    p_jurisdiction_organization_id, p_jurisdiction_rule_set_id, p_authority_snapshot,
    coalesce(p_source_refs, '{}'::jsonb) || jsonb_build_object('event_type', p_event_type, 'source', p_source),
    p_occurred_at
  );

  RETURN QUERY SELECT v_event.id, v_context.id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_location_event(uuid,text,uuid,uuid,uuid,text,timestamptz,text,text,text,jsonb,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_location_event(uuid,text,uuid,uuid,uuid,text,timestamptz,text,text,text,jsonb,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) TO authenticated, service_role;
