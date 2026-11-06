-- Scheduled time is manual payroll evidence, never actual attendance or GPS.
ALTER TABLE public.timesheets
  ADD COLUMN recovery_request jsonb,
  ADD COLUMN pay_code_override text,
  ADD COLUMN hourly_rate_override numeric(12,4),
  ADD COLUMN pay_override_reason text,
  ADD COLUMN payroll_snapshot jsonb,
  ADD COLUMN revision integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT timesheet_hourly_override_check CHECK (
    hourly_rate_override IS NULL OR
    (hourly_rate_override >= 0 AND hourly_rate_override <= 100000 AND hourly_rate_override <> 'NaN'::numeric)
  ),
  ADD CONSTRAINT timesheet_pay_code_override_check CHECK (
    pay_code_override IS NULL OR pay_code_override ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'
  );

CREATE FUNCTION public.is_timesheet_payroll_admin(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND public.is_admin_for_org(p_org)
    AND EXISTS (
      SELECT 1 FROM public.user_profiles u
      WHERE u.id = auth.uid() AND u.deactivated_at IS NULL
        AND u.organization_id = p_org AND u.employer_organization_id = p_org
    )
$$;
REVOKE ALL ON FUNCTION public.is_timesheet_payroll_admin(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_timesheet_payroll_admin(uuid) TO authenticated;

CREATE FUNCTION public.preview_scheduled_timesheet(
  p_staff_id uuid, p_period_start date, p_period_end date
)
RETURNS TABLE(source_type text, source_id uuid, shift_id uuid, scheduled_start timestamptz,
  scheduled_end timestamptz, source_version text, planned_break_minutes integer, break_unpaid boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_staff public.staff_profiles%rowtype;
BEGIN
  SELECT * INTO v_staff FROM public.staff_profiles WHERE id = p_staff_id;
  IF NOT FOUND OR NOT public.is_timesheet_payroll_admin(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start
     OR p_period_end - p_period_start > 31 THEN
    RAISE EXCEPTION 'Choose a period between 1 and 32 days';
  END IF;
  RETURN QUERY
  SELECT 'roster_slot'::text, r.id, r.linked_shift_id, r.scheduled_start, r.scheduled_end,
    md5(jsonb_build_array(r.staff_id, r.scheduled_start, r.scheduled_end, r.status, r.linked_shift_id, r.updated_at,
      r.planned_break_minutes,r.break_unpaid)::text),r.planned_break_minutes,r.break_unpaid
  FROM public.roster_slots r
  WHERE r.organization_id = v_staff.organization_id AND r.staff_id = v_staff.id
    AND r.status IN ('published', 'accepted', 'completed')
    AND (r.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date >= p_period_start
    AND (r.scheduled_end AT TIME ZONE 'Pacific/Auckland')::date <= p_period_end
    AND r.scheduled_end <= clock_timestamp()
  UNION ALL
  SELECT 'shift'::text, s.id, s.id, s.scheduled_start, s.scheduled_end,
    md5(jsonb_build_array(s.officer_user_id, s.scheduled_start, s.scheduled_end, s.status, s.updated_at)::text),0,false
  FROM public.shifts s
  WHERE s.organization_id = v_staff.organization_id
    AND s.officer_user_id IN (v_staff.id, v_staff.user_id)
    AND s.status IN ('scheduled', 'published', 'accepted', 'missed', 'completed')
    AND NOT EXISTS (SELECT 1 FROM public.roster_slots r WHERE r.linked_shift_id = s.id OR r.id=s.roster_slot_id)
    AND (s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date >= p_period_start
    AND (s.scheduled_end AT TIME ZONE 'Pacific/Auckland')::date <= p_period_end
    AND s.scheduled_end <= clock_timestamp()
  ORDER BY 4, 2;
END $$;
REVOKE ALL ON FUNCTION public.preview_scheduled_timesheet(uuid,date,date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_scheduled_timesheet(uuid,date,date) TO authenticated;

CREATE FUNCTION public.get_timesheet_break_review(p_timesheet_id uuid)
RETURNS TABLE(shift_id uuid,planned_minutes integer,taken_minutes numeric,unpaid boolean,review_status text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_sheet public.timesheets%rowtype; v_staff public.staff_profiles%rowtype;
BEGIN
  SELECT * INTO v_sheet FROM public.timesheets WHERE id=p_timesheet_id;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_admin_for_org(v_sheet.organization_id) THEN
    RAISE EXCEPTION 'Timesheet review authority required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_staff FROM public.staff_profiles WHERE id=v_sheet.staff_id;
  RETURN QUERY SELECT s.id,coalesce(r.planned_break_minutes,0),b.minutes,coalesce(r.break_unpaid,false),
    CASE WHEN coalesce(r.planned_break_minutes,0)=0 THEN 'not_planned'
      WHEN b.minutes=0 THEN 'not_recorded' WHEN b.minutes<r.planned_break_minutes THEN 'short'
      WHEN b.minutes>r.planned_break_minutes THEN 'long' ELSE 'matched' END
  FROM public.shifts s LEFT JOIN public.roster_slots r ON r.linked_shift_id=s.id
  CROSS JOIN LATERAL (
    SELECT coalesce(sum(extract(epoch FROM sb.ended_at-sb.started_at)/60)
      FILTER (WHERE sb.ended_at IS NOT NULL),0)::numeric AS minutes
    FROM public.shift_breaks sb WHERE sb.shift_id=s.id AND sb.organization_id=v_sheet.organization_id
      AND sb.is_paid = NOT coalesce(r.break_unpaid,false)
  ) b
  WHERE s.organization_id=v_sheet.organization_id AND s.officer_user_id IN(v_staff.id,v_staff.user_id)
    AND (s.id=v_sheet.shift_id OR
      ((s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date >= v_sheet.period_start
       AND (s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date <= v_sheet.period_end))
  ORDER BY s.scheduled_start,s.id;
END $$;
REVOKE ALL ON FUNCTION public.get_timesheet_break_review(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_timesheet_break_review(uuid) TO authenticated;

CREATE FUNCTION public.recover_scheduled_timesheet(
  p_client_request_id uuid, p_staff_id uuid, p_period_start date, p_period_end date,
  p_rows jsonb, p_overtime_hours numeric, p_reason text
)
RETURNS public.timesheets LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_staff public.staff_profiles%rowtype;
  v_sheet public.timesheets%rowtype;
  v_row jsonb; v_source record; v_sources jsonb := '[]'::jsonb; v_request jsonb;
  v_start timestamptz; v_end timestamptz; v_break numeric;
  v_hours numeric := 0; v_scheduled numeric := 0; v_shift uuid; v_count integer := 0;
BEGIN
  SELECT * INTO v_staff FROM public.staff_profiles WHERE id = p_staff_id;
  IF NOT FOUND OR NOT public.is_timesheet_payroll_admin(v_staff.organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_client_request_id IS NULL OR nullif(btrim(p_reason), '') IS NULL OR length(p_reason) > 2000 THEN
    RAISE EXCEPTION 'A request ID and audited recovery reason (up to 2000 characters) are required';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start
    OR p_period_end - p_period_start > 31 OR p_period_end > (now() AT TIME ZONE 'Pacific/Auckland')::date THEN
    RAISE EXCEPTION 'Choose a past or current period between 1 and 32 days';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Select between 1 and 100 scheduled rows';
  END IF;
  v_request := jsonb_build_object('staff_id',p_staff_id,'period_start',p_period_start,
    'period_end',p_period_end,'rows',p_rows,'overtime_hours',p_overtime_hours,'reason',btrim(p_reason));
  -- The officer submission path takes this same lock before its overlap check.
  PERFORM pg_advisory_xact_lock(hashtextextended('timesheet_submission:' || v_staff.id::text, 0));
  SELECT * INTO v_sheet FROM public.timesheets
    WHERE staff_id = v_staff.id AND client_event_id = p_client_request_id;
  IF FOUND THEN
    IF v_sheet.recovery_request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Request ID already used with different recovery details';
    END IF;
    RETURN v_sheet;
  END IF;
  IF EXISTS (SELECT 1 FROM public.timesheets t WHERE t.staff_id = v_staff.id
    AND daterange(t.period_start,t.period_end,'[]') && daterange(p_period_start,p_period_end,'[]')) THEN
    RAISE EXCEPTION 'A timesheet already overlaps this period; correct the existing sheet instead';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_rows)) <>
     (SELECT count(DISTINCT (x->>'source_type',x->>'source_id')) FROM jsonb_array_elements(p_rows) x) THEN
    RAISE EXCEPTION 'Duplicate scheduled rows are not allowed';
  END IF;
  -- Lock source rows in a deterministic order, including their linked attendance rows.
  PERFORM 1 FROM public.roster_slots r JOIN jsonb_array_elements(p_rows) x
    ON x->>'source_type' = 'roster_slot' AND r.id = (x->>'source_id')::uuid ORDER BY r.id FOR UPDATE OF r;
  PERFORM 1 FROM public.shifts s WHERE s.id IN (
    SELECT (x->>'source_id')::uuid FROM jsonb_array_elements(p_rows) x WHERE x->>'source_type' = 'shift'
    UNION SELECT r.linked_shift_id FROM public.roster_slots r JOIN jsonb_array_elements(p_rows) x
      ON x->>'source_type' = 'roster_slot' AND r.id = (x->>'source_id')::uuid
  ) ORDER BY s.id FOR UPDATE;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    SELECT * INTO v_source FROM public.preview_scheduled_timesheet(p_staff_id,p_period_start,p_period_end) s
      WHERE s.source_type = v_row->>'source_type' AND s.source_id = (v_row->>'source_id')::uuid;
    IF NOT FOUND OR v_source.source_version IS DISTINCT FROM v_row->>'source_version' THEN
      RAISE EXCEPTION 'Scheduled source changed or is no longer eligible; reload the preview';
    END IF;
    IF v_source.shift_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.shifts s WHERE s.id = v_source.shift_id
        AND (s.organization_id <> v_staff.organization_id OR s.officer_user_id NOT IN (v_staff.id,coalesce(v_staff.user_id,v_staff.id))
          OR s.status IN ('cancelled','declined','in_progress'))
    ) THEN RAISE EXCEPTION 'Linked shift changed or is still in progress'; END IF;
    IF v_source.shift_id IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(v_sources) x
      WHERE x->>'shift_id'=v_source.shift_id::text) THEN RAISE EXCEPTION 'Duplicate linked shift sources are not allowed'; END IF;
    v_start := (v_row->>'reviewed_start')::timestamptz;
    v_end := (v_row->>'reviewed_end')::timestamptz;
    v_break := (v_row->>'unpaid_break_minutes')::numeric;
    IF v_start IS NULL OR v_end IS NULL OR v_break IS NULL OR v_break = 'NaN'::numeric
      OR v_break < 0 OR v_end <= v_start OR v_end > now() OR v_end - v_start > interval '24 hours'
      OR v_break >= extract(epoch FROM v_end-v_start)/60
      OR (v_start AT TIME ZONE 'Pacific/Auckland')::date < p_period_start
      OR (v_end AT TIME ZONE 'Pacific/Auckland')::date > p_period_end THEN
      RAISE EXCEPTION 'Review valid start, end and unpaid break inside the selected period';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_sources) x
      WHERE tstzrange((x->>'reviewed_start')::timestamptz,(x->>'reviewed_end')::timestamptz,'[)')
        && tstzrange(v_start,v_end,'[)')) THEN RAISE EXCEPTION 'Reviewed scheduled rows overlap'; END IF;
    v_hours := v_hours + (extract(epoch FROM v_end-v_start)/3600 - v_break/60);
    v_scheduled := v_scheduled + extract(epoch FROM v_source.scheduled_end-v_source.scheduled_start)/3600;
    v_sources := v_sources || jsonb_build_array(to_jsonb(v_source) || jsonb_build_object(
      'evidence_kind','manual_admin','reviewed_start',v_start,'reviewed_end',v_end,
      'unpaid_break_minutes',v_break,'reviewed_by',auth.uid(),'reason',btrim(p_reason)));
    v_shift := v_source.shift_id; v_count := v_count + 1;
  END LOOP;
  v_hours := round(v_hours,2);
  IF v_hours <= 0 OR v_hours > 744 OR p_overtime_hours IS NULL OR p_overtime_hours = 'NaN'::numeric
    OR p_overtime_hours < 0 OR p_overtime_hours > v_hours THEN RAISE EXCEPTION 'Invalid hours or overtime'; END IF;
  INSERT INTO public.timesheets(organization_id,staff_id,shift_id,period_start,period_end,
    scheduled_hours,actual_hours,overtime_hours,status,notes,submitted_at,client_event_id,
    work_derived_hours,adjustment_hours,work_summary,recovery_request)
  VALUES(v_staff.organization_id,v_staff.id,CASE WHEN v_count=1 THEN v_shift END,p_period_start,p_period_end,
    round(v_scheduled,2),v_hours,p_overtime_hours,'submitted',btrim(p_reason),clock_timestamp(),p_client_request_id,
    0,v_hours,jsonb_build_object('evidence_kind','manual_admin','source_count',0,'manual_sources',v_sources),v_request)
  RETURNING * INTO v_sheet;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_staff.organization_id,auth.uid(),'timesheet_schedule_recovered','timesheets',v_sheet.id,
      jsonb_build_object('client_request_id',p_client_request_id,'reason',btrim(p_reason),
        'sources',v_sources,'actual_hours',v_hours,'evidence_kind','manual_admin'));
  RETURN v_sheet;
END $$;
REVOKE ALL ON FUNCTION public.recover_scheduled_timesheet(uuid,uuid,date,date,jsonb,numeric,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_scheduled_timesheet(uuid,uuid,date,date,jsonb,numeric,text) TO authenticated;

CREATE FUNCTION public.correct_timesheet_pay(
  p_client_request_id uuid, p_timesheet_id uuid, p_expected_revision integer,
  p_pay_code text, p_hourly_rate numeric, p_reason text
)
RETURNS public.timesheets LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_sheet public.timesheets%rowtype; v_request jsonb; v_old jsonb; v_receipt jsonb;
BEGIN
  SELECT * INTO v_sheet FROM public.timesheets WHERE id = p_timesheet_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_timesheet_payroll_admin(v_sheet.organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_client_request_id IS NULL OR nullif(btrim(p_reason),'') IS NULL OR length(p_reason)>2000 THEN
    RAISE EXCEPTION 'A request ID and audited pay override reason are required';
  END IF;
  v_request := jsonb_build_object('expected_revision',p_expected_revision,'pay_code',nullif(btrim(p_pay_code),''),
    'hourly_rate',p_hourly_rate,'reason',btrim(p_reason));
  SELECT metadata INTO v_receipt FROM public.audit_log WHERE target_id=v_sheet.id
    AND action='timesheet_pay_corrected' AND metadata->>'client_request_id'=p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt->'request' IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'Request ID already used with different pay details'; END IF;
    RETURN v_sheet;
  END IF;
  IF v_sheet.revision IS DISTINCT FROM p_expected_revision OR v_sheet.status NOT IN ('submitted','branch_checked')
    OR v_sheet.payroll_export_batch_id IS NOT NULL THEN RAISE EXCEPTION 'Timesheet changed or is no longer editable; reload'; END IF;
  v_old := jsonb_build_object('pay_code',v_sheet.pay_code_override,'hourly_rate',v_sheet.hourly_rate_override);
  UPDATE public.timesheets SET pay_code_override=nullif(btrim(p_pay_code),''),
    hourly_rate_override=p_hourly_rate,pay_override_reason=btrim(p_reason),
    status='submitted',branch_reviewed_by=NULL,branch_reviewed_at=NULL,branch_review_notes=NULL,
    branch_reviewed_organization_id=NULL,approved_by=NULL,approved_at=NULL
    WHERE id=v_sheet.id RETURNING * INTO v_sheet;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_sheet.organization_id,auth.uid(),'timesheet_pay_corrected','timesheets',v_sheet.id,
      jsonb_build_object('client_request_id',p_client_request_id,'request',v_request,'previous',v_old,
        'scope','this_timesheet_only','revision',v_sheet.revision));
  RETURN v_sheet;
END $$;
REVOKE ALL ON FUNCTION public.correct_timesheet_pay(uuid,uuid,integer,text,numeric,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.correct_timesheet_pay(uuid,uuid,integer,text,numeric,text) TO authenticated;

CREATE FUNCTION public.timesheet_effective_pay(p_timesheet_id uuid)
RETURNS TABLE(rate_rule_id uuid,pay_code text,hourly_rate numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN t.payroll_snapshot IS NOT NULL THEN (t.payroll_snapshot->>'rate_rule_id')::uuid ELSE r.id END,
    coalesce(t.payroll_snapshot->>'pay_code',t.pay_code_override,r.pay_code),
    coalesce((t.payroll_snapshot->>'hourly_rate')::numeric,t.hourly_rate_override,r.amount)
  FROM public.timesheets t
  JOIN public.staff_profiles sp ON sp.id=t.staff_id AND sp.organization_id=t.organization_id
  LEFT JOIN public.shifts s ON s.id=t.shift_id
  LEFT JOIN LATERAL (
    SELECT rr.id,rr.pay_code,rr.amount FROM public.rate_rules rr
    WHERE rr.organization_id=t.organization_id AND rr.rule_kind='pay' AND rr.rate_type='hourly' AND rr.active
      AND (rr.role_code IS NULL OR rr.role_code=sp.role_code)
      AND (rr.service_type IS NULL OR rr.service_type=s.service_type)
      AND (rr.effective_from IS NULL OR rr.effective_from<=t.period_start)
      AND (rr.effective_to IS NULL OR rr.effective_to>=t.period_start)
    ORDER BY (rr.role_code IS NOT NULL)::integer DESC,(rr.service_type IS NOT NULL)::integer DESC,
      rr.priority DESC,rr.effective_from DESC NULLS LAST,rr.id LIMIT 1
  ) r ON true
  WHERE t.id=p_timesheet_id AND public.is_admin_for_org(t.organization_id)
    AND EXISTS (SELECT 1 FROM public.user_profiles u WHERE u.id=auth.uid()
      AND u.organization_id=t.organization_id AND u.deactivated_at IS NULL)
$$;
REVOKE ALL ON FUNCTION public.timesheet_effective_pay(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.timesheet_effective_pay(uuid) TO authenticated;

CREATE FUNCTION public.guard_timesheet_payroll_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_pay record;
BEGIN
  IF TG_OP='UPDATE' THEN
    NEW.revision := OLD.revision+1;
    IF OLD.payroll_snapshot IS NOT NULL AND NEW.payroll_snapshot IS DISTINCT FROM OLD.payroll_snapshot THEN
      RAISE EXCEPTION 'Exported payroll evidence is immutable';
    END IF;
    IF OLD.payroll_snapshot IS NOT NULL AND
      ROW(NEW.staff_id,NEW.organization_id,NEW.period_start,NEW.period_end,NEW.actual_hours,
        NEW.overtime_hours,NEW.pay_code_override,NEW.hourly_rate_override,NEW.payroll_export_batch_id,NEW.status)
      IS DISTINCT FROM
      ROW(OLD.staff_id,OLD.organization_id,OLD.period_start,OLD.period_end,OLD.actual_hours,
        OLD.overtime_hours,OLD.pay_code_override,OLD.hourly_rate_override,OLD.payroll_export_batch_id,OLD.status) THEN
      RAISE EXCEPTION 'Exported payroll values are immutable';
    END IF;
    IF current_user NOT IN ('postgres','service_role') AND
      (NEW.recovery_request IS DISTINCT FROM OLD.recovery_request
       OR NEW.pay_code_override IS DISTINCT FROM OLD.pay_code_override
       OR NEW.hourly_rate_override IS DISTINCT FROM OLD.hourly_rate_override
       OR NEW.pay_override_reason IS DISTINCT FROM OLD.pay_override_reason
       OR NEW.payroll_snapshot IS DISTINCT FROM OLD.payroll_snapshot) THEN
      RAISE EXCEPTION 'Use the governed payroll correction RPC';
    END IF;
    IF (NEW.recovery_request IS NOT NULL OR NEW.pay_override_reason IS NOT NULL)
      AND NEW.status='approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
      IF OLD.status<>'branch_checked' OR NEW.branch_reviewed_by IS NULL
        OR NEW.branch_reviewed_by IS NOT DISTINCT FROM NEW.approved_by
        OR NEW.approved_by IS DISTINCT FROM auth.uid()
        OR NOT public.is_timesheet_payroll_admin(NEW.organization_id) THEN
        RAISE EXCEPTION 'Manual payroll evidence requires branch check and a different corporate final reviewer';
      END IF;
    END IF;
    IF NEW.status='paid' AND OLD.status='approved' THEN
      IF NOT public.is_timesheet_payroll_admin(NEW.organization_id) THEN
        RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE='42501';
      END IF;
      SELECT * INTO v_pay FROM public.timesheet_effective_pay(OLD.id);
      IF NOT FOUND OR v_pay.hourly_rate IS NULL OR v_pay.hourly_rate<0 OR v_pay.hourly_rate>100000
        OR v_pay.hourly_rate='NaN'::numeric OR nullif(btrim(v_pay.pay_code),'') IS NULL THEN
        RAISE EXCEPTION 'Resolve the hourly pay rate and pay code before payroll export';
      END IF;
      NEW.payroll_snapshot := jsonb_build_object('pay_code',v_pay.pay_code,'hourly_rate',v_pay.hourly_rate,
        'rate_rule_id',v_pay.rate_rule_id,'hours',NEW.actual_hours,'overtime_hours',NEW.overtime_hours,
        'gross_amount',round(NEW.actual_hours*v_pay.hourly_rate,2),'override_reason',NEW.pay_override_reason,
        'evidence_kind',coalesce(NEW.work_summary->>'evidence_kind','officer_work'),
        'exported_at',clock_timestamp());
    END IF;
  ELSIF current_user NOT IN ('postgres','service_role') AND
    (NEW.recovery_request IS NOT NULL OR NEW.pay_code_override IS NOT NULL OR NEW.hourly_rate_override IS NOT NULL
      OR NEW.pay_override_reason IS NOT NULL OR NEW.payroll_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'Use the governed payroll recovery RPC';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_timesheet_payroll_evidence() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER guard_timesheet_payroll_evidence BEFORE INSERT OR UPDATE ON public.timesheets
FOR EACH ROW EXECUTE FUNCTION public.guard_timesheet_payroll_evidence();

CREATE FUNCTION public.get_timesheet_payroll_export(p_batch_id uuid)
RETURNS TABLE(timesheet_id uuid,staff_id uuid,period_start date,period_end date,payroll_snapshot jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.payroll_export_batches WHERE id=p_batch_id;
  IF NOT public.is_timesheet_payroll_admin(v_org) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT t.id,t.staff_id,t.period_start,t.period_end,t.payroll_snapshot
    FROM public.timesheets t WHERE t.organization_id=v_org AND t.payroll_export_batch_id=p_batch_id
    ORDER BY t.period_start,t.staff_id,t.id;
END $$;
REVOKE ALL ON FUNCTION public.get_timesheet_payroll_export(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_timesheet_payroll_export(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.create_payroll_export_batch(
  p_client_request_id uuid,p_organization_id uuid,p_period_from date,p_period_to date,
  p_format text DEFAULT 'csv',p_notes text DEFAULT NULL
)
RETURNS TABLE(batch_id uuid,timesheet_count integer,total_hours numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_batch public.payroll_export_batches%rowtype; v_ids uuid[]; v_blocker text;
  v_count integer; v_hours numeric; v_receipt jsonb;
BEGIN
  IF NOT public.is_timesheet_payroll_admin(p_organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE='42501';
  END IF;
  IF p_client_request_id IS NULL OR p_period_from IS NULL OR p_period_to IS NULL OR p_period_to<p_period_from THEN
    RAISE EXCEPTION 'A request ID and valid export period are required';
  END IF;
  IF p_format NOT IN ('csv','json','ird_csv') OR p_format IS NULL THEN RAISE EXCEPTION 'Unsupported payroll export format'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payroll_export:'||p_organization_id::text,0));
  SELECT metadata INTO v_receipt FROM public.audit_log WHERE organization_id=p_organization_id
    AND action='payroll_export_batch_created' AND metadata->>'client_request_id'=p_client_request_id::text;
  IF FOUND THEN
    IF v_receipt->>'period_from' IS DISTINCT FROM p_period_from::text
      OR v_receipt->>'period_to' IS DISTINCT FROM p_period_to::text
      OR v_receipt->>'format' IS DISTINCT FROM p_format THEN RAISE EXCEPTION 'Request ID already used with different export details'; END IF;
    RETURN QUERY SELECT b.id,b.timesheet_count,b.total_hours FROM public.payroll_export_batches b
      JOIN public.audit_log a ON a.target_id=b.id WHERE a.organization_id=p_organization_id
        AND a.action='payroll_export_batch_created' AND a.metadata->>'client_request_id'=p_client_request_id::text;
    RETURN;
  END IF;
  SELECT array_agg(locked.id) INTO v_ids FROM (
    SELECT t.id FROM public.timesheets t WHERE t.organization_id=p_organization_id
      AND t.status='approved' AND t.payroll_export_batch_id IS NULL
      AND t.period_start>=p_period_from AND t.period_end<=p_period_to ORDER BY t.id FOR UPDATE
  ) locked;
  v_count := coalesce(array_length(v_ids,1),0);
  IF v_count=0 THEN RAISE EXCEPTION 'No approved unexported timesheets in this period'; END IF;
  SELECT public.timesheet_dispatch_pay_review_blocker(t.id) INTO v_blocker FROM public.timesheets t
    WHERE t.id=ANY(v_ids) AND public.timesheet_dispatch_pay_review_blocker(t.id) IS NOT NULL LIMIT 1;
  IF v_blocker IS NOT NULL THEN RAISE EXCEPTION 'Payroll export blocked: %',v_blocker; END IF;
  SELECT sum(coalesce(t.actual_hours,t.work_derived_hours,0)) INTO v_hours FROM public.timesheets t WHERE t.id=ANY(v_ids);
  INSERT INTO public.payroll_export_batches(organization_id,exported_by,period_from,period_to,format,timesheet_count,total_hours,notes)
    VALUES(p_organization_id,auth.uid(),p_period_from,p_period_to,p_format,v_count,v_hours,nullif(btrim(p_notes),''))
    RETURNING * INTO v_batch;
  UPDATE public.timesheets SET payroll_export_batch_id=v_batch.id,status='paid' WHERE id=ANY(v_ids);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(p_organization_id,auth.uid(),'payroll_export_batch_created','payroll_export_batches',v_batch.id,
      jsonb_build_object('period_from',p_period_from,'period_to',p_period_to,'timesheet_count',v_count,
        'total_hours',v_hours,'format',p_format,'client_request_id',p_client_request_id));
  RETURN QUERY SELECT v_batch.id,v_batch.timesheet_count,v_batch.total_hours;
END $$;
REVOKE ALL ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) TO authenticated, service_role;

-- Keep the finance attribution/receipt implementation intact; replace only its rate lookup
-- with the same timesheet-scoped calculation used by payroll export.
DO $$
DECLARE v_def text; v_old text;
BEGIN
  SELECT pg_get_functiondef('public.post_finance_timesheet_labour_cost(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure) INTO v_def;
  v_old := substring(v_def FROM '  SELECT r.id AS rate_rule_id, r.amount.*?  LIMIT 1;');
  IF v_old IS NULL THEN RAISE EXCEPTION 'Finance rate lookup changed; review migration before applying'; END IF;
  v_def := replace(v_def,v_old,
    '  SELECT p.rate_rule_id, p.hourly_rate AS amount INTO v_rate FROM public.timesheet_effective_pay(v_sheet.id) p;');
  v_def := replace(v_def,
    'CASE WHEN v_rate.rate_rule_id IS NULL THEN ''unresolved'' ELSE ''resolved'' END',
    'CASE WHEN v_rate.amount IS NULL THEN ''unresolved'' ELSE ''resolved'' END');
  v_def := replace(v_def,'''hourly_rate'', COALESCE(v_rate.amount, 0)',
    '''pay_code_override'', v_sheet.pay_code_override, ''pay_override_reason'', v_sheet.pay_override_reason, ''hourly_rate'', COALESCE(v_rate.amount, 0)');
  EXECUTE v_def;
END $$;