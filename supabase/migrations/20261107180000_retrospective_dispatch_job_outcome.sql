-- Historical noise-control outcomes must use the normal dispatch completion
-- and ledger paths, while keeping source-reported times distinct from an FCM
-- dispatch milestone or GPS capture.

CREATE OR REPLACE FUNCTION public.tg_dispatch_job_stamp_milestones()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'dispatched' AND NEW.dispatched_at IS NULL THEN
      NEW.dispatched_at := now();
    END IF;
    IF NEW.status = 'acknowledged' AND NEW.acknowledged_at IS NULL THEN
      NEW.acknowledged_at := now();
    END IF;
    IF NEW.status = 'en_route' AND NEW.en_route_at IS NULL THEN
      NEW.en_route_at := now();
    END IF;
    IF NEW.status = 'on_scene' AND NEW.on_scene_at IS NULL THEN
      NEW.on_scene_at := now();
    END IF;
    IF NEW.status = 'completed' AND NEW.completed_at IS NULL THEN
      NEW.completed_at := now();
    END IF;
    IF NEW.status IN ('acknowledged', 'en_route', 'on_scene', 'completed')
      AND NEW.dispatched_at IS NULL
      AND coalesce(pg_catalog.current_setting('fcm.retrospective_register_completion', true), '') <> 'on' THEN
      NEW.dispatched_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.tg_dispatch_job_stamp_milestones() IS
  'Fills lifecycle milestone timestamps when a governed path does not supply them. The audited retrospective-register path suppresses only the synthetic dispatched_at milestone.';

