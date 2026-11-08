CREATE OR REPLACE FUNCTION public.get_officer_timesheet_work(p_period_start date, p_period_end date)
RETURNS TABLE(source_type text, source_id uuid, work_status text, started_at timestamptz,
  ended_at timestamptz, calculated_minutes integer, label text, metadata jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_period_start timestamptz := p_period_start::timestamptz;
  v_period_end timestamptz := (p_period_end + 1)::timestamptz;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_start > p_period_end THEN
    RAISE EXCEPTION 'Invalid timesheet period';
  END IF;
  SELECT organization_id INTO v_org_id FROM public.user_profiles
    WHERE id = v_user_id AND deactivated_at IS NULL;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Active staff profile required'; END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT s.*, coalesce(r.planned_break_minutes, 0) AS planned_minutes,
      coalesce(r.break_unpaid, false) AS mandatory_unpaid,
      abs(extract(epoch FROM (s.actual_start - s.scheduled_start))) <= 900 AS start_within,
      abs(extract(epoch FROM (s.actual_end - s.scheduled_end))) <= 900 AS finish_within,
      CASE WHEN abs(extract(epoch FROM (s.actual_start - s.scheduled_start))) <= 900
        THEN s.scheduled_start ELSE s.actual_start END AS candidate_start,
      CASE WHEN abs(extract(epoch FROM (s.actual_end - s.scheduled_end))) <= 900
        THEN s.scheduled_end ELSE s.actual_end END AS candidate_end
    FROM public.shifts s
    LEFT JOIN public.roster_slots r ON r.linked_shift_id = s.id
    WHERE s.officer_user_id = v_user_id AND s.status = 'completed'
      AND s.actual_start IS NOT NULL AND s.actual_end > s.actual_start
  ), windows AS (
    SELECT c.*,
      greatest(CASE WHEN candidate_end > candidate_start THEN candidate_start ELSE actual_start END, v_period_start) AS w_start,
      least(CASE WHEN candidate_end > candidate_start THEN candidate_end ELSE actual_end END, v_period_end) AS w_end
    FROM candidates c
  ), break_totals AS (
    SELECT w.*,
      coalesce(b.recorded_unpaid, 0) AS recorded_unpaid,
      coalesce(b.period_unpaid, 0) AS period_unpaid,
      coalesce(b.prior_unpaid, 0) AS prior_unpaid,
      coalesce(b.paid_minutes, 0) AS paid_minutes,
      coalesce(b.open_unpaid, false) AS open_unpaid
    FROM windows w
    CROSS JOIN LATERAL (
      SELECT sum(greatest(0, extract(epoch FROM (least(sb.ended_at, w.actual_end) - greatest(sb.started_at, w.actual_start))) / 60))
          FILTER (WHERE NOT sb.is_paid AND sb.ended_at IS NOT NULL) AS recorded_unpaid,
        sum(greatest(0, extract(epoch FROM (least(sb.ended_at, w.actual_end, v_period_end) - greatest(sb.started_at, w.actual_start, v_period_start))) / 60))
          FILTER (WHERE NOT sb.is_paid AND sb.ended_at IS NOT NULL) AS period_unpaid,
        sum(greatest(0, extract(epoch FROM (least(sb.ended_at, w.actual_end, v_period_start) - greatest(sb.started_at, w.actual_start))) / 60))
          FILTER (WHERE NOT sb.is_paid AND sb.ended_at IS NOT NULL) AS prior_unpaid,
        sum(greatest(0, extract(epoch FROM (least(sb.ended_at, w.actual_end, v_period_end) - greatest(sb.started_at, w.actual_start, v_period_start))) / 60))
          FILTER (WHERE sb.is_paid AND sb.ended_at IS NOT NULL) AS paid_minutes,
        bool_or(NOT sb.is_paid AND sb.ended_at IS NULL) AS open_unpaid
      FROM public.shift_breaks sb WHERE sb.shift_id = w.id
    ) b
    WHERE w.w_end > w.w_start
  ), reviewed AS (
    SELECT b.*,
      mandatory_unpaid AND planned_minutes > 0 AND recorded_unpaid > 0
        AND NOT open_unpaid AND abs(recorded_unpaid - planned_minutes) <= 5 AS break_within,
      NOT start_within OR candidate_end <= candidate_start AS start_mismatch,
      NOT finish_within OR candidate_end <= candidate_start AS finish_mismatch,
      mandatory_unpaid AND planned_minutes > 0 AND
        (recorded_unpaid = 0 OR open_unpaid OR abs(recorded_unpaid - planned_minutes) > 5) AS break_mismatch
    FROM break_totals b
  ), shift_work AS (
    SELECT 'shift'::text AS source_type, id, 'completed'::text AS work_status,
      w_start AS started_at, w_end AS ended_at,
      CASE WHEN break_within THEN
        round(planned_minutes * (prior_unpaid + period_unpaid) / recorded_unpaid)
          - round(planned_minutes * prior_unpaid / recorded_unpaid)
        ELSE round(prior_unpaid + period_unpaid) - round(prior_unpaid) END::integer AS deduct_minutes,
      coalesce(service_type, 'shift') AS label,
      jsonb_build_object('shift_id', id, 'organization_id', organization_id, 'service_type', service_type,
        'status', status, 'ended_reason', ended_reason, 'scheduled_start', scheduled_start, 'scheduled_end', scheduled_end,
        'actual_start', actual_start, 'actual_end', actual_end, 'paid_break_minutes', paid_minutes,
        'recorded_unpaid_break_minutes', recorded_unpaid, 'planned_unpaid_break_minutes',
          CASE WHEN mandatory_unpaid THEN planned_minutes ELSE 0 END,
        'start_snapped', start_within AND candidate_end > candidate_start,
        'finish_snapped', finish_within AND candidate_end > candidate_start, 'break_snapped', break_within,
        'start_mismatch', start_mismatch, 'finish_mismatch', finish_mismatch, 'unpaid_break_mismatch', break_mismatch,
        'timesheet_mismatch', start_mismatch OR finish_mismatch OR break_mismatch,
        'roster_tolerance_version', 1) AS metadata
    FROM reviewed
  ), job_work AS (
    SELECT 'dispatch_job'::text AS source_type, d.id, 'completed'::text AS work_status,
      greatest(coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at), v_period_start) AS started_at,
      least(d.completed_at, v_period_end) AS ended_at, 0 AS deduct_minutes, coalesce(d.job_type, 'Dispatch job') AS label,
      jsonb_build_object('dispatch_job_id', d.id, 'organization_id', d.organization_id, 'job_type', d.job_type,
        'status', d.status, 'shift_id', d.shift_id, 'shift_stop_id', d.shift_stop_id,
        'dispatched_at', d.dispatched_at, 'on_scene_at', d.on_scene_at, 'completed_at', d.completed_at) AS metadata
    FROM public.dispatch_jobs d
    WHERE d.dispatch_resource_id IN (SELECT dr.id FROM public.dispatch_resources dr WHERE dr.assigned_officer_id = v_user_id)
      AND d.status = 'completed' AND d.completed_at IS NOT NULL AND d.shift_id IS NULL
      AND d.completed_at > v_period_start
      AND coalesce(d.on_scene_at, d.en_route_at, d.acknowledged_at, d.dispatched_at, d.created_at) < v_period_end
  ), bounded AS (
    SELECT *, greatest(0, floor(extract(epoch FROM (ended_at - started_at)) / 60) - deduct_minutes)::integer AS minutes
    FROM (SELECT * FROM shift_work UNION ALL SELECT * FROM job_work) sources WHERE ended_at > started_at
  )
  SELECT source_type, id, work_status, started_at, ended_at, minutes, label,
    metadata || jsonb_build_object('calculated_minutes', minutes, 'unpaid_break_minutes', deduct_minutes)
  FROM bounded ORDER BY started_at, source_type, id;
