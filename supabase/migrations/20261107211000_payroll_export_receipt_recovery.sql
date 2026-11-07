-- Payroll batch receipt recovery, reconciled onto 20261106120100_admin_scheduled_timesheet_recovery.
-- Keeps that migration's employer-payroll authority, empty search_path, advisory lock, dispatch-pay
-- blocker, snapshot trigger path and grants. Adds a durable tenant-unique receipt key on the batch,
-- binds replays to actor/dates/format/notes, and confirms the exact locked sheet count was updated.
ALTER TABLE public.payroll_export_batches ADD COLUMN IF NOT EXISTS client_request_id uuid;

-- Carry existing audit-only receipts onto their batches so earlier requests still replay.
UPDATE public.payroll_export_batches b
SET client_request_id = receipt.request_id
FROM (
  SELECT a.organization_id, a.target_id, (a.metadata->>'client_request_id')::uuid AS request_id
  FROM public.audit_log a
  WHERE a.action = 'payroll_export_batch_created'
    AND a.target_table = 'payroll_export_batches'
    AND a.metadata->>'client_request_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
) receipt
WHERE b.id = receipt.target_id
  AND b.organization_id = receipt.organization_id
  AND b.client_request_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.audit_log other
    WHERE other.action = 'payroll_export_batch_created'
      AND other.organization_id = receipt.organization_id
      AND other.metadata->>'client_request_id' = receipt.request_id::text
      AND other.target_id IS DISTINCT FROM receipt.target_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS payroll_export_batches_org_request_id_key
  ON public.payroll_export_batches (organization_id, client_request_id);

CREATE OR REPLACE FUNCTION public.create_payroll_export_batch(
  p_client_request_id uuid,p_organization_id uuid,p_period_from date,p_period_to date,
  p_format text DEFAULT 'csv',p_notes text DEFAULT NULL
)
RETURNS TABLE(batch_id uuid,timesheet_count integer,total_hours numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_batch public.payroll_export_batches%rowtype; v_ids uuid[]; v_blocker text;
  v_count integer; v_hours numeric; v_updated integer;
  v_notes text := nullif(btrim(p_notes),'');
BEGIN
  IF NOT public.is_timesheet_payroll_admin(p_organization_id) THEN
    RAISE EXCEPTION 'Active employer payroll administrator required' USING ERRCODE='42501';
  END IF;
  IF p_client_request_id IS NULL OR p_period_from IS NULL OR p_period_to IS NULL OR p_period_to<p_period_from THEN
    RAISE EXCEPTION 'A request ID and valid export period are required';
  END IF;
  IF p_format NOT IN ('csv','json','ird_csv') OR p_format IS NULL THEN RAISE EXCEPTION 'Unsupported payroll export format'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('payroll_export:'||p_organization_id::text,0));

  SELECT b.* INTO v_batch FROM public.payroll_export_batches b
  WHERE b.organization_id=p_organization_id AND b.client_request_id=p_client_request_id;
  IF FOUND THEN
    IF v_batch.exported_by IS DISTINCT FROM v_actor
      OR v_batch.period_from IS DISTINCT FROM p_period_from
      OR v_batch.period_to IS DISTINCT FROM p_period_to
      OR v_batch.format IS DISTINCT FROM p_format
      OR v_batch.notes IS DISTINCT FROM v_notes THEN
      RAISE EXCEPTION 'Request ID already used with different export details';
    END IF;
    RETURN QUERY SELECT v_batch.id,v_batch.timesheet_count,v_batch.total_hours;
    RETURN;
  END IF;

  SELECT array_agg(locked.id),count(*)::integer,coalesce(sum(coalesce(locked.actual_hours,locked.work_derived_hours,0)),0)
  INTO v_ids,v_count,v_hours
  FROM (
    SELECT t.id,t.actual_hours,t.work_derived_hours FROM public.timesheets t
    WHERE t.organization_id=p_organization_id AND t.status='approved' AND t.payroll_export_batch_id IS NULL
      AND t.period_start>=p_period_from AND t.period_end<=p_period_to
    ORDER BY t.id FOR UPDATE
  ) locked;
  IF v_count=0 THEN RAISE EXCEPTION 'No approved unexported timesheets in this period'; END IF;
  SELECT public.timesheet_dispatch_pay_review_blocker(t.id) INTO v_blocker FROM public.timesheets t
    WHERE t.id=ANY(v_ids) AND public.timesheet_dispatch_pay_review_blocker(t.id) IS NOT NULL ORDER BY t.id LIMIT 1;
  IF v_blocker IS NOT NULL THEN RAISE EXCEPTION 'Payroll export blocked: %',v_blocker; END IF;

  INSERT INTO public.payroll_export_batches(organization_id,exported_by,period_from,period_to,format,timesheet_count,total_hours,notes,client_request_id)
    VALUES(p_organization_id,v_actor,p_period_from,p_period_to,p_format,v_count,v_hours,v_notes,p_client_request_id)
    RETURNING * INTO v_batch;
  UPDATE public.timesheets t SET payroll_export_batch_id=v_batch.id,status='paid'
    WHERE t.organization_id=p_organization_id AND t.id=ANY(v_ids);
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated<>v_count THEN RAISE EXCEPTION 'Payroll batch timesheet count could not be confirmed'; END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(p_organization_id,v_actor,'payroll_export_batch_created','payroll_export_batches',v_batch.id,
      jsonb_build_object('period_from',p_period_from,'period_to',p_period_to,'timesheet_count',v_count,
        'total_hours',v_hours,'format',p_format,'client_request_id',p_client_request_id));
  RETURN QUERY SELECT v_batch.id,v_batch.timesheet_count,v_batch.total_hours;
END $$;
REVOKE ALL ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_payroll_export_batch(uuid,uuid,date,date,text,text) TO authenticated, service_role;
