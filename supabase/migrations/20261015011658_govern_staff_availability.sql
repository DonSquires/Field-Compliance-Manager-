ALTER TABLE public.staff_availability
  ADD CONSTRAINT staff_availability_schedule_xor
  CHECK ((day_of_week IS NULL) <> (specific_date IS NULL)),
  ADD CONSTRAINT staff_availability_day_range
  CHECK (day_of_week IS NULL OR day_of_week BETWEEN 1 AND 7),
  ADD CONSTRAINT staff_availability_type_check
  CHECK (availability_type IN ('available', 'preferred', 'unavailable', 'leave')),
  ADD CONSTRAINT staff_availability_time_check
  CHECK (
    (all_day AND available_from IS NULL AND available_to IS NULL)
    OR (
      NOT all_day
      AND available_from IS NOT NULL
      AND available_to IS NOT NULL
      AND available_from < available_to
    )
  );

CREATE UNIQUE INDEX idx_audit_staff_availability_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE action IN ('staff_availability_created', 'staff_availability_deleted')
    AND target_table = 'staff_availability'
    AND (metadata ->> 'client_request_id') IS NOT NULL;

DROP POLICY IF EXISTS staff_availability_insert ON public.staff_availability;
DROP POLICY IF EXISTS staff_availability_update ON public.staff_availability;

REVOKE ALL ON TABLE public.staff_availability FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.staff_availability TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.staff_availability TO service_role;

CREATE OR REPLACE FUNCTION public.manage_staff_availability(
  p_client_request_id uuid,
  p_staff_id uuid,
  p_action text,
  p_availability_id uuid DEFAULT NULL,
  p_day_of_week integer DEFAULT NULL,
  p_specific_date date DEFAULT NULL,
  p_available_from time DEFAULT NULL,
  p_available_to time DEFAULT NULL,
  p_all_day boolean DEFAULT false,
  p_type text DEFAULT 'unavailable',
  p_notes text DEFAULT NULL
)
RETURNS public.staff_availability
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_avail public.staff_availability%rowtype;
  v_receipt public.audit_log%rowtype;
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Active user required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF p_action NOT IN ('create', 'delete') THEN
    RAISE EXCEPTION 'Unsupported manage_staff_availability action %', p_action;
  END IF;

  SELECT sp.*
    INTO v_staff
    FROM public.staff_profiles sp
   WHERE sp.id = p_staff_id OR sp.user_id = p_staff_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Staff profile not found';
  END IF;
  IF NOT public.is_admin_for_org(v_staff.organization_id)
     AND v_staff.user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Not authorised to manage availability for this staff member';
  END IF;

  SELECT al.*
    INTO v_receipt
    FROM public.audit_log al
   WHERE al.organization_id = v_staff.organization_id
     AND al.action IN ('staff_availability_created', 'staff_availability_deleted')
     AND al.target_table = 'staff_availability'
     AND al.metadata ->> 'client_request_id' = p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt.metadata ->> 'staff_id' IS DISTINCT FROM v_staff.id::text
       OR v_receipt.metadata ->> 'requested_action' IS DISTINCT FROM p_action THEN
      RAISE EXCEPTION 'client_request_id has already been used for a different availability action';
    END IF;
    v_avail := jsonb_populate_record(
      NULL::public.staff_availability,
      v_receipt.metadata -> 'record'
    );
    RETURN v_avail;
  END IF;

  IF p_action = 'create' THEN
    IF (p_day_of_week IS NULL) = (p_specific_date IS NULL) THEN
      RAISE EXCEPTION 'Choose either a recurring weekday or one specific date';
    END IF;
    IF p_day_of_week IS NOT NULL AND p_day_of_week NOT BETWEEN 1 AND 7 THEN
      RAISE EXCEPTION 'Recurring weekday must be from 1 to 7';
    END IF;
    IF p_type NOT IN ('available', 'preferred', 'unavailable', 'leave') THEN
      RAISE EXCEPTION 'Unsupported availability type';
    END IF;
    IF p_all_day AND (p_available_from IS NOT NULL OR p_available_to IS NOT NULL) THEN
      RAISE EXCEPTION 'All-day availability must not include start or end times';
    END IF;
    IF NOT p_all_day AND (
      p_available_from IS NULL
      OR p_available_to IS NULL
      OR p_available_from >= p_available_to
    ) THEN
      RAISE EXCEPTION 'Part-day availability requires a start time before its end time';
    END IF;
    IF p_type IN ('unavailable', 'leave') AND v_notes IS NULL THEN
      RAISE EXCEPTION 'A reason is required when staff cannot work';
    END IF;

    INSERT INTO public.staff_availability (
      staff_id,
      organization_id,
      day_of_week,
      specific_date,
      available_from,
      available_to,
      all_day,
      availability_type,
      notes
    )
    VALUES (
      v_staff.id,
      v_staff.organization_id,
      p_day_of_week,
      p_specific_date,
      CASE WHEN p_all_day THEN NULL ELSE p_available_from END,
      CASE WHEN p_all_day THEN NULL ELSE p_available_to END,
      p_all_day,
      p_type,
      v_notes
    )
    RETURNING * INTO v_avail;

    INSERT INTO public.audit_log (
      organization_id,
      actor_user_id,
      action,
      target_table,
      target_id,
      metadata
    )
    VALUES (
      v_staff.organization_id,
      v_actor,
      'staff_availability_created',
      'staff_availability',
      v_avail.id,
      jsonb_build_object(
        'staff_id', v_staff.id,
        'requested_action', p_action,
        'client_request_id', p_client_request_id,
        'record', to_jsonb(v_avail)
      )
    );

    RETURN v_avail;
  END IF;

  IF p_availability_id IS NULL THEN
    RAISE EXCEPTION 'Availability record is required for deletion';
  END IF;
  IF v_notes IS NULL THEN
    RAISE EXCEPTION 'A removal reason is required';
  END IF;

  SELECT sa.*
    INTO v_avail
    FROM public.staff_availability sa
   WHERE sa.id = p_availability_id
     AND sa.organization_id = v_staff.organization_id
     AND sa.staff_id = v_staff.id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Availability record not found for this staff member';
  END IF;

  DELETE FROM public.staff_availability
   WHERE id = v_avail.id;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_staff.organization_id,
    v_actor,
    'staff_availability_deleted',
    'staff_availability',
    v_avail.id,
    jsonb_build_object(
      'staff_id', v_staff.id,
      'requested_action', p_action,
      'client_request_id', p_client_request_id,
      'reason', v_notes,
      'record', to_jsonb(v_avail)
    )
  );

  RETURN v_avail;
END;
$function$;

COMMENT ON FUNCTION public.manage_staff_availability(
  uuid,
  uuid,
  text,
  uuid,
  integer,
  date,
  time,
  time,
  boolean,
  text,
  text
) IS 'Replay-safe staff availability create/delete authority. Binds deletion to the selected staff member, validates schedule shape, and records an immutable audit receipt.';

REVOKE ALL ON FUNCTION public.manage_staff_availability(
  uuid,
  uuid,
  text,
  uuid,
  integer,
  date,
  time,
  time,
  boolean,
  text,
  text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.manage_staff_availability(
  uuid,
  uuid,
  text,
  uuid,
  integer,
  date,
  time,
  time,
  boolean,
  text,
  text
) TO postgres, authenticated, service_role;