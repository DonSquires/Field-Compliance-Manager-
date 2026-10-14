DROP FUNCTION IF EXISTS public.manage_shift_stop(uuid, text, text, integer, text);
DROP FUNCTION IF EXISTS public.manage_active_shift(uuid, text, text, text, text);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_dispatch_runsheet_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE action IN (
    'shift_stop_reorder',
    'shift_stop_skip',
    'shift_stop_cancel',
    'shift_amend',
    'shift_escalate',
    'shift_cancel'
  )
    AND target_table IN ('shift_stops', 'shifts')
    AND (metadata ->> 'client_request_id') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.manage_shift_stop(
  p_client_request_id uuid,
  p_stop_id uuid,
  p_expected_status text,
  p_expected_updated_at timestamptz,
  p_action text,
  p_new_order integer DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_shift_id uuid;
  v_stop public.shift_stops%rowtype;
  v_existing public.audit_log%rowtype;
  v_route_size integer;
  v_previous jsonb;
  v_resulting jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'A client request ID is required';
  END IF;

  SELECT ss.shift_id
  INTO v_shift_id
  FROM public.shift_stops ss
  WHERE ss.id = p_stop_id;

  IF v_shift_id IS NULL THEN
    RAISE EXCEPTION 'Shift stop not found or access denied';
  END IF;

  PERFORM 1
  FROM public.shift_stops ss
  WHERE ss.shift_id = v_shift_id
  ORDER BY ss.stop_order, ss.id
  FOR UPDATE;

  SELECT *
  INTO v_stop
  FROM public.shift_stops ss
  WHERE ss.id = p_stop_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shift stop not found or access denied';
  END IF;
  IF NOT public.is_admin_for_org(v_stop.organization_id) THEN
    RAISE EXCEPTION 'Shift stop not found or access denied';
  END IF;

  SELECT *
  INTO v_existing
  FROM public.audit_log al
  WHERE al.organization_id = v_stop.organization_id
    AND al.metadata ->> 'client_request_id' = p_client_request_id::text
    AND al.action IN (
      'shift_stop_reorder',
      'shift_stop_skip',
      'shift_stop_cancel',
      'shift_amend',
      'shift_escalate',
      'shift_cancel'
    )
    AND al.target_table IN ('shift_stops', 'shifts')
  ORDER BY al.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_existing.target_id IS DISTINCT FROM p_stop_id
      OR v_existing.action IS DISTINCT FROM ('shift_stop_' || p_action) THEN
      RAISE EXCEPTION 'Client request ID was already used for a different runsheet action';
    END IF;
    RETURN jsonb_build_object(
      'replayed', true,
      'action', p_action,
      'target_id', p_stop_id,
      'previous', v_existing.metadata -> 'previous',
      'resulting', v_existing.metadata -> 'resulting'
    );
  END IF;

  IF v_stop.status IS DISTINCT FROM p_expected_status
    OR v_stop.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Shift stop changed since it was opened';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('reorder', 'skip', 'cancel') THEN
    RAISE EXCEPTION 'Unsupported shift stop action';
  END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;
  IF length(trim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'The reason is too long';
  END IF;
  IF v_stop.actual_arrived_at IS NOT NULL
    OR v_stop.status IN ('on_scene', 'completed', 'skipped', 'cancelled') THEN
    RAISE EXCEPTION 'An attended or closed stop cannot be changed';
  END IF;

  v_previous := jsonb_build_object(
    'status', v_stop.status,
    'stop_order', v_stop.stop_order,
    'updated_at', v_stop.updated_at
  );

  IF p_action = 'reorder' THEN
    IF v_stop.status <> 'pending' THEN
      RAISE EXCEPTION 'Only a pending stop can change position';
    END IF;

    SELECT count(*)
    INTO v_route_size
    FROM public.shift_stops ss
    WHERE ss.shift_id = v_stop.shift_id;

    IF p_new_order IS NULL OR p_new_order < 1 OR p_new_order > v_route_size THEN
      RAISE EXCEPTION 'Stop position is outside the shift route';
    END IF;
    IF p_new_order = v_stop.stop_order THEN
      RAISE EXCEPTION 'The stop is already in that position';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM public.shift_stops ss
      WHERE ss.shift_id = v_stop.shift_id
      GROUP BY ss.stop_order
      HAVING count(*) > 1
    ) THEN
      RAISE EXCEPTION 'The shift route already has duplicate stop positions';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM (
        SELECT
          ss.stop_order,
          row_number() OVER (ORDER BY ss.stop_order, ss.id) AS expected_order
        FROM public.shift_stops ss
        WHERE ss.shift_id = v_stop.shift_id
      ) ordered_stops
      WHERE ordered_stops.stop_order <> ordered_stops.expected_order
    ) THEN
      RAISE EXCEPTION 'The shift route has non-contiguous stop positions';
    END IF;

    UPDATE public.shift_stops ss
    SET
      stop_order = CASE
        WHEN p_new_order < v_stop.stop_order THEN ss.stop_order + 1
        ELSE ss.stop_order - 1
      END,
      updated_at = clock_timestamp()
    WHERE ss.shift_id = v_stop.shift_id
      AND ss.id <> v_stop.id
      AND (
        (p_new_order < v_stop.stop_order AND ss.stop_order >= p_new_order AND ss.stop_order < v_stop.stop_order)
        OR
        (p_new_order > v_stop.stop_order AND ss.stop_order > v_stop.stop_order AND ss.stop_order <= p_new_order)
      );

    UPDATE public.shift_stops
    SET stop_order = p_new_order, updated_at = clock_timestamp()
    WHERE id = v_stop.id
    RETURNING * INTO v_stop;
  ELSE
    UPDATE public.shift_stops
    SET
      status = CASE WHEN p_action = 'skip' THEN 'skipped' ELSE 'cancelled' END,
      officer_notes = concat_ws(E'\n', officer_notes, trim(p_reason)),
      updated_at = clock_timestamp()
    WHERE id = v_stop.id
    RETURNING * INTO v_stop;
  END IF;

  v_resulting := jsonb_build_object(
    'status', v_stop.status,
    'stop_order', v_stop.stop_order,
    'updated_at', v_stop.updated_at
  );

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  ) VALUES (
    v_stop.organization_id,
    v_actor,
    'shift_stop_' || p_action,
    'shift_stops',
    v_stop.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'shift_id', v_stop.shift_id,
      'reason', trim(p_reason),
      'previous', v_previous,
      'resulting', v_resulting
    )
  );

  RETURN jsonb_build_object(
    'replayed', false,
    'action', p_action,
    'target_id', v_stop.id,
    'previous', v_previous,
    'resulting', v_resulting
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.manage_active_shift(
  p_client_request_id uuid,
  p_shift_id uuid,
  p_expected_status text,
  p_expected_updated_at timestamptz,
  p_action text,
  p_notes text DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_existing public.audit_log%rowtype;
  v_previous jsonb;
  v_resulting jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'A client request ID is required';
  END IF;

  SELECT *
  INTO v_shift
  FROM public.shifts s
  WHERE s.id = p_shift_id
  FOR UPDATE;

  IF NOT FOUND OR NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Shift not found or access denied';
  END IF;

  SELECT *
  INTO v_existing
  FROM public.audit_log al
  WHERE al.organization_id = v_shift.organization_id
    AND al.metadata ->> 'client_request_id' = p_client_request_id::text
    AND al.action IN (
      'shift_stop_reorder',
      'shift_stop_skip',
      'shift_stop_cancel',
      'shift_amend',
      'shift_escalate',
      'shift_cancel'
    )
    AND al.target_table IN ('shift_stops', 'shifts')
  ORDER BY al.created_at DESC
  LIMIT 1;

  IF FOUND THEN
    IF v_existing.target_id IS DISTINCT FROM p_shift_id
      OR v_existing.action IS DISTINCT FROM ('shift_' || p_action) THEN
      RAISE EXCEPTION 'Client request ID was already used for a different runsheet action';
    END IF;
    RETURN jsonb_build_object(
      'replayed', true,
      'action', p_action,
      'target_id', p_shift_id,
      'previous', v_existing.metadata -> 'previous',
      'resulting', v_existing.metadata -> 'resulting'
    );
  END IF;

  IF v_shift.status IS DISTINCT FROM p_expected_status
    OR v_shift.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Shift changed since it was opened';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('amend', 'escalate', 'cancel') THEN
    RAISE EXCEPTION 'Unsupported active shift action';
  END IF;
  IF nullif(trim(coalesce(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A reason is required';
  END IF;
  IF length(trim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'The reason is too long';
  END IF;
  IF v_shift.status IN ('completed', 'cancelled', 'declined') THEN
    RAISE EXCEPTION 'A closed shift cannot be changed';
  END IF;
  IF p_action = 'amend' AND nullif(trim(coalesce(p_notes, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Updated shift notes are required';
  END IF;
  IF p_action = 'amend' AND length(trim(p_notes)) > 4000 THEN
    RAISE EXCEPTION 'Shift notes are too long';
  END IF;
  IF p_action = 'cancel' AND v_shift.actual_start IS NOT NULL THEN
    RAISE EXCEPTION 'An active shift cannot be cancelled after it has started';
  END IF;

  v_previous := jsonb_build_object(
    'status', v_shift.status,
    'shift_health', v_shift.shift_health,
    'notes', v_shift.notes,
    'updated_at', v_shift.updated_at
  );

  UPDATE public.shifts
  SET
    notes = CASE WHEN p_action = 'amend' THEN trim(p_notes) ELSE notes END,
    shift_health = CASE WHEN p_action = 'escalate' THEN 'critical' ELSE shift_health END,
    status = CASE WHEN p_action = 'cancel' THEN 'cancelled' ELSE status END,
    updated_at = clock_timestamp()
  WHERE id = v_shift.id
  RETURNING * INTO v_shift;

  v_resulting := jsonb_build_object(
    'status', v_shift.status,
    'shift_health', v_shift.shift_health,
    'notes', v_shift.notes,
    'updated_at', v_shift.updated_at
  );

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  ) VALUES (
    v_shift.organization_id,
    v_actor,
    'shift_' || p_action,
    'shifts',
    v_shift.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'reason', trim(p_reason),
      'previous', v_previous,
      'resulting', v_resulting
    )
  );

  RETURN jsonb_build_object(
    'replayed', false,
    'action', p_action,
    'target_id', v_shift.id,
    'previous', v_previous,
    'resulting', v_resulting
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.manage_shift_stop(uuid, uuid, text, timestamptz, text, integer, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.manage_active_shift(uuid, uuid, text, timestamptz, text, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.manage_shift_stop(uuid, uuid, text, timestamptz, text, integer, text)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_active_shift(uuid, uuid, text, timestamptz, text, text, text)
  TO authenticated, service_role;