CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE public.shift_timesheet_reviews (
  shift_id uuid PRIMARY KEY REFERENCES public.shifts(id),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  employer_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  staff_id uuid NOT NULL REFERENCES public.staff_profiles(id),
  source_revision text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 2000),
  reviewed_by uuid NOT NULL REFERENCES public.user_profiles(id),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
ALTER TABLE public.shift_timesheet_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.shift_timesheet_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.shift_timesheet_reviews TO authenticated;
CREATE POLICY shift_timesheet_reviews_employer_read ON public.shift_timesheet_reviews
  FOR SELECT TO authenticated USING (
    public.is_admin_for_org(organization_id)
    AND public.is_timesheet_payroll_admin(employer_organization_id)
  );
COMMENT ON TABLE public.shift_timesheet_reviews IS
  'Human review of source shift hours, not approval of a payroll period, payment, labour posting or invoice. Superseded decisions remain in audit_log.';

CREATE FUNCTION ops.shift_linked_timesheets(p_shift_id uuid)
RETURNS SETOF public.timesheets LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT t.* FROM public.timesheets t
  WHERE t.shift_id=p_shift_id
    OR EXISTS (SELECT 1 FROM public.timesheet_work_entries e
      WHERE e.timesheet_id=t.id AND e.source_type='shift' AND e.source_id=p_shift_id)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(t.work_summary->'manual_sources','[]'::jsonb)) source
      WHERE source->>'shift_id'=p_shift_id::text
        OR (source->>'source_type'='shift' AND source->>'source_id'=p_shift_id::text))
