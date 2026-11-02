CREATE OR REPLACE FUNCTION public.submit_officer_timesheet_from_work(
  p_client_event_id uuid,
  p_period_start date,
  p_period_end date,
  p_adjustment_hours numeric DEFAULT 0,
  p_notes text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  created boolean,
  submitted_at timestamptz,
  work_derived_hours numeric,
  actual_hours numeric,
  source_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_staff public.staff_profiles%rowtype;
  v_sheet public.timesheets%rowtype;
  v_work record;
  v_work_json jsonb := '[]'::jsonb;
  v_work_minutes integer := 0;
  v_source_count integer := 0;
  v_adjustment numeric := coalesce(p_adjustment_hours, 0);
  v_actual numeric;
  v_scheduled numeric;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT sp.* INTO v_staff
  FROM public.staff_profiles sp
  JOIN public.user_profiles up ON up.id = v_user_id AND up.deactivated_at IS NULL
  WHERE (sp.user_id = v_user_id OR sp.id = v_user_id)
    AND sp.organization_id = up.organization_id
  LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active staff profile required'; END IF;
  IF p_client_event_id IS NULL THEN RAISE EXCEPTION 'client_event_id is required'; END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_start > p_period_end OR p_period_end - p_period_start > 31 THEN
    RAISE EXCEPTION 'Timesheet period must be between 1 and 32 days';
  END IF;
  IF p_period_end > current_date THEN RAISE EXCEPTION 'Future timesheet periods cannot be submitted'; END IF;
  IF v_adjustment < -744 OR v_adjustment > 744 THEN RAISE EXCEPTION 'Adjustment hours are outside the accepted range'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('timesheet_submission:' || v_staff.id::text, 0));

  SELECT t.* INTO v_sheet
  FROM public.timesheets t
  WHERE t.organization_id = v_staff.organization_id
    AND t.staff_id = v_staff.id
    AND t.client_event_id = p_client_event_id;
  IF FOUND THEN
    RETURN QUERY SELECT v_sheet.id, false, v_sheet.submitted_at,
      coalesce(v_sheet.work_derived_hours, 0), v_sheet.actual_hours,
      (SELECT count(*)::integer FROM public.timesheet_work_entries e WHERE e.timesheet_id = v_sheet.id);
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.timesheets t
    WHERE t.staff_id = v_staff.id
      AND daterange(t.period_start, t.period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) THEN
    RAISE EXCEPTION 'A timesheet already overlaps this period';
  END IF;

  FOR v_work IN SELECT * FROM public.get_officer_timesheet_work(p_period_start, p_period_end) LOOP
    v_work_minutes := v_work_minutes + v_work.calculated_minutes;
    v_source_count := v_source_count + 1;
    v_work_json := v_work_json || jsonb_build_array(jsonb_build_object(
      'source_type', v_work.source_type,
      'source_id', v_work.source_id,
      'work_status', v_work.work_status,
      'started_at', v_work.started_at,
      'ended_at', v_work.ended_at,
      'calculated_minutes', v_work.calculated_minutes,
      'label', v_work.label,
      'metadata', v_work.metadata
    ));
  END LOOP;

  v_actual := round((v_work_minutes::numeric / 60) + v_adjustment, 2);
  IF v_actual < 0 OR v_actual > 744 THEN RAISE EXCEPTION 'Derived actual hours are outside the accepted range'; END IF;

  SELECT coalesce(sum(extract(epoch FROM (s.scheduled_end - s.scheduled_start)) / 3600), 0)
  INTO v_scheduled
  FROM public.shifts s
  WHERE s.officer_user_id = v_user_id
    AND s.scheduled_start::date BETWEEN p_period_start AND p_period_end
    AND s.status IN ('accepted', 'in_progress', 'completed');

  INSERT INTO public.timesheets (
    organization_id, staff_id, period_start, period_end, scheduled_hours, actual_hours,
    overtime_hours, adjustment_hours, work_derived_hours, work_summary, status, notes,
    submitted_at, client_event_id
  )
  VALUES (
    v_staff.organization_id, v_staff.id, p_period_start, p_period_end,
    round(v_scheduled, 2), v_actual, greatest(0, v_actual - round(v_scheduled, 2)),
    v_adjustment, round(v_work_minutes::numeric / 60, 2),
    jsonb_build_object('source_count', v_source_count, 'work_minutes', v_work_minutes, 'entries', v_work_json),
    'submitted', nullif(trim(coalesce(p_notes, '')), ''), clock_timestamp(), p_client_event_id
  )
  RETURNING * INTO v_sheet;

  FOR v_work IN SELECT value FROM jsonb_array_elements(v_work_json) LOOP
    INSERT INTO public.timesheet_work_entries (
      organization_id, timesheet_id, source_type, source_id, work_status,
      started_at, ended_at, calculated_minutes, metadata
    )
    VALUES (
      v_staff.organization_id, v_sheet.id, v_work.value->>'source_type',
      (v_work.value->>'source_id')::uuid, v_work.value->>'work_status',
      (v_work.value->>'started_at')::timestamptz, (v_work.value->>'ended_at')::timestamptz,
      (v_work.value->>'calculated_minutes')::integer,
      coalesce(v_work.value->'metadata', '{}'::jsonb)
    );
  END LOOP;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (
    v_staff.organization_id, v_user_id, 'timesheet_submitted_from_work', 'timesheets', v_sheet.id,
    jsonb_build_object(
      'staff_id', v_sheet.staff_id,
      'period_start', p_period_start,
      'period_end', p_period_end,
      'work_derived_hours', v_sheet.work_derived_hours,
      'adjustment_hours', v_adjustment,
      'actual_hours', v_sheet.actual_hours,
      'source_count', v_source_count
    )
  );

  RETURN QUERY SELECT v_sheet.id, true, v_sheet.submitted_at,
    v_sheet.work_derived_hours, v_sheet.actual_hours, v_source_count;
END;
$function$;

COMMENT ON FUNCTION public.submit_officer_timesheet_from_work(uuid, date, date, numeric, text) IS
  'Submits the officer''s timesheet for a period from completed work (get_officer_timesheet_work). Rostered hours are the officer''s accepted/in-progress/completed shifts in the period across every branch; the timesheet itself belongs to the employer (home organisation). Submissions serialize per staff profile before idempotency and overlapping-period checks.';
