-- Governed dispatch operator controls. Browser clients must use these RPCs.

CREATE OR REPLACE FUNCTION public.manage_dispatch_job(
  p_job_id uuid,
  p_expected_status text,
  p_action text,
  p_priority text DEFAULT NULL,
  p_briefing_notes text DEFAULT NULL,
  p_dispatch_resource_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS public.dispatch_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid := auth.uid(); v_job public.dispatch_jobs%rowtype;
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_job.organization_id) THEN RAISE EXCEPTION 'Dispatch job not found or access denied'; END IF;
  IF v_job.status <> p_expected_status THEN RAISE EXCEPTION 'Dispatch job changed since it was opened'; END IF;
  IF v_job.status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Completed or cancelled jobs cannot be changed'; END IF;
  IF p_action NOT IN ('amend','reassign','escalate','cancel') THEN RAISE EXCEPTION 'Unsupported dispatch job action'; END IF;
  IF nullif(trim(coalesce(p_reason,'')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_priority IS NOT NULL AND p_priority NOT IN ('low','normal','high','urgent') THEN RAISE EXCEPTION 'Unsupported priority'; END IF;
  IF p_action = 'cancel' THEN
    UPDATE public.dispatch_jobs SET status='cancelled', outcome_notes=concat_ws(E'\n', outcome_notes, 'Cancelled: ' || trim(p_reason)) WHERE id=v_job.id RETURNING * INTO v_job;
  ELSE
    UPDATE public.dispatch_jobs SET
      priority=CASE WHEN p_action='escalate' THEN 'urgent' ELSE coalesce(p_priority, priority) END,
      briefing_notes=coalesce(nullif(trim(p_briefing_notes),''), briefing_notes),
      dispatch_resource_id=CASE WHEN p_action='reassign' THEN p_dispatch_resource_id ELSE dispatch_resource_id END,
      sla_impact_warning=CASE WHEN p_action='escalate' THEN true ELSE sla_impact_warning END
    WHERE id=v_job.id RETURNING * INTO v_job;
  END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_job.organization_id,v_actor,'dispatch_job_'||p_action,'dispatch_jobs',v_job.id,jsonb_build_object('reason',trim(p_reason),'priority',v_job.priority,'dispatch_resource_id',v_job.dispatch_resource_id,'status',v_job.status));
  RETURN v_job;
END; $$;

CREATE OR REPLACE FUNCTION public.manage_shift_stop(
  p_stop_id uuid,
  p_expected_status text,
  p_action text,
  p_new_order integer DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS public.shift_stops
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid := auth.uid(); v_stop public.shift_stops%rowtype; v_max integer;
BEGIN
  SELECT * INTO v_stop FROM public.shift_stops WHERE id=p_stop_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_stop.organization_id) THEN RAISE EXCEPTION 'Shift stop not found or access denied'; END IF;
  IF v_stop.status <> p_expected_status THEN RAISE EXCEPTION 'Shift stop changed since it was opened'; END IF;
  IF p_action NOT IN ('reorder','skip','cancel') THEN RAISE EXCEPTION 'Unsupported shift stop action'; END IF;
  IF nullif(trim(coalesce(p_reason,'')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_action IN ('skip','cancel') AND v_stop.actual_arrived_at IS NOT NULL THEN RAISE EXCEPTION 'An attended stop cannot be skipped or cancelled'; END IF;
  IF p_action='reorder' THEN
    SELECT coalesce(max(stop_order),0) INTO v_max FROM public.shift_stops WHERE shift_id=v_stop.shift_id;
    IF p_new_order IS NULL OR p_new_order < 1 OR p_new_order > v_max THEN RAISE EXCEPTION 'Stop position is outside the shift route'; END IF;
    UPDATE public.shift_stops SET stop_order=p_new_order, updated_at=clock_timestamp() WHERE id=v_stop.id RETURNING * INTO v_stop;
  ELSE
    UPDATE public.shift_stops SET status=CASE WHEN p_action='skip' THEN 'skipped' ELSE 'cancelled' END, officer_notes=concat_ws(E'\n', officer_notes, trim(p_reason)), updated_at=clock_timestamp() WHERE id=v_stop.id RETURNING * INTO v_stop;
  END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_stop.organization_id,v_actor,'shift_stop_'||p_action,'shift_stops',v_stop.id,jsonb_build_object('shift_id',v_stop.shift_id,'stop_order',v_stop.stop_order,'reason',trim(p_reason)));
  RETURN v_stop;
END; $$;

CREATE OR REPLACE FUNCTION public.manage_active_shift(
  p_shift_id uuid,
  p_expected_status text,
  p_action text,
  p_notes text DEFAULT NULL,
  p_reason text DEFAULT NULL
) RETURNS public.shifts
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid := auth.uid(); v_shift public.shifts%rowtype;
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_shift.organization_id) THEN RAISE EXCEPTION 'Shift not found or access denied'; END IF;
  IF v_shift.status <> p_expected_status THEN RAISE EXCEPTION 'Shift changed since it was opened'; END IF;
  IF p_action NOT IN ('amend','escalate','cancel') THEN RAISE EXCEPTION 'Unsupported active shift action'; END IF;
  IF nullif(trim(coalesce(p_reason,'')), '') IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF p_action='cancel' AND v_shift.actual_start IS NOT NULL THEN RAISE EXCEPTION 'An active shift cannot be cancelled after it has started'; END IF;
  UPDATE public.shifts SET notes=coalesce(nullif(trim(p_notes),''),notes), shift_health=CASE WHEN p_action='escalate' THEN 'critical' ELSE shift_health END, status=CASE WHEN p_action='cancel' THEN 'cancelled' ELSE status END, updated_at=clock_timestamp() WHERE id=v_shift.id RETURNING * INTO v_shift;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_shift.organization_id,v_actor,'shift_'||p_action,'shifts',v_shift.id,jsonb_build_object('reason',trim(p_reason),'status',v_shift.status,'shift_health',v_shift.shift_health));
  RETURN v_shift;
END; $$;

REVOKE ALL ON FUNCTION public.manage_dispatch_job(uuid,text,text,text,text,uuid,text), public.manage_shift_stop(uuid,text,text,integer,text), public.manage_active_shift(uuid,text,text,text,text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.manage_dispatch_job(uuid,text,text,text,text,uuid,text), public.manage_shift_stop(uuid,text,text,integer,text), public.manage_active_shift(uuid,text,text,text,text) TO authenticated, service_role;