$$;
REVOKE ALL ON FUNCTION ops.shift_linked_timesheets(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Keep the existing calculation and branch-disclosure gates as the sole source.
ALTER FUNCTION public.get_timesheet_shift_rows(uuid,date,date,uuid) SET SCHEMA ops;
ALTER FUNCTION ops.get_timesheet_shift_rows(uuid,date,date,uuid) RENAME TO get_timesheet_shift_rows_source;
REVOKE ALL ON FUNCTION ops.get_timesheet_shift_rows_source(uuid,date,date,uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.get_timesheet_shift_rows(
  p_organization_id uuid, p_from date, p_to date, p_staff_id uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = '' SET timezone = 'UTC' AS $$
BEGIN
  RETURN (
    WITH source AS (
      SELECT item.data, s.id, s.scheduled_start, s.status, s.scheduled_end, s.updated_at,
        sp.organization_id AS employer_organization_id, sp.employee_number,
        sa.id AS service_agreement_id, sa.client_organization_id, client.name AS client_name,
        place.id AS place_id, place.name AS location_name,
        CASE WHEN sa.id IS NULL THEN 'No agreement recipient linked'
          WHEN place.id IS NULL THEN 'No worked location linked'
          WHEN s.location_id IS NOT NULL AND shift_zone.location_id IS NOT NULL
            AND s.location_id<>shift_zone.location_id THEN 'Shift location and zone disagree'
          WHEN coalesce(s.location_id,shift_zone.location_id) IS NOT NULL AND coalesce(site.location_id,zone.location_id) IS NOT NULL
            AND coalesce(s.location_id,shift_zone.location_id)<>coalesce(site.location_id,zone.location_id)
            THEN 'Shift and agreement places disagree' ELSE NULL END AS client_link_problem,
        payroll.locked, payroll.unallocated_adjustment, payroll.versions, payroll.rejected,
        public.is_admin_for_org(p_organization_id)
          AND public.is_timesheet_payroll_admin(sp.organization_id) AS employer_reviewer
      FROM jsonb_array_elements(ops.get_timesheet_shift_rows_source(p_organization_id,p_from,p_to,p_staff_id)) item(data)
      JOIN public.shifts s ON s.id=(item.data->>'id')::uuid
      LEFT JOIN public.staff_profiles sp ON sp.id=(item.data->>'staff_id')::uuid
      LEFT JOIN public.service_agreement_locations sal ON sal.id=s.service_agreement_location_id
      LEFT JOIN public.service_agreements sa ON sa.id=sal.service_agreement_id
      LEFT JOIN public.organizations client ON client.id=sa.client_organization_id
      LEFT JOIN public.client_sites site ON site.id=sal.site_id
      LEFT JOIN public.location_zones zone ON zone.id=sal.zone_id
      LEFT JOIN public.location_zones shift_zone ON shift_zone.id=s.zone_id
      LEFT JOIN public.locations place ON place.id=coalesce(s.location_id,shift_zone.location_id,site.location_id,zone.location_id)
      LEFT JOIN LATERAL (
        SELECT coalesce(bool_or(t.status='paid' OR t.payroll_export_batch_id IS NOT NULL
            OR t.payroll_snapshot IS NOT NULL),false) AS locked,
          coalesce(bool_or(coalesce(t.adjustment_hours,0)<>0
            AND coalesce(t.work_summary->>'evidence_kind','')<>'manual_admin'),false) AS unallocated_adjustment,
          jsonb_agg(jsonb_build_object('id',t.id,'revision',t.revision,'status',t.status) ORDER BY t.id) AS versions,
          bool_or(t.status='rejected') AS rejected
        FROM ops.shift_linked_timesheets(s.id) t
      ) payroll ON true
    ), bound AS (
      SELECT source.*,
        md5(jsonb_build_object(
          'evidence',data-'pay_rate'-'charge_rate'-'staff_name'-'correction_reason',
          'payroll',versions,'agreement',service_agreement_id,
          'recipient',client_organization_id,'place',place_id
        )::text) AS source_revision,
        coalesce(employer_reviewer,false) AND NOT locked AND status<>'in_progress'
          AND scheduled_end<=now() AS can_edit
      FROM source
    )
    SELECT coalesce(jsonb_agg(data||jsonb_build_object(
      'source_revision',bound.source_revision,'review_revision',coalesce(review.revision,0),
      'review_status',CASE WHEN locked THEN 'finalised'
        WHEN review.source_revision=bound.source_revision THEN review.decision
        WHEN review.shift_id IS NOT NULL THEN 'needs_review'
        WHEN rejected THEN 'rejected'
        ELSE 'needs_review' END,
      'can_edit_hours',can_edit,
      'can_review_hours',can_edit AND NOT unallocated_adjustment
        AND (data->>'payable_end')::timestamptz>(data->>'payable_start')::timestamptz
        AND (data->>'payable_end')::timestamptz<=now()
        AND (data->>'unpaid_minutes')::numeric BETWEEN 0
          AND extract(epoch FROM ((data->>'payable_end')::timestamptz-(data->>'payable_start')::timestamptz))/60,
      'client_organization_id',client_organization_id,'client_name',client_name,
      'service_agreement_id',service_agreement_id,'location_name',location_name,
      'client_link_problem',client_link_problem,
      'payroll_adjustment_pending',unallocated_adjustment
    )||CASE WHEN employer_reviewer THEN jsonb_build_object(
      'employee_number',employee_number,'review_reason',review.reason
    ) ELSE '{}'::jsonb END ORDER BY scheduled_start,bound.id),'[]'::jsonb)
    FROM bound LEFT JOIN public.shift_timesheet_reviews review ON review.shift_id=bound.id
  );
END $$;
REVOKE ALL ON FUNCTION public.get_timesheet_shift_rows(uuid,date,date,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_timesheet_shift_rows(uuid,date,date,uuid) TO authenticated, service_role;

CREATE FUNCTION public.review_shift_timesheet_hours(
  p_client_request_id uuid, p_organization_id uuid, p_rows jsonb, p_decision text, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  v_shift public.shifts%rowtype;
  v_review public.shift_timesheet_reviews%rowtype;
  v_existing public.audit_log%rowtype;
  v_row jsonb; v_source jsonb; v_request jsonb; v_receipt jsonb;
  v_previous jsonb := '[]'::jsonb;
  v_ids uuid[]; v_staff_org uuid; v_date date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Employer hours review authority required' USING ERRCODE='42501';
  END IF;
  IF p_client_request_id IS NULL OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100
    OR p_decision IS NULL OR p_decision NOT IN ('approved','rejected')
    OR length(coalesce(btrim(p_reason),'')) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Choose 1 to 100 shifts, a decision and a reason of 1 to 2000 characters';
  END IF;
  v_request:=jsonb_build_object('rows',p_rows,'decision',p_decision,'reason',btrim(p_reason));
  PERFORM pg_advisory_xact_lock(hashtextextended('shift-hours-review:'||p_organization_id::text||':'||p_client_request_id::text,0));
  SELECT * INTO v_existing FROM public.audit_log WHERE organization_id=p_organization_id
    AND action='shift_timesheet_hours_reviewed' AND metadata->>'client_request_id'=p_client_request_id::text LIMIT 1;
  IF FOUND THEN
    IF v_existing.actor_user_id IS DISTINCT FROM auth.uid() OR v_existing.metadata->'request' IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Review request already used with different inputs';
    END IF;
    RETURN v_existing.metadata->'receipt';
  END IF;
  SELECT array_agg((item->>'shift_id')::uuid ORDER BY item->>'shift_id') INTO v_ids FROM jsonb_array_elements(p_rows) item;
  IF cardinality(v_ids)<>(SELECT count(DISTINCT value) FROM unnest(v_ids) value)
    OR array_position(v_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Choose each valid shift once'; END IF;
  PERFORM 1 FROM public.shifts WHERE id=ANY(v_ids) ORDER BY id FOR UPDATE;
  FOR v_row IN SELECT item FROM jsonb_array_elements(p_rows) item ORDER BY item->>'shift_id' LOOP
    SELECT * INTO v_shift FROM public.shifts WHERE id=(v_row->>'shift_id')::uuid;
    IF NOT FOUND OR v_shift.organization_id<>p_organization_id THEN
      RAISE EXCEPTION 'Shift review authority required' USING ERRCODE='42501';
    END IF;
    v_date:=(v_shift.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date;
    SELECT item INTO v_source FROM jsonb_array_elements(public.get_timesheet_shift_rows(
      p_organization_id,v_date,v_date,NULL)) item WHERE item->>'id'=v_shift.id::text;
    IF v_source IS NULL OR NOT coalesce((v_source->>'can_edit_hours')::boolean,false)
      OR coalesce((v_source->>'payroll_adjustment_pending')::boolean,true)
      OR (p_decision='approved' AND NOT coalesce((v_source->>'can_review_hours')::boolean,false)) THEN
      RAISE EXCEPTION 'Employer review authority and unfinalised hours required; approval also requires complete hours without unallocated adjustments' USING ERRCODE='42501';
    END IF;
    IF v_source->>'source_revision' IS DISTINCT FROM v_row->>'source_revision'
      OR (v_source->>'review_revision')::integer IS DISTINCT FROM (v_row->>'review_revision')::integer THEN
      RAISE EXCEPTION 'Shift hours or review changed; reload before deciding' USING ERRCODE='40001';
    END IF;
    SELECT * INTO v_review FROM public.shift_timesheet_reviews WHERE shift_id=v_shift.id FOR UPDATE;
    v_previous:=v_previous||jsonb_build_array(to_jsonb(v_review));
    SELECT sp.organization_id INTO STRICT v_staff_org FROM public.staff_profiles sp WHERE sp.id=(v_source->>'staff_id')::uuid;
    INSERT INTO public.shift_timesheet_reviews(shift_id,organization_id,employer_organization_id,staff_id,
      source_revision,decision,reason,reviewed_by)
    VALUES(v_shift.id,p_organization_id,v_staff_org,(v_source->>'staff_id')::uuid,
      v_source->>'source_revision',p_decision,btrim(p_reason),auth.uid())
    ON CONFLICT(shift_id) DO UPDATE SET organization_id=excluded.organization_id,
      employer_organization_id=excluded.employer_organization_id,staff_id=excluded.staff_id,
      source_revision=excluded.source_revision,decision=excluded.decision,reason=excluded.reason,
      reviewed_by=excluded.reviewed_by,reviewed_at=clock_timestamp(),revision=public.shift_timesheet_reviews.revision+1;
  END LOOP;
  v_receipt:=jsonb_build_object('request_id',p_client_request_id,'decision',p_decision,'shift_count',cardinality(v_ids),'shift_ids',to_jsonb(v_ids));
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(p_organization_id,auth.uid(),'shift_timesheet_hours_reviewed','shifts',v_ids[1],
    jsonb_build_object('client_request_id',p_client_request_id,'request',v_request,'receipt',v_receipt,'previous_reviews',v_previous));
  RETURN v_receipt;
END $$;
REVOKE ALL ON FUNCTION public.review_shift_timesheet_hours(uuid,uuid,jsonb,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_shift_timesheet_hours(uuid,uuid,jsonb,text,text) TO authenticated, service_role;

CREATE FUNCTION public.correct_reviewed_timesheet_shift_hours(
  p_client_request_id uuid, p_shift_id uuid, p_expected_updated_at timestamptz,
  p_expected_correction_updated_at timestamptz, p_staff_id uuid, p_payable_start timestamptz,
  p_payable_end timestamptz, p_unpaid_minutes integer, p_reason text, p_expected_source_revision text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' SET timezone = 'UTC' AS $$
DECLARE
  v_shift public.shifts%rowtype; v_sheet public.timesheets%rowtype;
  v_existing public.audit_log%rowtype; v_source jsonb; v_request jsonb; v_receipt jsonb; v_date date;
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Timesheet correction authority required' USING ERRCODE='42501';
  END IF;
  IF p_client_request_id IS NULL OR p_expected_source_revision IS NULL
    OR length(coalesce(btrim(p_reason),'')) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Current shift source, request ID and correction reason required';
  END IF;
  v_request:=jsonb_build_object('shift_id',p_shift_id,'source',p_expected_source_revision,
    'shift_version',p_expected_updated_at,'correction_version',p_expected_correction_updated_at,
    'staff_id',p_staff_id,'start',p_payable_start,'end',p_payable_end,'unpaid',p_unpaid_minutes,'reason',btrim(p_reason));
  PERFORM pg_advisory_xact_lock(hashtextextended('shift-timesheet-correction:'||v_shift.organization_id::text||':'||p_client_request_id::text,0));
  SELECT * INTO v_existing FROM public.audit_log WHERE organization_id=v_shift.organization_id
    AND action='reviewed_shift_hours_corrected' AND metadata->>'client_request_id'=p_client_request_id::text LIMIT 1;
  IF FOUND THEN
    IF v_existing.actor_user_id IS DISTINCT FROM auth.uid() OR v_existing.metadata->'request' IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Correction request already used with different inputs';
    END IF;
    RETURN v_existing.metadata->'receipt';
  END IF;
  IF EXISTS(SELECT 1 FROM public.audit_log WHERE organization_id=v_shift.organization_id
    AND action='timesheet_shift_hours_corrected' AND metadata->>'client_request_id'=p_client_request_id::text) THEN
    RAISE EXCEPTION 'Correction request already used by another correction path';
  END IF;
  v_date:=(v_shift.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date;
  SELECT item INTO v_source FROM jsonb_array_elements(public.get_timesheet_shift_rows(
    v_shift.organization_id,v_date,v_date,NULL)) item WHERE item->>'id'=p_shift_id::text;
  IF v_source->>'review_status'='finalised' THEN
    RAISE EXCEPTION 'Finalised payroll evidence requires a separate payroll amendment';
  END IF;
  IF v_source IS NULL OR NOT coalesce((v_source->>'can_edit_hours')::boolean,false) THEN
    RAISE EXCEPTION 'Employer payroll correction authority required' USING ERRCODE='42501';
  END IF;
  IF v_source->>'source_revision' IS DISTINCT FROM p_expected_source_revision THEN
    RAISE EXCEPTION 'Shift hours or linked payroll changed; reload before correcting' USING ERRCODE='40001';
  END IF;
  FOR v_sheet IN SELECT t.* FROM public.timesheets t JOIN ops.shift_linked_timesheets(p_shift_id) linked ON linked.id=t.id
    ORDER BY t.id FOR UPDATE OF t LOOP
    IF v_sheet.status='paid' OR v_sheet.payroll_export_batch_id IS NOT NULL OR v_sheet.payroll_snapshot IS NOT NULL THEN
      RAISE EXCEPTION 'Finalised payroll evidence requires a separate payroll amendment';
    END IF;
    IF v_sheet.status='approved' THEN
      PERFORM public.reopen_approved_timesheet(v_sheet.id,v_sheet.revision,btrim(p_reason));
    END IF;
  END LOOP;
  v_receipt:=public.correct_timesheet_shift_hours(p_client_request_id,p_shift_id,p_expected_updated_at,
    p_expected_correction_updated_at,p_staff_id,p_payable_start,p_payable_end,p_unpaid_minutes,p_reason);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_shift.organization_id,auth.uid(),'reviewed_shift_hours_corrected','shifts',p_shift_id,
    jsonb_build_object('client_request_id',p_client_request_id,'request',v_request,'receipt',v_receipt));
  RETURN v_receipt;
END $$;
REVOKE ALL ON FUNCTION public.correct_reviewed_timesheet_shift_hours(uuid,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz,integer,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_reviewed_timesheet_shift_hours(uuid,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz,integer,text,text) TO authenticated, service_role;