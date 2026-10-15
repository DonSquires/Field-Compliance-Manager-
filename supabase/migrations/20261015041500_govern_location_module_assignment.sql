-- Govern the per-place toolset authority.
--
-- `manage_location_module_assignment` is the only writer of
-- public.location_module_assignments, but it had no caller anywhere in the
-- build: no web surface, no edge function, no other RPC. A provider
-- administrator could not decide which module runs at which Location house
-- under an agreement, so the canon sentence "a guard on a place for a shift,
-- with a toolset" had no toolset step.
--
-- Before this ruling the authority was also unsafe to wire: no replay
-- receipt (a retried submit silently re-wrote the window) and no optimistic
-- concurrency (two administrators could clobber each other's effective dates
-- without either being told). This migration replaces the signature with a
-- replay-safe, optimistic one and keeps every pre-existing authorisation and
-- containment check intact.

CREATE UNIQUE INDEX idx_audit_location_module_assignment_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE action = 'location_module_assignment_set'
    AND target_table = 'location_module_assignments'
    AND (metadata ->> 'client_request_id') IS NOT NULL;

DROP FUNCTION public.manage_location_module_assignment(uuid, uuid, text, boolean, date, date);

CREATE FUNCTION public.manage_location_module_assignment(
  p_client_request_id uuid,
  p_location_id uuid,
  p_service_agreement_id uuid,
  p_module_key text,
  p_expected_updated_at timestamptz,
  p_enabled boolean,
  p_effective_from date,
  p_effective_to date
)
RETURNS public.location_module_assignments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_assignment public.location_module_assignments%rowtype;
  v_existing public.location_module_assignments%rowtype;
  v_receipt public.audit_log%rowtype;
  v_provider uuid;
  v_client uuid;
  v_effective_from date := coalesce(p_effective_from, current_date);
  v_enabled boolean := coalesce(p_enabled, true);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Active user required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF p_location_id IS NULL OR p_service_agreement_id IS NULL OR coalesce(btrim(p_module_key), '') = '' THEN
    RAISE EXCEPTION 'Location house, service agreement, and module are all required';
  END IF;
  IF p_effective_to IS NOT NULL AND p_effective_to < v_effective_from THEN
    RAISE EXCEPTION 'The end date cannot be before the start date';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('location-module-assignment:' || p_client_request_id::text, 0)
  );

  SELECT sa.provider_organization_id, sa.client_organization_id
    INTO v_provider, v_client
    FROM public.service_agreements sa
   WHERE sa.id = p_service_agreement_id
     AND sa.invitation_status = 'accepted'
     AND sa.starts_on <= v_effective_from
     AND (sa.ends_on IS NULL OR sa.ends_on >= v_effective_from);
  IF v_provider IS NULL THEN
    RAISE EXCEPTION 'Accepted active service agreement required';
  END IF;
  IF NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Provider administrator required';
  END IF;

  SELECT al.*
    INTO v_receipt
    FROM public.audit_log al
   WHERE al.organization_id = v_client
     AND al.action = 'location_module_assignment_set'
     AND al.target_table = 'location_module_assignments'
     AND al.metadata ->> 'client_request_id' = p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt.metadata ->> 'location_id' IS DISTINCT FROM p_location_id::text
       OR v_receipt.metadata ->> 'module_key' IS DISTINCT FROM p_module_key
       OR v_receipt.metadata ->> 'service_agreement_id' IS DISTINCT FROM p_service_agreement_id::text THEN
      RAISE EXCEPTION 'client_request_id has already been used for a different place or module';
    END IF;
    RETURN jsonb_populate_record(
      NULL::public.location_module_assignments,
      v_receipt.metadata -> 'record'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.service_agreement_modules sam
    WHERE sam.service_agreement_id = p_service_agreement_id
      AND sam.module_key = p_module_key
      AND sam.enabled
  ) THEN
    RAISE EXCEPTION 'Module is not enabled on the service agreement';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id) THEN
    RAISE EXCEPTION 'Location house not found';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.locations l
    WHERE l.id = p_location_id AND l.organization_id = v_client
  ) THEN
    RAISE EXCEPTION 'Location house is outside the service agreement client organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.service_agreement_locations sal
    LEFT JOIN public.client_sites cs ON cs.id = sal.site_id
    LEFT JOIN public.location_zones z ON z.id = sal.zone_id
    WHERE sal.service_agreement_id = p_service_agreement_id
      AND sal.status = 'active'
      AND (cs.location_id = p_location_id OR z.location_id = p_location_id)
  ) THEN
    RAISE EXCEPTION 'Service agreement has no active Site or Zone facet under this Location house';
  END IF;

  SELECT lma.*
    INTO v_existing
    FROM public.location_module_assignments lma
   WHERE lma.location_id = p_location_id
     AND lma.module_key = p_module_key
     AND lma.service_agreement_id = p_service_agreement_id
   FOR UPDATE;

  IF FOUND THEN
    IF p_expected_updated_at IS NULL
       OR v_existing.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'This module was changed at this place after the screen was opened. Reload before saving.';
    END IF;
  ELSIF p_expected_updated_at IS NOT NULL THEN
    RAISE EXCEPTION 'This module is no longer set at this place. Reload before saving.';
  END IF;

  INSERT INTO public.location_module_assignments (
    location_id, module_key, service_agreement_id, enabled, effective_from, effective_to, updated_at, created_by
  ) VALUES (
    p_location_id, p_module_key, p_service_agreement_id, v_enabled,
    v_effective_from, p_effective_to, now(), v_actor
  )
  ON CONFLICT (location_id, module_key, service_agreement_id)
  DO UPDATE SET enabled = excluded.enabled,
                effective_from = excluded.effective_from,
                effective_to = excluded.effective_to,
                updated_at = now()
  RETURNING * INTO v_assignment;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  )
  VALUES (
    v_client,
    v_actor,
    'location_module_assignment_set',
    'location_module_assignments',
    v_assignment.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'location_id', p_location_id,
      'module_key', p_module_key,
      'service_agreement_id', p_service_agreement_id,
      'enabled', v_assignment.enabled,
      'previous_enabled', v_existing.enabled,
      'previous_effective_from', v_existing.effective_from,
      'previous_effective_to', v_existing.effective_to,
      'effective_from', v_assignment.effective_from,
      'effective_to', v_assignment.effective_to,
      'record', to_jsonb(v_assignment)
    )
  );

  RETURN v_assignment;
END;
$function$;

COMMENT ON FUNCTION public.manage_location_module_assignment(
  uuid, uuid, uuid, text, timestamptz, boolean, date, date
) IS 'Replay-safe, optimistic per-place toolset authority. A provider administrator turns an agreement-enabled module on or off at one Location house, within the agreement term and only where the agreement has an active Site or Zone facet. Records before/after evidence against the client organisation.';

REVOKE ALL ON FUNCTION public.manage_location_module_assignment(
  uuid, uuid, uuid, text, timestamptz, boolean, date, date
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_location_module_assignment(
  uuid, uuid, uuid, text, timestamptz, boolean, date, date
) TO postgres, authenticated, service_role;
