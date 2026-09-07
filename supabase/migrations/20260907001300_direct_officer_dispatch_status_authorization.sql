-- Allow directly queued officers to advance their own investigation/dispatch jobs
-- without requiring an active shift or dispatch resource assignment.

CREATE OR REPLACE FUNCTION public.advance_dispatch_job_status(
  p_job_id uuid,
  p_expected_status text,
  p_next_status text,
  p_outcome_notes text DEFAULT NULL
) RETURNS TABLE(id uuid, status text, shift_id uuid, completed_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.dispatch_jobs%rowtype;
  v_allowed boolean := false;
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs WHERE public.dispatch_jobs.id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF NOT public.is_admin_for_org(v_job.organization_id) AND NOT EXISTS (
    SELECT 1 FROM public.dispatch_resources dr WHERE dr.id=v_job.dispatch_resource_id AND dr.assigned_officer_id=auth.uid()
  ) AND v_job.assigned_officer_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Not authorised to update this dispatch job';
  END IF;
  IF v_job.status <> p_expected_status THEN RAISE EXCEPTION 'Dispatch job changed from expected status'; END IF;
  v_allowed := CASE v_job.status
    WHEN 'pending' THEN p_next_status IN ('dispatched', 'cancelled')
    WHEN 'dispatched' THEN p_next_status IN ('acknowledged', 'en_route', 'cancelled')
    WHEN 'acknowledged' THEN p_next_status IN ('en_route', 'cancelled')
    WHEN 'en_route' THEN p_next_status IN ('on_scene', 'cancelled')
    WHEN 'on_scene' THEN p_next_status IN ('completed', 'cancelled')
    ELSE false END;
  IF NOT v_allowed THEN RAISE EXCEPTION 'Invalid dispatch transition'; END IF;
  IF p_next_status IN ('completed', 'cancelled') AND nullif(trim(p_outcome_notes), '') IS NULL THEN
    RAISE EXCEPTION 'Outcome notes are required for terminal dispatch transitions';
  END IF;
  UPDATE public.dispatch_jobs
    SET status=p_next_status,
        acknowledged_at=CASE WHEN p_next_status='acknowledged' THEN clock_timestamp() ELSE public.dispatch_jobs.acknowledged_at END,
        en_route_at=CASE WHEN p_next_status='en_route' THEN clock_timestamp() ELSE public.dispatch_jobs.en_route_at END,
        on_scene_at=CASE WHEN p_next_status='on_scene' THEN clock_timestamp() ELSE public.dispatch_jobs.on_scene_at END,
        completed_at=CASE WHEN p_next_status='completed' THEN clock_timestamp() ELSE public.dispatch_jobs.completed_at END,
        outcome_notes=CASE WHEN p_next_status IN ('completed','cancelled') THEN nullif(trim(p_outcome_notes),'') ELSE public.dispatch_jobs.outcome_notes END
    WHERE public.dispatch_jobs.id=p_job_id;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_job.organization_id,auth.uid(),'dispatch_job_status_advanced','dispatch_jobs',p_job_id,jsonb_build_object('previous_status',p_expected_status,'next_status',p_next_status,'assigned_officer_id',v_job.assigned_officer_id,'investigation_id',v_job.investigation_id));
  IF p_next_status = 'completed' AND v_job.investigation_id IS NOT NULL THEN
    INSERT INTO public.investigation_events (investigation_id, organization_id, event_type, description, source_table, source_id, created_by)
      VALUES(v_job.investigation_id, v_job.organization_id, 'follow_up_dispatch_completed', coalesce(nullif(trim(p_outcome_notes), ''), 'Investigation follow-up dispatch completed'), 'dispatch_jobs', p_job_id, auth.uid());
  END IF;
  RETURN QUERY SELECT updated.id, updated.status, updated.shift_id, updated.completed_at FROM public.dispatch_jobs AS updated WHERE updated.id=p_job_id;
END;
$$;
