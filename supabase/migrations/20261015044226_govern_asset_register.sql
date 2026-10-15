ALTER TABLE public.assets
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX assets_org_registration_unique
  ON public.assets (organization_id, lower(registration))
  WHERE registration IS NOT NULL AND btrim(registration) <> '';

CREATE UNIQUE INDEX assets_org_serial_number_unique
  ON public.assets (organization_id, lower(serial_number))
  WHERE serial_number IS NOT NULL AND btrim(serial_number) <> '';

CREATE UNIQUE INDEX idx_audit_asset_management_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE target_table = 'assets'
    AND action IN ('asset_created', 'asset_updated')
    AND (metadata ->> 'client_request_id') IS NOT NULL;

DROP FUNCTION public.manage_asset(
  uuid, text, uuid, text, text, text, text, text, text, integer, text, date, text
);

CREATE FUNCTION public.manage_asset(
  p_client_request_id uuid,
  p_action text,
  p_asset_id uuid DEFAULT NULL,
  p_expected_updated_at timestamptz DEFAULT NULL,
  p_asset_type text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_serial_number text DEFAULT NULL,
  p_registration text DEFAULT NULL,
  p_make text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_year integer DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_next_inspection_date date DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.assets
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_asset public.assets%rowtype;
  v_previous public.assets%rowtype;
  v_receipt public.audit_log%rowtype;
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_serial_number text := nullif(upper(btrim(coalesce(p_serial_number, ''))), '');
  v_registration text := nullif(upper(regexp_replace(btrim(coalesce(p_registration, '')), '\s+', '', 'g')), '');
  v_make text := nullif(btrim(coalesce(p_make, '')), '');
  v_model text := nullif(btrim(coalesce(p_model, '')), '');
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_audit_action text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Active user required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF p_action NOT IN ('create', 'update') THEN
    RAISE EXCEPTION 'Unsupported manage_asset action %', p_action;
  END IF;

  SELECT actor.organization_id
    INTO v_provider
    FROM public.user_profiles actor
   WHERE actor.id = v_actor
     AND actor.deactivated_at IS NULL;
  IF v_provider IS NULL OR NOT public.is_admin_for_org(v_provider) THEN
    RAISE EXCEPTION 'Active fleet administrator required';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('asset-management:' || p_client_request_id::text, 0)
  );

  SELECT al.*
    INTO v_receipt
    FROM public.audit_log al
   WHERE al.organization_id = v_provider
     AND al.target_table = 'assets'
     AND al.action IN ('asset_created', 'asset_updated')
     AND al.metadata ->> 'client_request_id' = p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt.metadata ->> 'request_action' IS DISTINCT FROM p_action
       OR (p_asset_id IS NOT NULL AND v_receipt.target_id IS DISTINCT FROM p_asset_id) THEN
      RAISE EXCEPTION 'client_request_id has already been used for a different asset action';
    END IF;
    RETURN jsonb_populate_record(NULL::public.assets, v_receipt.metadata -> 'record');
  END IF;

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'Asset name is required';
  END IF;
  IF p_asset_type NOT IN (
    'vehicle', 'radio', 'body_camera', 'torch', 'uniform',
    'first_aid_kit', 'ems_device', 'other'
  ) THEN
    RAISE EXCEPTION 'Unsupported asset type';
  END IF;
  IF coalesce(p_status, 'available') NOT IN (
    'available', 'in_use', 'maintenance', 'retired', 'lost'
  ) THEN
    RAISE EXCEPTION 'Unsupported asset status';
  END IF;
  IF p_year IS NOT NULL
     AND (p_year < 1900 OR p_year > extract(year FROM current_date)::integer + 1) THEN
    RAISE EXCEPTION 'Asset year must be between 1900 and next year';
  END IF;

  IF p_action = 'create' THEN
    IF p_asset_id IS NOT NULL OR p_expected_updated_at IS NOT NULL THEN
      RAISE EXCEPTION 'New assets cannot carry an existing asset ID or expected timestamp';
    END IF;
    IF p_status = 'in_use' THEN
      RAISE EXCEPTION 'An asset becomes in use only when it is signed out to a shift';
    END IF;

    INSERT INTO public.assets (
      organization_id,
      asset_type,
      name,
      serial_number,
      registration,
      make,
      model,
      year,
      status,
      next_inspection_date,
      notes,
      updated_at
    )
    VALUES (
      v_provider,
      p_asset_type,
      v_name,
      v_serial_number,
      v_registration,
      v_make,
      v_model,
      p_year,
      coalesce(p_status, 'available'),
      p_next_inspection_date,
      v_notes,
      now()
    )
    RETURNING * INTO v_asset;
    v_audit_action := 'asset_created';
  ELSE
    IF p_asset_id IS NULL OR p_expected_updated_at IS NULL THEN
      RAISE EXCEPTION 'Asset ID and expected updated timestamp are required for an update';
    END IF;

    SELECT a.*
      INTO v_previous
      FROM public.assets a
     WHERE a.id = p_asset_id
       AND a.organization_id = v_provider
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Asset not found';
    END IF;
    IF v_previous.updated_at IS DISTINCT FROM p_expected_updated_at THEN
      RAISE EXCEPTION 'This asset changed after it was opened. Reload it before saving.';
    END IF;
    IF p_asset_type IS DISTINCT FROM v_previous.asset_type THEN
      RAISE EXCEPTION 'Asset type cannot be changed after registration';
    END IF;
    IF p_status = 'in_use' AND v_previous.status <> 'in_use' THEN
      RAISE EXCEPTION 'An asset becomes in use only when it is signed out to a shift';
    END IF;
    IF p_status = 'available' AND EXISTS (
      SELECT 1
        FROM public.shift_assets link
       WHERE link.asset_id = v_previous.id
         AND link.returned_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Asset is still assigned to an active shift';
    END IF;

    UPDATE public.assets
       SET name = v_name,
           serial_number = v_serial_number,
           registration = v_registration,
           make = v_make,
           model = v_model,
           year = p_year,
           status = coalesce(p_status, status),
           next_inspection_date = p_next_inspection_date,
           notes = v_notes,
           updated_at = now()
     WHERE id = v_previous.id
    RETURNING * INTO v_asset;
    v_audit_action := 'asset_updated';
  END IF;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_provider,
    v_actor,
    v_audit_action,
    'assets',
    v_asset.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'request_action', p_action,
      'previous_record', CASE
        WHEN v_previous.id IS NULL THEN NULL
        ELSE to_jsonb(v_previous)
      END,
      'record', to_jsonb(v_asset)
    )
  );

  RETURN v_asset;
END;
$function$;

COMMENT ON FUNCTION public.manage_asset(
  uuid, text, uuid, timestamptz, text, text, text, text, text, text,
  integer, text, date, text
) IS 'Replay-safe, optimistic fleet and equipment register authority. Creates or updates one organization-owned asset, normalizes identifiers, prevents direct in-use transitions, and records before/after audit evidence.';

REVOKE ALL ON FUNCTION public.manage_asset(
  uuid, text, uuid, timestamptz, text, text, text, text, text, text,
  integer, text, date, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_asset(
  uuid, text, uuid, timestamptz, text, text, text, text, text, text,
  integer, text, date, text
) TO postgres, authenticated, service_role;