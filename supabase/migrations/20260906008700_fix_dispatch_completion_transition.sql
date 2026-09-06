CREATE OR REPLACE FUNCTION public.advance_dispatch_job_status(p_job_id uuid,p_expected_status text,p_next_status text,p_outcome_notes text DEFAULT NULL)
RETURNS TABLE(id uuid,status text,shift_id uuid,completed_at timestamptz) LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_job public.dispatch_jobs%rowtype; v_allowed boolean:=false;
BEGIN
  SELECT job.* INTO v_job FROM public.dispatch_jobs AS job WHERE job.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF NOT public.is_admin_for_org(v_job.organization_id) AND NOT EXISTS(SELECT 1 FROM public.dispatch_resources AS resource WHERE resource.id=v_job.dispatch_resource_id AND resource.assigned_officer_id=auth.uid()) THEN RAISE EXCEPTION 'Not authorised to update this dispatch job'; END IF;
  IF v_job.status<>p_expected_status THEN RAISE EXCEPTION 'Dispatch job changed from expected status % to %',p_expected_status,v_job.status; END IF;
  v_allowed:=CASE v_job.status WHEN 'pending' THEN p_next_status IN ('dispatched','cancelled') WHEN 'dispatched' THEN p_next_status IN ('acknowledged','en_route','cancelled') WHEN 'acknowledged' THEN p_next_status IN ('en_route','cancelled') WHEN 'en_route' THEN p_next_status IN ('on_scene','cancelled') WHEN 'on_scene' THEN p_next_status IN ('completed','cancelled') ELSE false END;
  IF NOT v_allowed THEN RAISE EXCEPTION 'Invalid dispatch transition from % to %',v_job.status,p_next_status; END IF;
  IF p_next_status IN ('completed','cancelled') AND nullif(trim(p_outcome_notes),'') IS NULL THEN RAISE EXCEPTION 'Outcome notes are required for terminal dispatch transitions'; END IF;
  UPDATE public.dispatch_jobs AS job SET status=p_next_status,acknowledged_at=CASE WHEN p_next_status='acknowledged' THEN now() ELSE v_job.acknowledged_at END,en_route_at=CASE WHEN p_next_status='en_route' THEN now() ELSE v_job.en_route_at END,on_scene_at=CASE WHEN p_next_status='on_scene' THEN now() ELSE v_job.on_scene_at END,completed_at=CASE WHEN p_next_status='completed' THEN now() ELSE v_job.completed_at END,outcome_notes=CASE WHEN p_next_status IN ('completed','cancelled') THEN nullif(trim(p_outcome_notes),'') ELSE v_job.outcome_notes END WHERE job.id=v_job.id;
  IF p_next_status IN ('completed','cancelled') AND v_job.dispatch_resource_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dispatch_jobs AS other WHERE other.dispatch_resource_id=v_job.dispatch_resource_id AND other.id<>v_job.id AND other.status IN ('dispatched','acknowledged','en_route','on_scene')) THEN UPDATE public.dispatch_resources AS resource SET status='available' WHERE resource.id=v_job.dispatch_resource_id; END IF;
  RETURN QUERY SELECT job.id,job.status,job.shift_id,job.completed_at FROM public.dispatch_jobs AS job WHERE job.id=v_job.id;
END; $$;