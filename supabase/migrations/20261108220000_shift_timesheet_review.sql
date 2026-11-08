CREATE TABLE public.shift_timesheet_hour_corrections (
  shift_id uuid PRIMARY KEY REFERENCES public.shifts(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  staff_id uuid NOT NULL REFERENCES public.staff_profiles(id),
  payable_user_id uuid NOT NULL REFERENCES public.user_profiles(id),
  payable_start timestamptz NOT NULL,
  payable_end timestamptz NOT NULL,
  unpaid_minutes integer NOT NULL CHECK (unpaid_minutes >= 0),
  source_updated_at timestamptz NOT NULL,
  corrected_by uuid NOT NULL REFERENCES public.user_profiles(id),
  reason text NOT NULL CHECK (nullif(btrim(reason),'') IS NOT NULL),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (payable_end > payable_start),
  CHECK (unpaid_minutes <= floor(extract(epoch FROM (payable_end-payable_start))/60))
);
ALTER TABLE public.shift_timesheet_hour_corrections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_timesheet_hour_corrections FROM anon, authenticated;
GRANT SELECT ON public.shift_timesheet_hour_corrections TO authenticated;
CREATE POLICY shift_timesheet_corrections_read ON public.shift_timesheet_hour_corrections
  FOR SELECT TO authenticated USING (public.is_admin_for_org(organization_id) OR payable_user_id=auth.uid());

CREATE OR REPLACE FUNCTION public.get_timesheet_shift_rows(p_organization_id uuid,p_from date,p_to date,p_staff_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.is_admin_for_org(p_organization_id)
    OR public.user_can_operate_organization(p_organization_id)) THEN
    RAISE EXCEPTION 'Timesheet review authority required' USING ERRCODE='42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to<p_from OR p_to-p_from>62 THEN
    RAISE EXCEPTION 'Choose a timesheet range of 63 days or fewer';
  END IF;
  RETURN (WITH evidence AS (
    SELECT s.*,sp.id AS staff_id,up.display_name AS staff_name,r.planned_break_minutes,r.break_unpaid,
      coalesce(b.minutes,0) AS taken_unpaid,c.payable_start,c.payable_end,c.unpaid_minutes,
      c.updated_at AS correction_updated_at,c.source_updated_at AS correction_source_version,
      c.reason AS correction_reason,c.staff_id AS correction_staff_id,c.payable_user_id AS correction_user_id,
      manual.source AS manual_source,manual.staff_id AS manual_staff_id,manual.staff_name AS manual_staff_name,
      manual.user_id AS manual_user_id,manual.reason AS manual_reason,
      abs(extract(epoch FROM(s.actual_start-s.scheduled_start)))<=900 AS start_matches,
      abs(extract(epoch FROM(s.actual_end-s.scheduled_end)))<=900 AS finish_matches,
      NOT coalesce(r.break_unpaid,false) OR coalesce(r.planned_break_minutes,0)=0
        OR (coalesce(b.minutes,0)>0 AND NOT coalesce(b.open_break,false)
          AND abs(b.minutes-r.planned_break_minutes)<=5) AS break_matches
    FROM public.shifts s
    JOIN public.user_profiles up ON up.id=s.officer_user_id
    LEFT JOIN public.staff_profiles sp ON coalesce(sp.user_id,sp.id)=up.id
    LEFT JOIN public.roster_slots r ON r.linked_shift_id=s.id
    LEFT JOIN public.shift_timesheet_hour_corrections c ON c.shift_id=s.id
    LEFT JOIN LATERAL (
      SELECT source,t.staff_id,review_user.display_name AS staff_name,coalesce(review_staff.user_id,review_staff.id) AS user_id,
        source->>'reason' AS reason
      FROM public.timesheets t JOIN public.staff_profiles review_staff ON review_staff.id=t.staff_id
      JOIN public.user_profiles review_user ON review_user.id=coalesce(review_staff.user_id,review_staff.id)
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.work_summary->'manual_sources','[]'::jsonb)) source
      WHERE (source->>'shift_id'=s.id::text
        OR (source->>'source_type'='shift' AND source->>'source_id'=s.id::text))
      ORDER BY t.submitted_at DESC LIMIT 1
    ) manual ON true
    CROSS JOIN LATERAL (SELECT sum(extract(epoch FROM(sb.ended_at-sb.started_at))/60)
      FILTER(WHERE sb.ended_at IS NOT NULL) AS minutes,bool_or(sb.ended_at IS NULL) AS open_break
      FROM public.shift_breaks sb WHERE sb.shift_id=s.id AND NOT sb.is_paid) b
    WHERE s.organization_id=p_organization_id AND s.status NOT IN('cancelled','declined')
      AND (s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date BETWEEN p_from AND p_to
      AND (p_staff_id IS NULL OR coalesce(manual.staff_id,c.staff_id,sp.id)=p_staff_id)
      AND (public.is_admin_for_org(p_organization_id) OR public.user_can_exercise_branch_authority(
        p_organization_id,coalesce(manual.user_id,c.payable_user_id,sp.user_id,sp.id),'timesheet_local_review'))
  ) SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'organization_id',organization_id,'staff_id',coalesce(manual_staff_id,correction_staff_id,staff_id),
    'staff_name',coalesce(manual_staff_name,staff_name),
    'officer_user_id',officer_user_id,'service_type',service_type,'status',status,'updated_at',updated_at,
    'scheduled_start',scheduled_start,'scheduled_end',scheduled_end,'actual_start',actual_start,'actual_end',actual_end,
    'payable_start',CASE WHEN correction_source_version=updated_at THEN payable_start
      WHEN manual_source IS NOT NULL THEN (manual_source->>'reviewed_start')::timestamptz
      WHEN start_matches THEN scheduled_start ELSE actual_start END,
    'payable_end',CASE WHEN correction_source_version=updated_at THEN payable_end
      WHEN manual_source IS NOT NULL THEN (manual_source->>'reviewed_end')::timestamptz
      WHEN finish_matches THEN scheduled_end ELSE actual_end END,
    'unpaid_minutes',CASE WHEN correction_source_version=updated_at THEN unpaid_minutes
      WHEN manual_source IS NOT NULL THEN (manual_source->>'unpaid_break_minutes')::integer
      WHEN coalesce(break_unpaid,false) AND planned_break_minutes>0 AND break_matches THEN planned_break_minutes
      ELSE round(taken_unpaid)::integer END,
    'planned_unpaid_minutes',CASE WHEN break_unpaid THEN coalesce(planned_break_minutes,0) ELSE 0 END,
    'recorded_unpaid_minutes',taken_unpaid,'correction_updated_at',correction_updated_at,
    'correction_reason',coalesce(correction_reason,manual_reason),
    'manual_update',manual_source IS NOT NULL OR correction_updated_at IS NOT NULL,
    'hours_status',CASE WHEN correction_updated_at IS NOT NULL OR manual_source IS NOT NULL THEN 'review'
      WHEN status='missed' OR (actual_start IS NULL AND scheduled_end<now() AND status IN('scheduled','published','accepted')) THEN 'missed'
      WHEN status='completed' AND actual_end>actual_start AND start_matches AND finish_matches AND break_matches THEN 'confirmed'
      WHEN status='completed' THEN 'review' ELSE 'pending' END,
    'start_mismatch',NOT coalesce(start_matches,false),'finish_mismatch',NOT coalesce(finish_matches,false),
    'unpaid_break_mismatch',NOT break_matches
  ) ORDER BY scheduled_start,staff_name),'[]'::jsonb) FROM evidence);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_timesheet_shift_rows(uuid,date,date,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_timesheet_shift_rows(uuid,date,date,uuid) TO authenticated,service_role;

CREATE FUNCTION public.get_branch_timesheet_queue(
  p_operating_organization_id uuid,p_from timestamptz,p_to timestamptz,p_staff_id uuid
)
RETURNS TABLE(id uuid,staff_id uuid,period_start date,period_end date,scheduled_hours numeric,actual_hours numeric,
  work_derived_hours numeric,adjustment_hours numeric,work_summary jsonb,status text,branch_review_notes text,
  branch_reviewed_by uuid,submitted_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.user_can_operate_organization(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch required';
  END IF;
  RETURN QUERY
    SELECT t.id,t.staff_id,t.period_start,t.period_end,t.scheduled_hours,t.actual_hours,
      t.work_derived_hours,t.adjustment_hours,t.work_summary,t.status,t.branch_review_notes,
      t.branch_reviewed_by,t.submitted_at
    FROM public.timesheets t
    JOIN public.staff_profiles staff ON staff.id=t.staff_id
    JOIN public.staff_branch_authorisations assignment
      ON assignment.user_id=coalesce(staff.user_id,staff.id)
     AND assignment.branch_org_id=p_operating_organization_id AND assignment.status='active'
    WHERE (p_staff_id IS NULL OR t.staff_id=p_staff_id)
      AND public.user_can_exercise_branch_authority(p_operating_organization_id,
        coalesce(staff.user_id,staff.id),'timesheet_local_review')
      AND (p_from IS NULL OR t.period_end>=p_from::date)
      AND (p_to IS NULL OR t.period_start<=p_to::date)
    ORDER BY t.period_start DESC;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_branch_timesheet_queue(uuid,timestamptz,timestamptz,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_branch_timesheet_queue(uuid,timestamptz,timestamptz,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.correct_timesheet_shift_hours(p_client_request_id uuid,p_shift_id uuid,
  p_expected_updated_at timestamptz,p_expected_correction_updated_at timestamptz,p_staff_id uuid,
  p_payable_start timestamptz,p_payable_end timestamptz,p_unpaid_minutes integer,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_shift public.shifts%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_correction public.shift_timesheet_hour_corrections%rowtype;
  v_user uuid;
  v_request jsonb;
  v_existing public.audit_log%rowtype;
  v_receipt jsonb;
  v_sheet public.timesheets%rowtype;
  v_original_user uuid;
  v_previous_summaries jsonb := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_client_request_id IS NULL THEN RAISE EXCEPTION 'Authenticated correction request required'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Timesheet correction authority required' USING ERRCODE='42501';
  END IF;
  v_original_user:=v_shift.officer_user_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('shift-timesheet-correction:'||v_shift.organization_id::text||':'||p_client_request_id::text,0));
  v_request:=jsonb_build_object('shift_id',p_shift_id,'source_version',p_expected_updated_at,
    'correction_version',p_expected_correction_updated_at,'staff_id',p_staff_id,'start',p_payable_start,
    'end',p_payable_end,'unpaid',p_unpaid_minutes,'reason',nullif(btrim(p_reason),''));
  SELECT * INTO v_existing FROM public.audit_log WHERE organization_id=v_shift.organization_id
    AND action='timesheet_shift_hours_corrected' AND metadata->>'client_request_id'=p_client_request_id::text LIMIT 1;
  IF FOUND THEN
    IF v_existing.actor_user_id IS DISTINCT FROM auth.uid() OR v_existing.metadata->'request' IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Correction request already used for different inputs';
    END IF;
    RETURN v_existing.metadata->'receipt';
  END IF;
  IF v_shift.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'Shift changed; reload before correcting'; END IF;
  SELECT * INTO v_correction FROM public.shift_timesheet_hour_corrections WHERE shift_id=p_shift_id FOR UPDATE;
  IF v_correction.updated_at IS DISTINCT FROM p_expected_correction_updated_at THEN RAISE EXCEPTION 'Hours correction changed; reload'; END IF;
  IF v_shift.status='in_progress' OR v_shift.scheduled_end>now() THEN RAISE EXCEPTION 'Finish the shift before correcting payable hours'; END IF;
  IF nullif(btrim(p_reason),'') IS NULL OR p_payable_start IS NULL OR p_payable_end IS NULL
    OR p_payable_end<=p_payable_start OR p_payable_end>now() OR p_payable_end-p_payable_start>interval '24 hours'
    OR p_unpaid_minutes IS NULL OR p_unpaid_minutes<0
    OR p_unpaid_minutes>floor(extract(epoch FROM(p_payable_end-p_payable_start))/60) THEN
    RAISE EXCEPTION 'Valid payable dates, break minutes and correction reason required';
  END IF;
  SELECT * INTO v_staff FROM public.staff_profiles WHERE id=p_staff_id;
  v_user:=coalesce(v_staff.user_id,v_staff.id);
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id=v_user AND up.deactivated_at IS NULL
    AND (up.organization_id=v_shift.organization_id OR EXISTS(SELECT 1 FROM public.staff_branch_authorisations ba
      WHERE ba.user_id=v_user AND ba.branch_org_id=v_shift.organization_id AND ba.status='active'))) THEN
    RAISE EXCEPTION 'Select an active staff member authorised for this branch';
  END IF;
  IF NOT public.is_timesheet_payroll_admin(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Employer payroll correction authority required' USING ERRCODE='42501';
  END IF;
  IF EXISTS(SELECT 1 FROM public.timesheet_work_entries e JOIN public.timesheets t ON t.id=e.timesheet_id
    WHERE e.source_type='shift' AND e.source_id=p_shift_id
      AND (t.status IN('approved','paid') OR t.payroll_export_batch_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'Finalised payroll evidence cannot be changed here';
  END IF;
  IF v_user IS DISTINCT FROM v_shift.officer_user_id THEN
    IF EXISTS(SELECT 1 FROM public.timesheets t WHERE t.shift_id=p_shift_id OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(coalesce(t.work_summary->'manual_sources','[]'::jsonb)) source
      WHERE source->>'shift_id'=p_shift_id::text OR (source->>'source_type'='shift' AND source->>'source_id'=p_shift_id::text))) THEN
      RAISE EXCEPTION 'Existing manual recovery must be reconciled before changing staff';
    END IF;
    IF v_shift.actual_start IS NOT NULL OR v_shift.actual_end IS NOT NULL
      OR v_shift.status NOT IN('missed','scheduled','published','accepted')
      OR EXISTS(SELECT 1 FROM public.shift_stop_actions WHERE shift_id=p_shift_id)
      OR EXISTS(SELECT 1 FROM public.officer_gps_log WHERE shift_id=p_shift_id)
      OR EXISTS(SELECT 1 FROM public.shift_debriefs WHERE shift_id=p_shift_id)
      OR EXISTS(SELECT 1 FROM public.shift_breaks WHERE shift_id=p_shift_id)
      OR EXISTS(SELECT 1 FROM public.timesheet_work_entries WHERE source_type='shift' AND source_id=p_shift_id) THEN
      RAISE EXCEPTION 'Recorded attendance or payroll cannot be transferred to another staff member';
    END IF;
    UPDATE public.roster_slots SET staff_id=p_staff_id,updated_at=clock_timestamp() WHERE linked_shift_id=p_shift_id;
    UPDATE public.shifts SET officer_user_id=v_user,updated_at=clock_timestamp() WHERE id=p_shift_id RETURNING * INTO v_shift;
  END IF;
  INSERT INTO public.shift_timesheet_hour_corrections(shift_id,organization_id,staff_id,payable_user_id,
    payable_start,payable_end,unpaid_minutes,source_updated_at,corrected_by,reason)
  VALUES(p_shift_id,v_shift.organization_id,p_staff_id,v_user,p_payable_start,p_payable_end,
    p_unpaid_minutes,v_shift.updated_at,auth.uid(),btrim(p_reason))
  ON CONFLICT(shift_id) DO UPDATE SET staff_id=excluded.staff_id,payable_user_id=excluded.payable_user_id,
    payable_start=excluded.payable_start,payable_end=excluded.payable_end,unpaid_minutes=excluded.unpaid_minutes,
    source_updated_at=excluded.source_updated_at,corrected_by=excluded.corrected_by,reason=excluded.reason,updated_at=clock_timestamp();
  FOR v_sheet IN SELECT t.* FROM public.timesheets t WHERE t.id IN
    (SELECT timesheet_id FROM public.timesheet_work_entries WHERE source_type='shift' AND source_id=p_shift_id)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(t.work_summary->'manual_sources','[]'::jsonb)) source
      WHERE source->>'shift_id'=p_shift_id::text OR (source->>'source_type'='shift' AND source->>'source_id'=p_shift_id::text)) FOR UPDATE LOOP
    IF NOT public.is_admin_for_org(v_sheet.organization_id) THEN RAISE EXCEPTION 'Employer timesheet correction authority required'; END IF;
    IF p_payable_start<(v_sheet.period_start::timestamp AT TIME ZONE 'Pacific/Auckland')
      OR p_payable_end>((v_sheet.period_end+1)::timestamp AT TIME ZONE 'Pacific/Auckland') THEN
      RAISE EXCEPTION 'Payable dates must remain inside the submitted timesheet period';
    END IF;
    v_previous_summaries:=v_previous_summaries||jsonb_build_array(jsonb_build_object('timesheet_id',v_sheet.id,
      'revision',v_sheet.revision,'work_summary',v_sheet.work_summary,'actual_hours',v_sheet.actual_hours));
    IF v_sheet.status IN('approved','paid') OR v_sheet.payroll_export_batch_id IS NOT NULL THEN
      RAISE EXCEPTION 'Finalised payroll evidence cannot be changed here';
    END IF;
    IF v_sheet.work_summary->>'evidence_kind'='manual_admin' THEN
      WITH updated_sources AS (
        SELECT jsonb_agg(CASE WHEN source->>'shift_id'=p_shift_id::text
          OR (source->>'source_type'='shift' AND source->>'source_id'=p_shift_id::text)
          THEN source||jsonb_build_object('reviewed_start',p_payable_start,'reviewed_end',p_payable_end,
            'unpaid_break_minutes',p_unpaid_minutes,'reason',btrim(p_reason),'reviewed_by',auth.uid()) ELSE source END) AS sources,
          sum(CASE WHEN source->>'shift_id'=p_shift_id::text
            OR (source->>'source_type'='shift' AND source->>'source_id'=p_shift_id::text)
            THEN extract(epoch FROM(p_payable_end-p_payable_start))/3600-p_unpaid_minutes::numeric/60
            ELSE extract(epoch FROM((source->>'reviewed_end')::timestamptz-(source->>'reviewed_start')::timestamptz))/3600
              -(source->>'unpaid_break_minutes')::numeric/60 END) AS hours
        FROM jsonb_array_elements(v_sheet.work_summary->'manual_sources') source
      ) UPDATE public.timesheets SET work_summary=jsonb_set(v_sheet.work_summary,'{manual_sources}',updated_sources.sources),
        actual_hours=round(updated_sources.hours,2),adjustment_hours=round(updated_sources.hours,2),
        overtime_hours=least(coalesce(v_sheet.overtime_hours,0),round(updated_sources.hours,2)),
        status='submitted',revision=revision+1,branch_reviewed_by=NULL,branch_reviewed_at=NULL,
        approved_by=NULL,approved_at=NULL FROM updated_sources WHERE id=v_sheet.id;
      CONTINUE;
    END IF;
    UPDATE public.timesheet_work_entries SET started_at=p_payable_start,ended_at=p_payable_end,
      calculated_minutes=floor(extract(epoch FROM(p_payable_end-p_payable_start))/60)::integer-p_unpaid_minutes,
      metadata=metadata||jsonb_build_object('manual_correction',true,'correction_reason',btrim(p_reason),
        'unpaid_break_minutes',p_unpaid_minutes,'hours_review_status','review')
      WHERE timesheet_id=v_sheet.id AND source_type='shift' AND source_id=p_shift_id;
    UPDATE public.timesheets SET work_derived_hours=(SELECT round(sum(calculated_minutes)::numeric/60,2)
        FROM public.timesheet_work_entries WHERE timesheet_id=v_sheet.id),
      actual_hours=(SELECT round(sum(calculated_minutes)::numeric/60+coalesce(v_sheet.adjustment_hours,0),2)
        FROM public.timesheet_work_entries WHERE timesheet_id=v_sheet.id),
      work_summary=jsonb_build_object('source_count',(SELECT count(*) FROM public.timesheet_work_entries WHERE timesheet_id=v_sheet.id),
        'entries',(SELECT jsonb_agg(jsonb_build_object('source_type',source_type,'source_id',source_id,
          'started_at',started_at,'ended_at',ended_at,'calculated_minutes',calculated_minutes,'metadata',metadata))
          FROM public.timesheet_work_entries WHERE timesheet_id=v_sheet.id)),
      status='submitted',revision=revision+1,branch_reviewed_by=NULL,branch_reviewed_at=NULL,
      approved_by=NULL,approved_at=NULL WHERE id=v_sheet.id;
  END LOOP;
  v_receipt:=jsonb_build_object('shift_id',p_shift_id,'staff_id',p_staff_id,'hours_status','review');
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_shift.organization_id,auth.uid(),'timesheet_shift_hours_corrected','shifts',p_shift_id,
      jsonb_build_object('client_request_id',p_client_request_id,'request',v_request,'receipt',v_receipt,
        'previous_correction',to_jsonb(v_correction),'original_assignment_user_id',v_original_user,
        'previous_timesheets',v_previous_summaries));
  RETURN v_receipt;
END;
$function$;
REVOKE ALL ON FUNCTION public.correct_timesheet_shift_hours(uuid,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.correct_timesheet_shift_hours(uuid,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz,integer,text) TO authenticated,service_role;

ALTER FUNCTION public.get_officer_timesheet_work(date,date) RENAME TO get_recorded_officer_timesheet_work;
REVOKE ALL ON FUNCTION public.get_recorded_officer_timesheet_work(date,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_officer_timesheet_work(p_period_start date,p_period_end date)
RETURNS TABLE(source_type text,source_id uuid,work_status text,started_at timestamptz,ended_at timestamptz,
  calculated_minutes integer,label text,metadata jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' SET timezone TO 'Pacific/Auckland'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.user_profiles WHERE id=auth.uid() AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'Active staff profile required';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_start>p_period_end THEN RAISE EXCEPTION 'Invalid timesheet period'; END IF;
  RETURN QUERY
    SELECT recorded.source_type,recorded.source_id,recorded.work_status,recorded.started_at,recorded.ended_at,
      recorded.calculated_minutes,recorded.label,recorded.metadata||jsonb_build_object('hours_review_status',
        CASE WHEN recorded.source_type='shift' AND recorded.metadata->>'timesheet_mismatch'='false'
          THEN 'confirmed' ELSE 'review' END)
    FROM public.get_recorded_officer_timesheet_work(p_period_start,p_period_end) recorded
    WHERE recorded.source_type<>'shift' OR NOT EXISTS(SELECT 1 FROM public.shift_timesheet_hour_corrections c
      JOIN public.shifts s ON s.id=c.shift_id WHERE c.shift_id=recorded.source_id AND c.source_updated_at=s.updated_at)
    UNION ALL
    SELECT 'shift'::text,s.id,'completed'::text,window_start,window_end,
      greatest(0,floor(extract(epoch FROM(window_end-window_start)))::integer/60-deduction),
      coalesce(s.service_type,'shift'),jsonb_build_object('shift_id',s.id,'organization_id',s.organization_id,
        'actual_start',s.actual_start,'actual_end',s.actual_end,'scheduled_start',s.scheduled_start,'scheduled_end',s.scheduled_end,
        'manual_correction',true,'correction_reason',c.reason,'unpaid_break_minutes',deduction,'hours_review_status','review',
        'recorded_status',s.status,'payable_staff_id',c.staff_id)
    FROM public.shift_timesheet_hour_corrections c JOIN public.shifts s ON s.id=c.shift_id
    CROSS JOIN LATERAL (SELECT greatest(c.payable_start,p_period_start::timestamptz) AS window_start,
      least(c.payable_end,(p_period_end+1)::timestamptz) AS window_end) bounds
    CROSS JOIN LATERAL (SELECT (round(c.unpaid_minutes*greatest(0,extract(epoch FROM(window_end-c.payable_start)))
      /extract(epoch FROM(c.payable_end-c.payable_start)))-round(c.unpaid_minutes*greatest(0,
        extract(epoch FROM(window_start-c.payable_start)))/extract(epoch FROM(c.payable_end-c.payable_start))))::integer AS deduction) breaks
    WHERE c.payable_user_id=auth.uid() AND c.source_updated_at=s.updated_at AND s.status<>'in_progress'
      AND window_end>window_start
    ORDER BY 4,1,2;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_officer_timesheet_work(date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_officer_timesheet_work(date,date) TO authenticated,service_role;

DO $refresh$
DECLARE v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.submit_officer_timesheet_from_work(uuid,date,date,numeric,text)'::regprocedure,
    'public.resubmit_rejected_timesheet_from_work(uuid,numeric,text)'::regprocedure
  ] LOOP
    EXECUTE pg_get_functiondef(v_function);
  END LOOP;
END;
$refresh$;