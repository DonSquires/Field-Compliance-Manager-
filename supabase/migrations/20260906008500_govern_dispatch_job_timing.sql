ALTER TABLE public.dispatch_jobs
  ADD COLUMN IF NOT EXISTS expected_dwell_minutes integer NOT NULL DEFAULT 5 CHECK (expected_dwell_minutes BETWEEN 1 AND 240),
  ADD COLUMN IF NOT EXISTS timing_source text NOT NULL DEFAULT 'dispatch_default' CHECK (timing_source IN ('dispatch_default', 'site_service', 'patrol_schedule', 'bob_pattern', 'dispatcher_override'));

CREATE OR REPLACE FUNCTION public.manage_dispatch_job_timing(
  p_job_id uuid, p_expected_status text, p_sla_minutes integer, p_expected_dwell_minutes integer,
  p_timing_source text DEFAULT 'dispatcher_override', p_reason text DEFAULT NULL
) RETURNS TABLE(id uuid, status text, sla_minutes integer, sla_respond_by timestamptz, expected_dwell_minutes integer, timing_source text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.dispatch_jobs%rowtype;
BEGIN
  SELECT job.* INTO v_job FROM public.dispatch_jobs AS job WHERE job.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_job.organization_id) THEN RAISE EXCEPTION 'Dispatch job not found or access denied'; END IF;
  IF v_job.status <> p_expected_status OR v_job.status IN ('completed', 'cancelled') THEN RAISE EXCEPTION 'Dispatch job timing can only change for its current active status'; END IF;
  IF p_sla_minutes NOT BETWEEN 1 AND 1440 OR p_expected_dwell_minutes NOT BETWEEN 1 AND 240 THEN RAISE EXCEPTION 'SLA and dwell time are outside allowed ranges'; END IF;
  IF p_timing_source NOT IN ('site_service', 'patrol_schedule', 'bob_pattern', 'dispatcher_override') THEN RAISE EXCEPTION 'Unsupported timing source'; END IF;
  UPDATE public.dispatch_jobs AS job SET sla_minutes = p_sla_minutes, sla_respond_by = job.created_at + make_interval(mins => p_sla_minutes), expected_dwell_minutes = p_expected_dwell_minutes, timing_source = p_timing_source
  WHERE job.id = v_job.id RETURNING job.* INTO v_job;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(v_job.organization_id, auth.uid(), 'dispatch_job_timing_updated', 'dispatch_jobs', v_job.id, jsonb_build_object('sla_minutes', v_job.sla_minutes, 'expected_dwell_minutes', v_job.expected_dwell_minutes, 'timing_source', v_job.timing_source, 'reason', nullif(trim(coalesce(p_reason, '')), '')));
  RETURN QUERY SELECT v_job.id, v_job.status, v_job.sla_minutes, v_job.sla_respond_by, v_job.expected_dwell_minutes, v_job.timing_source;
END; $$;

REVOKE ALL ON FUNCTION public.manage_dispatch_job_timing(uuid,text,integer,integer,text,text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.manage_dispatch_job_timing(uuid,text,integer,integer,text,text) TO authenticated, service_role;