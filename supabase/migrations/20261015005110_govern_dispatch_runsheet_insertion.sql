DROP FUNCTION IF EXISTS public.insert_adhoc_stop(
  uuid,
  uuid,
  uuid,
  text,
  timestamp with time zone,
  double precision,
  double precision
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_dispatch_runsheet_insert_request
  ON public.audit_log (organization_id, ((metadata ->> 'client_request_id')))
  WHERE action = 'dispatch_job_runsheet_insert'
    AND target_table = 'shift_stops'
    AND (metadata ->> 'client_request_id') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.insert_adhoc_stop(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_shift_id uuid,
  p_expected_job_status text,
  p_expected_shift_updated_at timestamp with time zone,
  p_reason text
)
RETURNS TABLE(
  shift_stop_id uuid,
  created boolean,
  dispatch_status text,
  runsheet_shift_id uuid,
  stop_order integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_job public.dispatch_jobs%rowtype;
  v_shift public.shifts%rowtype;
  v_stop public.shift_stops%rowtype;
  v_receipt public.audit_log%rowtype;
  v_shift_agreement_id uuid;
  v_module_key text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_max_order integer;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Active user required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF p_dispatch_job_id IS NULL OR p_shift_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch job and run sheet are required';
  END IF;
  IF p_expected_job_status IS NULL OR p_expected_shift_updated_at IS NULL THEN
    RAISE EXCEPTION 'Expected job and run-sheet state are required';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Reason is required';
  END IF;

  SELECT *
    INTO v_job
    FROM public.dispatch_jobs
   WHERE id = p_dispatch_job_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch job not found';
  END IF;
  IF NOT public.is_admin_for_org(v_job.organization_id) THEN
    RAISE EXCEPTION 'Active organization administrator required';
  END IF;

  SELECT *
    INTO v_receipt
    FROM public.audit_log
   WHERE organization_id = v_job.organization_id
     AND action = 'dispatch_job_runsheet_insert'
     AND target_table = 'shift_stops'
     AND metadata ->> 'client_request_id' = p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt.metadata ->> 'dispatch_job_id' IS DISTINCT FROM p_dispatch_job_id::text
       OR v_receipt.metadata ->> 'shift_id' IS DISTINCT FROM p_shift_id::text THEN
      RAISE EXCEPTION 'client_request_id has already been used for a different run-sheet insertion';
    END IF;

    SELECT *
      INTO v_stop
      FROM public.shift_stops
     WHERE id = v_receipt.target_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'The prior run-sheet insertion receipt no longer resolves to a stop';
    END IF;

    RETURN QUERY
    SELECT v_stop.id, false, v_job.status, v_stop.shift_id, v_stop.stop_order;
    RETURN;
  END IF;

  SELECT *
    INTO v_shift
    FROM public.shifts
   WHERE id = p_shift_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Run sheet not found';
  END IF;
  IF v_shift.organization_id IS DISTINCT FROM v_job.organization_id THEN
    RAISE EXCEPTION 'Dispatch job and run sheet must belong to the same organization';
  END IF;

  IF v_job.shift_stop_id IS NOT NULL THEN
    SELECT *
      INTO v_stop
      FROM public.shift_stops
     WHERE id = v_job.shift_stop_id;
    IF NOT FOUND OR v_stop.shift_id IS DISTINCT FROM p_shift_id THEN
      RAISE EXCEPTION 'Dispatch job is already assigned to another run sheet';
    END IF;

    RETURN QUERY
    SELECT v_stop.id, false, v_job.status, v_stop.shift_id, v_stop.stop_order;
    RETURN;
  END IF;

  IF v_job.status IS DISTINCT FROM p_expected_job_status THEN
    RAISE EXCEPTION 'Dispatch job changed from expected status % to %', p_expected_job_status, v_job.status;
  END IF;
  IF v_job.status NOT IN ('pending', 'dispatched', 'acknowledged') THEN
    RAISE EXCEPTION 'Only pending, dispatched or acknowledged jobs can be added to a run sheet';
  END IF;
  IF v_shift.updated_at IS DISTINCT FROM p_expected_shift_updated_at THEN
    RAISE EXCEPTION 'Run sheet changed after it was opened. Refresh and review it before adding the job';
  END IF;
  IF v_shift.status NOT IN ('published', 'accepted', 'in_progress') THEN
    RAISE EXCEPTION 'Only published, accepted or in-progress run sheets can receive an urgent job';
  END IF;
  IF v_job.shift_id IS NOT NULL AND v_job.shift_id IS DISTINCT FROM p_shift_id THEN
    RAISE EXCEPTION 'Dispatch job is already assigned to another shift';
  END IF;
  IF v_job.assigned_officer_id IS NOT NULL
     AND v_job.assigned_officer_id IS DISTINCT FROM v_shift.officer_user_id THEN
    RAISE EXCEPTION 'The job is assigned to a different officer than this run sheet';
  END IF;
  IF (v_job.client_site_id IS NULL) = (v_job.zone_id IS NULL) THEN
    RAISE EXCEPTION 'Dispatch job must resolve to exactly one Site or Zone before run-sheet insertion';
  END IF;
  IF v_job.service_agreement_id IS NULL THEN
    RAISE EXCEPTION 'Dispatch job must have a service agreement before run-sheet insertion';
  END IF;

  SELECT coalesce(sal.service_agreement_id, sam.service_agreement_id)
    INTO v_shift_agreement_id
    FROM public.shifts s
    LEFT JOIN public.service_agreement_locations sal
      ON sal.id = s.service_agreement_location_id
    LEFT JOIN public.service_agreement_modules sam
      ON sam.id = s.service_agreement_module_id
   WHERE s.id = v_shift.id;

  IF v_shift_agreement_id IS NULL
     OR v_shift_agreement_id IS DISTINCT FROM v_job.service_agreement_id THEN
    RAISE EXCEPTION 'Run sheet and dispatch job must resolve to the same service agreement';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.service_agreement_locations sal
     WHERE sal.service_agreement_id = v_job.service_agreement_id
       AND sal.status = 'active'
       AND (
         (v_job.client_site_id IS NOT NULL AND sal.site_id = v_job.client_site_id)
         OR (v_job.zone_id IS NOT NULL AND sal.zone_id = v_job.zone_id)
       )
  ) THEN
    RAISE EXCEPTION 'Dispatch place is not active under the run sheet service agreement';
  END IF;
  IF v_job.module_key IS NOT NULL
     AND v_shift.module_key IS NOT NULL
     AND v_job.module_key IS DISTINCT FROM v_shift.module_key THEN
    RAISE EXCEPTION 'Dispatch job module does not match the selected run sheet';
  END IF;

  v_module_key := coalesce(v_job.module_key, v_shift.module_key, v_shift.service_type);
  IF v_module_key IS NULL OR trim(v_module_key) = '' THEN
    RAISE EXCEPTION 'A canonical module is required for the run-sheet stop';
  END IF;

  SELECT coalesce(max(s.stop_order), 0)
    INTO v_max_order
    FROM public.shift_stops s
   WHERE s.shift_id = v_shift.id;

  INSERT INTO public.shift_stops (
    organization_id,
    shift_id,
    dispatch_job_id,
    site_id,
    zone_id,
    module_key,
    stop_order,
    visit_number,
    is_adhoc,
    sla_window_open,
    sla_arrive_by,
    required_dwell_minutes,
    status,
    sla_status,
    officer_instructions
  )
  VALUES (
    v_job.organization_id,
    v_shift.id,
    v_job.id,
    v_job.client_site_id,
    v_job.zone_id,
    v_module_key,
    v_max_order + 10,
    1,
    true,
    v_job.created_at,
    coalesce(
      v_job.sla_respond_by,
      v_job.created_at + make_interval(mins => greatest(coalesce(v_job.sla_minutes, 15), 1))
    ),
    greatest(coalesce(v_job.expected_dwell_minutes, 5), 1),
    'pending',
    CASE
      WHEN coalesce(
        v_job.sla_respond_by,
        v_job.created_at + make_interval(mins => greatest(coalesce(v_job.sla_minutes, 15), 1))
      ) < now() THEN 'breached'
      ELSE 'on_track'
    END,
    v_job.briefing_notes
  )
  RETURNING * INTO v_stop;

  UPDATE public.dispatch_jobs
     SET shift_id = v_shift.id,
         shift_stop_id = v_stop.id,
         assigned_officer_id = coalesce(assigned_officer_id, v_shift.officer_user_id),
         adhoc_inserted_at = now(),
         status = 'dispatched',
         dispatched_at = coalesce(dispatched_at, now())
   WHERE id = v_job.id;

  UPDATE public.shifts
     SET total_stops = total_stops + 1,
         updated_at = now()
   WHERE id = v_shift.id;

  UPDATE public.patrol_solve_cache
     SET invalidated_at = now(),
         invalidation_reason = 'dispatch_job_runsheet_insert'
   WHERE shift_id = v_shift.id;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  )
  VALUES (
    v_job.organization_id,
    v_actor,
    'dispatch_job_runsheet_insert',
    'shift_stops',
    v_stop.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'dispatch_job_id', v_job.id,
      'shift_id', v_shift.id,
      'officer_user_id', v_shift.officer_user_id,
      'service_agreement_id', v_job.service_agreement_id,
      'site_id', v_job.client_site_id,
      'zone_id', v_job.zone_id,
      'module_key', v_module_key,
      'stop_order', v_stop.stop_order,
      'previous_job_status', v_job.status,
      'new_job_status', 'dispatched',
      'reason', v_reason
    )
  );

  RETURN QUERY
  SELECT v_stop.id, true, 'dispatched'::text, v_stop.shift_id, v_stop.stop_order;
END;
$function$;

COMMENT ON FUNCTION public.insert_adhoc_stop(uuid, uuid, uuid, text, timestamp with time zone, text)
  IS 'Adds an eligible dispatch job to one current officer run sheet. Requires administrator authority, exact organization/agreement/place/officer alignment, optimistic job and shift state, replay identity, and writes an audit receipt.';

REVOKE ALL ON FUNCTION public.insert_adhoc_stop(uuid, uuid, uuid, text, timestamp with time zone, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.insert_adhoc_stop(uuid, uuid, uuid, text, timestamp with time zone, text)
  TO postgres, authenticated, service_role;