CREATE OR REPLACE FUNCTION public.create_dispatch_job(
  p_organization_id uuid, p_service_agreement_id uuid, p_client_site_id uuid, p_client_request_id uuid,
  p_job_type text, p_priority text, p_sla_minutes integer, p_dispatch_resource_id uuid DEFAULT NULL,
  p_briefing_notes text DEFAULT NULL, p_shift_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid, created boolean, status text, sla_respond_by timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_existing public.dispatch_jobs%rowtype; v_created public.dispatch_jobs%rowtype; v_resource public.dispatch_resources%rowtype; v_shift public.shifts%rowtype;
  v_dwell_minutes integer := 5; v_timing_source text := 'dispatch_default';
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Not authorised to create dispatch jobs for this organisation'; END IF;
  IF p_sla_minutes NOT BETWEEN 1 AND 1440 THEN RAISE EXCEPTION 'SLA minutes must be between 1 and 1440'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.service_agreements AS agreement JOIN public.service_agreement_locations AS link ON link.service_agreement_id=agreement.id JOIN public.client_sites AS site ON site.id=link.site_id WHERE agreement.id=p_service_agreement_id AND agreement.provider_organization_id=p_organization_id AND link.site_id=p_client_site_id AND link.status='active' AND site.active) THEN RAISE EXCEPTION 'Site is not active under this service agreement'; END IF;
  SELECT coalesce(max((service.config ->> 'expected_dwell_minutes')::integer), 5) INTO v_dwell_minutes FROM public.site_services AS service WHERE service.service_agreement_id=p_service_agreement_id AND service.site_id=p_client_site_id AND service.module_key=p_job_type AND service.active;
  IF EXISTS (SELECT 1 FROM public.site_services AS service WHERE service.service_agreement_id=p_service_agreement_id AND service.site_id=p_client_site_id AND service.module_key=p_job_type AND service.active) THEN v_timing_source := 'site_service'; END IF;
  SELECT job.* INTO v_existing FROM public.dispatch_jobs AS job WHERE job.organization_id=p_organization_id AND job.client_request_id=p_client_request_id;
  IF FOUND THEN RETURN QUERY SELECT v_existing.id,false,v_existing.status,v_existing.sla_respond_by; RETURN; END IF;
  IF p_dispatch_resource_id IS NOT NULL THEN
    IF p_shift_id IS NULL THEN RAISE EXCEPTION 'A shift is required when dispatching to a resource'; END IF;
    SELECT resource.* INTO v_resource FROM public.dispatch_resources AS resource WHERE resource.id=p_dispatch_resource_id AND resource.organization_id=p_organization_id FOR UPDATE;
    IF NOT FOUND OR v_resource.status<>'available' OR v_resource.assigned_officer_id IS NULL THEN RAISE EXCEPTION 'Dispatch resource is not available with an assigned officer'; END IF;
    SELECT shift.* INTO v_shift FROM public.shifts AS shift WHERE shift.id=p_shift_id AND shift.organization_id=p_organization_id AND shift.status IN ('accepted','in_progress') FOR SHARE;
    IF NOT FOUND OR v_shift.officer_user_id<>v_resource.assigned_officer_id THEN RAISE EXCEPTION 'Shift officer does not match the selected dispatch resource'; END IF;
  ELSIF p_shift_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shifts AS shift WHERE shift.id=p_shift_id AND shift.organization_id=p_organization_id AND shift.status IN ('accepted','in_progress')) THEN RAISE EXCEPTION 'Shift is not active in this organisation'; END IF;
  BEGIN
    INSERT INTO public.dispatch_jobs(organization_id,service_agreement_id,client_site_id,client_request_id,dispatch_resource_id,job_type,priority,status,sla_minutes,sla_respond_by,expected_dwell_minutes,timing_source,briefing_notes,shift_id,dispatched_at)
    VALUES(p_organization_id,p_service_agreement_id,p_client_site_id,p_client_request_id,p_dispatch_resource_id,p_job_type,p_priority,CASE WHEN p_dispatch_resource_id IS NULL THEN 'pending' ELSE 'dispatched' END,p_sla_minutes,now()+make_interval(mins=>p_sla_minutes),v_dwell_minutes,v_timing_source,nullif(trim(p_briefing_notes),''),p_shift_id,CASE WHEN p_dispatch_resource_id IS NULL THEN NULL ELSE now() END) RETURNING * INTO v_created;
    IF p_dispatch_resource_id IS NOT NULL THEN UPDATE public.dispatch_resources AS resource SET status='busy' WHERE resource.id=p_dispatch_resource_id; END IF;
  EXCEPTION WHEN unique_violation THEN
    SELECT job.* INTO v_created FROM public.dispatch_jobs AS job WHERE job.organization_id=p_organization_id AND job.client_request_id=p_client_request_id;
    RETURN QUERY SELECT v_created.id,false,v_created.status,v_created.sla_respond_by; RETURN;
  END;
  RETURN QUERY SELECT v_created.id,true,v_created.status,v_created.sla_respond_by;
END; $$;