-- Workforce extension: direct officer queueing, work-unit-linked ad-hoc shifts,
-- and module authorization without requiring a pre-published roster slot.

ALTER TABLE public.dispatch_jobs
  ADD COLUMN IF NOT EXISTS assigned_officer_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS work_unit_id uuid REFERENCES public.roster_work_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS module_key text;

ALTER TABLE public.shifts
  ADD COLUMN IF NOT EXISTS work_unit_id uuid REFERENCES public.roster_work_units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS module_key text,
  ADD COLUMN IF NOT EXISTS shift_origin text NOT NULL DEFAULT 'rostered';

ALTER TABLE public.shifts DROP CONSTRAINT IF EXISTS shifts_origin_check;
ALTER TABLE public.shifts ADD CONSTRAINT shifts_origin_check CHECK (shift_origin IN ('rostered','ad_hoc','investigation_follow_up'));

CREATE INDEX IF NOT EXISTS dispatch_jobs_assigned_officer_queue
  ON public.dispatch_jobs (assigned_officer_id, status, created_at DESC)
  WHERE assigned_officer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS shifts_officer_active_queue
  ON public.shifts (officer_user_id, status, scheduled_start DESC);

CREATE OR REPLACE FUNCTION public.queue_dispatch_job_for_officer(
  p_organization_id uuid,
  p_service_agreement_id uuid,
  p_client_site_id uuid,
  p_client_request_id uuid,
  p_officer_user_id uuid,
  p_work_unit_id uuid,
  p_module_key text,
  p_job_type text,
  p_priority text,
  p_sla_minutes integer,
  p_briefing_notes text DEFAULT NULL
) RETURNS TABLE(id uuid, created boolean, status text, assigned_officer_id uuid, work_unit_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_job record; v_unit public.roster_work_units%rowtype;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Active organization administrator required'; END IF;
  SELECT * INTO v_unit FROM public.roster_work_units WHERE id=p_work_unit_id AND organization_id=p_organization_id AND active FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active work unit is required'; END IF;
  IF v_unit.service_type IS DISTINCT FROM p_module_key THEN RAISE EXCEPTION 'Work unit module does not match requested module'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles u
    JOIN public.service_agreements sa ON sa.id=p_service_agreement_id
    JOIN public.organizations officer_org ON officer_org.id=u.organization_id
    WHERE u.id=p_officer_user_id AND u.deactivated_at IS NULL AND u.role IN ('officer','admin_officer')
      AND (officer_org.id=sa.provider_organization_id OR sa.provider_organization_id=ANY(public.get_descendant_organizations(officer_org.id)))
  ) THEN RAISE EXCEPTION 'Target officer is not authorized for this service agreement'; END IF;
  SELECT * INTO v_job FROM public.create_dispatch_job(p_organization_id,p_service_agreement_id,p_client_site_id,p_client_request_id,p_job_type,p_priority,p_sla_minutes,NULL,p_briefing_notes,NULL);
  UPDATE public.dispatch_jobs AS job
    SET assigned_officer_id=p_officer_user_id, work_unit_id=p_work_unit_id, module_key=p_module_key
    WHERE job.id=v_job.id;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(p_organization_id,v_actor,'dispatch_job_queued_for_officer','dispatch_jobs',v_job.id,jsonb_build_object('officer_user_id',p_officer_user_id,'work_unit_id',p_work_unit_id,'module_key',p_module_key,'roster_independent',true));
  RETURN QUERY SELECT v_job.id,v_job.created,v_job.status,p_officer_user_id,p_work_unit_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_dispatch_job_to_officer(
  p_job_id uuid,
  p_officer_user_id uuid
) RETURNS public.dispatch_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_job public.dispatch_jobs%rowtype;
BEGIN
  SELECT * INTO v_job FROM public.dispatch_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR v_actor IS NULL OR NOT public.is_admin_for_org(v_job.organization_id) THEN RAISE EXCEPTION 'Dispatch job access denied'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_profiles u
    JOIN public.service_agreements sa ON sa.id=v_job.service_agreement_id
    JOIN public.organizations officer_org ON officer_org.id=u.organization_id
    WHERE u.id=p_officer_user_id AND u.deactivated_at IS NULL AND u.role IN ('officer','admin_officer')
      AND (officer_org.id=sa.provider_organization_id OR sa.provider_organization_id=ANY(public.get_descendant_organizations(officer_org.id)))
  ) THEN RAISE EXCEPTION 'Target officer is not authorized for this service agreement'; END IF;
  UPDATE public.dispatch_jobs SET assigned_officer_id=p_officer_user_id WHERE public.dispatch_jobs.id=p_job_id RETURNING * INTO v_job;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_job.organization_id,v_actor,'dispatch_job_assigned_to_officer','dispatch_jobs',v_job.id,jsonb_build_object('officer_user_id',p_officer_user_id,'roster_independent',true));
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.start_ad_hoc_officer_shift(
  p_work_unit_id uuid,
  p_module_key text,
  p_location_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS public.shifts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_profile public.user_profiles%rowtype; v_unit public.roster_work_units%rowtype; v_shift public.shifts%rowtype;
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles WHERE id=v_actor AND deactivated_at IS NULL AND role IN ('officer','admin_officer');
  IF NOT FOUND THEN RAISE EXCEPTION 'Active officer profile required'; END IF;
  SELECT * INTO v_unit FROM public.roster_work_units WHERE id=p_work_unit_id AND organization_id=v_profile.organization_id AND active FOR SHARE;
  IF NOT FOUND OR v_unit.service_type IS DISTINCT FROM p_module_key THEN RAISE EXCEPTION 'Authorized active work unit/module required'; END IF;
  IF EXISTS (SELECT 1 FROM public.shifts WHERE officer_user_id=v_actor AND status='in_progress') THEN RAISE EXCEPTION 'Officer already has an active shift'; END IF;
  INSERT INTO public.shifts (organization_id,officer_user_id,service_type,location_id,zone_id,scheduled_start,scheduled_end,actual_start,status,notes,work_unit_id,module_key,shift_origin)
  VALUES(v_profile.organization_id,v_actor,p_module_key,p_location_id,p_zone_id,clock_timestamp(),clock_timestamp()+interval '12 hours',clock_timestamp(),'in_progress',nullif(trim(p_notes),''),p_work_unit_id,p_module_key,'ad_hoc')
  RETURNING * INTO v_shift;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_profile.organization_id,v_actor,'officer_ad_hoc_shift_started','shifts',v_shift.id,jsonb_build_object('work_unit_id',p_work_unit_id,'module_key',p_module_key));
  RETURN v_shift;