END;
$function$;
COMMENT ON FUNCTION public.get_officer_timesheet_work(date,date) IS
  'Completed work with inclusive 15-minute roster endpoint and 5-minute mandatory unpaid-break tolerances. Actual attendance/break evidence remains unchanged; mismatches and snapping are preserved in submitted metadata. Period clipping and standalone dispatch work remain supported.';

CREATE OR REPLACE FUNCTION public.get_timesheet_break_review(p_timesheet_id uuid)
RETURNS TABLE(shift_id uuid, planned_minutes integer, taken_minutes numeric, unpaid boolean, review_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_sheet public.timesheets%rowtype; v_staff public.staff_profiles%rowtype;
BEGIN
  SELECT * INTO v_sheet FROM public.timesheets WHERE id=p_timesheet_id;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_admin_for_org(v_sheet.organization_id) THEN
    RAISE EXCEPTION 'Timesheet review authority required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_staff FROM public.staff_profiles WHERE id=v_sheet.staff_id;
  RETURN QUERY SELECT s.id,coalesce(r.planned_break_minutes,0),b.minutes,coalesce(r.break_unpaid,false),
    CASE WHEN coalesce(r.planned_break_minutes,0)=0 THEN 'not_planned'
      WHEN b.minutes=0 THEN 'not_recorded'
      WHEN coalesce(r.break_unpaid,false) AND NOT b.open_break AND abs(b.minutes-r.planned_break_minutes)<=5 THEN 'matched'
      WHEN b.open_break THEN 'not_recorded'
      WHEN b.minutes<r.planned_break_minutes THEN 'short'
      WHEN b.minutes>r.planned_break_minutes THEN 'long' ELSE 'matched' END
  FROM public.shifts s LEFT JOIN public.roster_slots r ON r.linked_shift_id=s.id
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(extract(epoch FROM sb.ended_at-sb.started_at)/60)
      FILTER (WHERE sb.ended_at IS NOT NULL),0)::numeric AS minutes,
      coalesce(bool_or(sb.ended_at IS NULL),false) AS open_break
    FROM public.shift_breaks sb WHERE sb.shift_id=s.id AND sb.organization_id=v_sheet.organization_id
      AND sb.is_paid = NOT coalesce(r.break_unpaid,false)
  ) b
  WHERE s.organization_id=v_sheet.organization_id AND s.officer_user_id IN(v_staff.id,v_staff.user_id)
    AND (s.id=v_sheet.shift_id OR
      ((s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date >= v_sheet.period_start
       AND (s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date <= v_sheet.period_end))
  ORDER BY s.scheduled_start,s.id;
END;
$function$;