CREATE OR REPLACE FUNCTION public.record_retrospective_noise_job_outcome(
  p_client_request_id uuid,
  p_job_id uuid,
  p_expected_status text,
  p_source_name text,
  p_source_sha256 text,
  p_source_reference text,
  p_source_time_zone text,
  p_source_received_local text,
  p_source_arrived_local text,
  p_source_departed_local text,
  p_outcome_notes text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_job public.dispatch_jobs%rowtype;
  v_existing public.audit_log%rowtype;
  v_shift public.shifts%rowtype;
  v_now timestamptz;
  v_source_received timestamp without time zone;
  v_source_arrived timestamp without time zone;
  v_source_departed timestamp without time zone;
  v_arrived_at timestamptz;
  v_departed_at timestamptz;
  v_outcome text;
  v_previous jsonb;
  v_resulting jsonb;
  v_finance record;
  v_finance_result jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication is required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'A client request ID is required';
  END IF;

  SELECT * INTO v_job
  FROM public.dispatch_jobs j
  WHERE j.id = p_job_id
  FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_job.organization_id) THEN
    RAISE EXCEPTION 'Dispatch job not found or access denied';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_job.organization_id::text || ':' || p_client_request_id::text, 0)
  );

  SELECT * INTO v_existing
  FROM public.audit_log al
  WHERE al.organization_id = v_job.organization_id
    AND al.action = 'dispatch_job_retroactive_register_completion'
    AND al.target_table = 'dispatch_jobs'
    AND al.metadata ->> 'client_request_id' = p_client_request_id::text
  ORDER BY al.created_at DESC
  LIMIT 1;
  IF FOUND THEN
    IF v_existing.target_id IS DISTINCT FROM p_job_id THEN
      RAISE EXCEPTION 'Client request ID was already used for a different dispatch job';
    END IF;
    RETURN jsonb_build_object(
      'replayed', true,
      'target_id', p_job_id,
      'previous', v_existing.metadata -> 'previous',
      'resulting', v_existing.metadata -> 'resulting',
      'finance', v_existing.metadata -> 'finance'
    );
  END IF;

  IF p_expected_status IS DISTINCT FROM 'pending' OR v_job.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'Dispatch job changed since it was opened';
  END IF;
  IF v_job.job_type <> 'noise_control' AND v_job.module_key IS DISTINCT FROM 'noise_control' THEN
    RAISE EXCEPTION 'This action is only for noise-control jobs';
  END IF;
  IF v_job.client_site_id IS NULL THEN
    RAISE EXCEPTION 'The noise-source work place must be linked before recording an outcome';
  END IF;
  IF v_job.shift_stop_id IS NOT NULL THEN
    RAISE EXCEPTION 'This job is already on an officer stop; reconcile its attendance through the stop workflow';
  END IF;
  IF v_job.dispatched_at IS NOT NULL
    OR v_job.acknowledged_at IS NOT NULL
    OR v_job.en_route_at IS NOT NULL
    OR v_job.on_scene_at IS NOT NULL
    OR v_job.completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'This job already has lifecycle timestamps and needs review before retrospective completion';
  END IF;

  IF nullif(btrim(coalesce(p_source_name, '')), '') IS NULL
    OR length(btrim(p_source_name)) > 255
    OR pg_catalog.strpos(p_source_name, '/') > 0
    OR pg_catalog.strpos(p_source_name, pg_catalog.chr(92)) > 0
    OR lower(coalesce(p_source_sha256, '')) !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'A source file name and valid SHA-256 hash are required';
  END IF;
  IF coalesce(p_source_reference, '') !~ '^[0-9]{1,32}$'
    OR coalesce(v_job.briefing_notes, '') !~ ('(^|[^0-9])' || p_source_reference || '([^0-9]|$)') THEN
    RAISE EXCEPTION 'The register reference must exactly match a number in this job''s briefing';
  END IF;
  IF p_source_time_zone IS DISTINCT FROM 'Pacific/Auckland' THEN
    RAISE EXCEPTION 'Source times must be recorded in Pacific/Auckland';
  END IF;
  IF coalesce(p_source_received_local, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
    OR coalesce(p_source_arrived_local, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
    OR coalesce(p_source_departed_local, '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' THEN
    RAISE EXCEPTION 'Enter each source time as a New Zealand local date and time';
  END IF;
  BEGIN
    v_source_received := replace(p_source_received_local, 'T', ' ')::timestamp without time zone;
    v_source_arrived := replace(p_source_arrived_local, 'T', ' ')::timestamp without time zone;
    v_source_departed := replace(p_source_departed_local, 'T', ' ')::timestamp without time zone;
  EXCEPTION
    WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'One or more source date/time values are invalid';
  END;
  IF v_source_received > v_source_arrived OR v_source_arrived > v_source_departed THEN
    RAISE EXCEPTION 'Source times must be in received, on-site, off-site order';
  END IF;

  v_now := clock_timestamp();
  v_arrived_at := v_source_arrived AT TIME ZONE 'Pacific/Auckland';
  v_departed_at := v_source_departed AT TIME ZONE 'Pacific/Auckland';
  IF v_departed_at > v_now THEN
    RAISE EXCEPTION 'The source off-site time cannot be in the future';
  END IF;
  IF nullif(btrim(coalesce(p_outcome_notes, '')), '') IS NULL
    OR length(btrim(p_outcome_notes)) > 2000 THEN
    RAISE EXCEPTION 'Enter a source-reported outcome (up to 2,000 characters)';
  END IF;
  IF nullif(btrim(coalesce(p_reason, '')), '') IS NULL
    OR length(btrim(p_reason)) > 1000 THEN
    RAISE EXCEPTION 'A reason for the retrospective correction is required';
  END IF;

  v_previous := jsonb_build_object(
    'status', v_job.status,
    'dispatched_at', v_job.dispatched_at,
    'on_scene_at', v_job.on_scene_at,
    'completed_at', v_job.completed_at,
    'outcome_notes', v_job.outcome_notes
  );
  v_outcome := format(
    'Retrospective source-register outcome. Reference %s; source-reported on-site %s and off-site %s (%s). FCM did not capture GPS for this historical record. Outcome: %s',
    p_source_reference,
    p_source_arrived_local,
    p_source_departed_local,
    p_source_time_zone,
    btrim(p_outcome_notes)
  );

  PERFORM pg_catalog.set_config('fcm.retrospective_register_completion', 'on', true);
  UPDATE public.dispatch_jobs
  SET status = 'completed',
      on_scene_at = v_arrived_at,
      completed_at = v_departed_at,
      outcome_notes = v_outcome
  WHERE id = p_job_id
  RETURNING * INTO v_job;

  IF v_job.shift_id IS NOT NULL
    AND v_job.insert_gps_lat IS NULL
    AND v_job.insert_gps_lng IS NULL THEN
    SELECT * INTO v_shift
    FROM public.shifts s
    WHERE s.id = v_job.shift_id
      AND s.organization_id = v_job.organization_id
      AND s.officer_user_id IS NOT NULL;
  END IF;

  IF v_shift.id IS NOT NULL THEN
    SELECT * INTO v_finance
    FROM public.resolve_dispatch_job_financials_internal(
      v_actor,
      p_client_request_id,
      p_job_id,
      NULL
    );
    v_finance_result := jsonb_build_object(
      'status', CASE WHEN v_finance.unresolved_count > 0 THEN 'review_required' ELSE 'resolved' END,
      'pay_lines_written', v_finance.lines_written,
      'pay_total', v_finance.total_pay,
      'unresolved_pay_lines', v_finance.unresolved_count,
      'charge_lines_written', v_finance.charge_lines_written,
      'charge_total', v_finance.total_charge,
      'travel_basis', 'not_calculated_without_dispatch_origin'
    );
  ELSE
    v_finance_result := jsonb_build_object(
      'status', 'review_required',
      'reason', CASE
        WHEN v_job.shift_id IS NULL THEN 'No linked shift/officer is available for pay attribution'
        WHEN v_job.insert_gps_lat IS NOT NULL OR v_job.insert_gps_lng IS NOT NULL THEN 'Dispatch-origin coordinates are present; travel-based finance was not calculated'
        ELSE 'The linked shift has no officer in this organization'
      END
    );
  END IF;

  v_resulting := jsonb_build_object(
    'status', v_job.status,
    'on_scene_at', v_job.on_scene_at,
    'completed_at', v_job.completed_at,
    'dispatched_at', v_job.dispatched_at,
    'gps_captured', false,
    'shift_stop_created', false,
    'finance', v_finance_result
  );

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_job.organization_id,
    v_actor,
    'dispatch_job_retroactive_register_completion',
    'dispatch_jobs',
    v_job.id,
    jsonb_build_object(
      'client_request_id', p_client_request_id,
      'reason', btrim(p_reason),
      'recording_method', 'retrospective_source_register',
      'source', jsonb_build_object(
        'file_name', btrim(p_source_name),
        'sha256', lower(p_source_sha256),
        'reference', p_source_reference,
        'time_zone', p_source_time_zone,
        'received_local', p_source_received_local,
        'arrived_local', p_source_arrived_local,
        'departed_local', p_source_departed_local,
        'outcome_notes', btrim(p_outcome_notes)
      ),
      'gps_captured', false,
      'shift_stop_created', false,
      'previous', v_previous,
      'resulting', v_resulting,
      'finance', v_finance_result
    )
  );

  RETURN jsonb_build_object(
    'replayed', false,
    'target_id', v_job.id,
    'previous', v_previous,
    'resulting', v_resulting,
    'finance', v_finance_result
  );
END;
$$;

COMMENT ON FUNCTION public.record_retrospective_noise_job_outcome(uuid, uuid, text, text, text, text, text, text, text, text, text, text) IS
  'Admin-only, replay-safe completion of an unstarted noise-control job from an exact-match historical register record. Stores source-reported on/off-site times, creates no GPS fix or shift stop, preserves the normal location-event projection, and defers finance unless a linked shift/officer exists and no dispatch-origin coordinates could create unverified travel.';

REVOKE ALL ON FUNCTION public.record_retrospective_noise_job_outcome(uuid, uuid, text, text, text, text, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_retrospective_noise_job_outcome(uuid, uuid, text, text, text, text, text, text, text, text, text, text) TO authenticated, service_role;