END;
$$;

CREATE OR REPLACE FUNCTION public.stop_officer_shift(p_shift_id uuid, p_notes text DEFAULT NULL)
RETURNS public.shifts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := auth.uid(); v_shift public.shifts%rowtype;
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id AND officer_user_id=v_actor FOR UPDATE;
  IF NOT FOUND OR v_shift.status <> 'in_progress' THEN RAISE EXCEPTION 'Active officer shift not found'; END IF;
  UPDATE public.shifts SET actual_end=clock_timestamp(), scheduled_end=clock_timestamp(), status='completed', notes=coalesce(nullif(trim(p_notes),''),notes), updated_at=clock_timestamp() WHERE public.shifts.id=p_shift_id RETURNING * INTO v_shift;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_shift.organization_id,v_actor,'officer_shift_stopped','shifts',v_shift.id,jsonb_build_object('work_unit_id',v_shift.work_unit_id,'module_key',v_shift.module_key,'actual_start',v_shift.actual_start,'actual_end',v_shift.actual_end));
  RETURN v_shift;
END;
$$;

REVOKE ALL ON FUNCTION public.queue_dispatch_job_for_officer(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.queue_dispatch_job_for_officer(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,integer,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.assign_dispatch_job_to_officer(uuid,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.assign_dispatch_job_to_officer(uuid,uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.start_ad_hoc_officer_shift(uuid,text,uuid,uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.start_ad_hoc_officer_shift(uuid,text,uuid,uuid,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.stop_officer_shift(uuid,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.stop_officer_shift(uuid,text) TO authenticated, service_role;
