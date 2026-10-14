-- A continuity receipt is an accountable handoff, not a generic foreign-key
-- attachment. Keep replay idempotent, but reject first-time acknowledgement
-- after the projection expires and prove that any continuation event belongs
-- to the recipient at the same place and module.

CREATE OR REPLACE FUNCTION public.acknowledge_operational_continuity_item(
  p_client_request_id uuid,
  p_continuity_item_id uuid,
  p_acknowledgement_notes text DEFAULT NULL,
  p_continuation_location_event_id uuid DEFAULT NULL
)
RETURNS public.operational_continuity_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_item public.operational_continuity_items%rowtype;
  v_receipt public.operational_continuity_receipts%rowtype;
BEGIN
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;

  SELECT receipt.*
  INTO v_receipt
  FROM public.operational_continuity_receipts AS receipt
  WHERE receipt.recipient_organization_id = (
      SELECT item.recipient_organization_id
      FROM public.operational_continuity_items AS item
      WHERE item.id = p_continuity_item_id
    )
    AND receipt.client_request_id = p_client_request_id;

  IF FOUND THEN
    RETURN v_receipt;
  END IF;

  SELECT item.*
  INTO v_item
  FROM public.operational_continuity_items AS item
  WHERE item.id = p_continuity_item_id
  FOR UPDATE;

  IF NOT FOUND OR NOT public.is_admin_for_org(v_item.recipient_organization_id) THEN
    RAISE EXCEPTION 'Continuity item not available to your organization';
  END IF;

  IF v_item.operational_status <> 'active' OR v_item.expires_at < clock_timestamp() THEN
    RAISE EXCEPTION 'Continuity item is no longer active';
  END IF;

  IF p_continuation_location_event_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.location_events AS continuation
      WHERE continuation.id = p_continuation_location_event_id
        AND continuation.organization_id = v_item.recipient_organization_id
        AND continuation.module_key IS NOT DISTINCT FROM v_item.module_key
        AND continuation.occurred_at >= v_item.source_occurred_at
        AND (
          (v_item.client_site_id IS NOT NULL AND continuation.client_site_id = v_item.client_site_id)
          OR (v_item.zone_id IS NOT NULL AND continuation.zone_id = v_item.zone_id)
        )
    )
  THEN
    RAISE EXCEPTION 'Continuation event must belong to the recipient at the same place and module';
  END IF;

  INSERT INTO public.operational_continuity_receipts (
    continuity_item_id,
    recipient_organization_id,
    acknowledged_by,
    continuation_location_event_id,
    acknowledgement_notes,
    client_request_id
  )
  VALUES (
    v_item.id,
    v_item.recipient_organization_id,
    v_actor,
    p_continuation_location_event_id,
    NULLIF(trim(COALESCE(p_acknowledgement_notes, '')), ''),
    p_client_request_id
  )
  RETURNING * INTO v_receipt;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_item.recipient_organization_id,
    v_actor,
    'operational_continuity_acknowledged',
    'operational_continuity_items',
    v_item.id,
    jsonb_build_object(
      'source_organization_id', v_item.source_organization_id,
      'continuation_location_event_id', p_continuation_location_event_id
    )
  );

  RETURN v_receipt;
END;
$function$;

REVOKE ALL ON FUNCTION public.acknowledge_operational_continuity_item(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acknowledge_operational_continuity_item(uuid, uuid, text, uuid)
  TO authenticated, service_role;