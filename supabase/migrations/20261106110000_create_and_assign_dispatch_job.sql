-- One governed path for "create this job and send it to that officer".
-- Used by the dispatch console, the website-enquiry Convert flow and Bob's
-- dispatch_job tool. It composes the two existing governed RPCs so every
-- place, agreement, officer and audit rule stays in one place.

ALTER TABLE public.website_enquiries
  ADD COLUMN IF NOT EXISTS dispatch_job_id uuid REFERENCES public.dispatch_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS website_enquiries_dispatch_job_id_idx
  ON public.website_enquiries (dispatch_job_id)
  WHERE dispatch_job_id IS NOT NULL;

COMMENT ON COLUMN public.website_enquiries.dispatch_job_id IS
  'Dispatch job created from this enquiry by create_and_assign_dispatch_job. NULL when the enquiry has not produced field work.';

CREATE OR REPLACE FUNCTION public.create_and_assign_dispatch_job(
  p_service_agreement_id uuid,
  p_client_site_id uuid,
  p_zone_id uuid,
  p_job_type text,
  p_priority text,
  p_sla_minutes integer,
  p_briefing_notes text DEFAULT NULL,
  p_officer_user_id uuid DEFAULT NULL,
  p_client_request_id uuid DEFAULT NULL,
  p_website_enquiry_id uuid DEFAULT NULL,
  p_source text DEFAULT 'dispatch_console'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
  v_enquiry public.website_enquiries%rowtype;
  v_job_type text := lower(btrim(coalesce(p_job_type, '')));
  v_priority text := lower(btrim(coalesce(p_priority, 'normal')));
  v_source text := lower(btrim(coalesce(p_source, 'dispatch_console')));
  v_request_id uuid;
  v_job_id uuid;
  v_created boolean;
  v_status text;
  v_respond_by timestamptz;
  v_job public.dispatch_jobs%rowtype;
  v_enquiry_linked boolean := false;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to create dispatch jobs' USING ERRCODE = '42501';
  END IF;
  IF v_job_type !~ '^[a-z][a-z0-9_]{1,40}$' THEN
    RAISE EXCEPTION 'Choose a job type' USING ERRCODE = '22023';
  END IF;
  IF v_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'Priority must be low, normal, high or urgent' USING ERRCODE = '22023';
  END IF;
  IF v_source NOT IN ('dispatch_console', 'website_enquiry', 'bob') THEN
    RAISE EXCEPTION 'Unknown dispatch source' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_agreement FROM public.service_agreements WHERE id = p_service_agreement_id;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN
    RAISE EXCEPTION 'Service agreement not found, or you cannot dispatch for it' USING ERRCODE = '42501';
  END IF;

  IF p_website_enquiry_id IS NOT NULL THEN
    SELECT * INTO v_enquiry FROM public.website_enquiries WHERE id = p_website_enquiry_id FOR UPDATE;
    IF NOT FOUND OR v_enquiry.provider_organization_id <> v_agreement.provider_organization_id THEN
      RAISE EXCEPTION 'Website enquiry not found for this provider' USING ERRCODE = '42501';
    END IF;
    IF v_enquiry.status IN ('closed', 'spam') THEN
      RAISE EXCEPTION 'Reopen this enquiry before creating a job from it' USING ERRCODE = '22023';
    END IF;
    IF v_enquiry.dispatch_job_id IS NOT NULL THEN
      SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = v_enquiry.dispatch_job_id;
      RETURN jsonb_build_object(
        'job_id', v_job.id, 'created', false, 'status', v_job.status,
        'sla_respond_by', v_job.sla_respond_by, 'assigned_officer_id', v_job.assigned_officer_id,
        'website_enquiry_id', v_enquiry.id, 'enquiry_linked', true
      );
    END IF;
  END IF;

  -- An enquiry yields at most one job; otherwise honour the caller's idempotency key.
  v_request_id := coalesce(p_client_request_id, p_website_enquiry_id, gen_random_uuid());

  SELECT created_job.id, created_job.created, created_job.status, created_job.sla_respond_by
    INTO v_job_id, v_created, v_status, v_respond_by
    FROM public.create_dispatch_job_for_place(
      v_agreement.provider_organization_id, v_agreement.id, p_client_site_id, p_zone_id,
      v_request_id, v_job_type, v_priority, p_sla_minutes, NULL, p_briefing_notes, NULL
    ) AS created_job;

  IF p_officer_user_id IS NOT NULL THEN
    SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = v_job_id;
    IF v_job.assigned_officer_id IS DISTINCT FROM p_officer_user_id THEN
      PERFORM public.assign_dispatch_job_to_officer(v_job_id, p_officer_user_id);
    END IF;
  END IF;

  IF p_website_enquiry_id IS NOT NULL THEN
    UPDATE public.website_enquiries e
       SET dispatch_job_id = v_job_id,
           status = 'converted',
           status_note = CASE WHEN e.status = 'converted' THEN e.status_note
                              ELSE 'Dispatch job created from this enquiry' END,
           handled_by = CASE WHEN e.status = 'converted' THEN e.handled_by ELSE v_uid END,
           handled_at = CASE WHEN e.status = 'converted' THEN e.handled_at ELSE clock_timestamp() END,
           version = e.version + 1,
           updated_at = clock_timestamp()
     WHERE e.id = p_website_enquiry_id;
    v_enquiry_linked := true;
  END IF;

  SELECT * INTO v_job FROM public.dispatch_jobs WHERE id = v_job_id;

  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_agreement.provider_organization_id, v_uid, 'dispatch_job_created_and_assigned', 'dispatch_jobs', v_job_id,
    jsonb_strip_nulls(jsonb_build_object(
      'source', v_source,
      'created', v_created,
      'service_agreement_id', v_agreement.id,
      'client_site_id', p_client_site_id,
      'zone_id', p_zone_id,
      'job_type', v_job_type,
      'priority', v_priority,
      'assigned_officer_id', v_job.assigned_officer_id,
      'website_enquiry_id', p_website_enquiry_id,
      'website_enquiry_reference', v_enquiry.reference
    )));

  RETURN jsonb_build_object(
    'job_id', v_job_id,
    'created', v_created,
    'status', v_job.status,
    'sla_respond_by', v_job.sla_respond_by,
    'assigned_officer_id', v_job.assigned_officer_id,
    'website_enquiry_id', p_website_enquiry_id,
    'enquiry_linked', v_enquiry_linked
  );
END;
$function$;

COMMENT ON FUNCTION public.create_and_assign_dispatch_job(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, uuid, text) IS
  'Creates a dispatch job at one agreement Site or Zone (create_dispatch_job_for_place), optionally queues it to an officer (assign_dispatch_job_to_officer) and links/converts a website enquiry. Provider admin only; idempotent per enquiry or client_request_id; writes audit_log dispatch_job_created_and_assigned.';

REVOKE ALL ON FUNCTION public.create_and_assign_dispatch_job(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_and_assign_dispatch_job(uuid, uuid, uuid, text, text, integer, text, uuid, uuid, uuid, text) TO authenticated, service_role;

-- ENQ-024654 (Gibbons / Burger N Beast Richmond) was dispatched by hand
-- before this link existed; record the link so the enquiry shows its job.
UPDATE public.website_enquiries e
   SET dispatch_job_id = j.id,
       version = e.version + 1,
       updated_at = clock_timestamp()
  FROM public.dispatch_jobs j
 WHERE e.reference = 'ENQ-024654'
   AND e.dispatch_job_id IS NULL
   AND j.id = 'faa172a3-db67-4395-a4c8-64f899501d65'
   AND j.organization_id = e.provider_organization_id;

-- Report parity: every R&M operational client agreement uses the same
-- accountability pack as OneFortyOne (photos with records, card reviews as
-- observations, routine work withheld). Only fills agreements with no template.
UPDATE public.service_agreements sa
   SET monthly_report_template_code = 'rm_monthly_accountability_v1'
 WHERE sa.provider_organization_id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'
   AND sa.agreement_type = 'operational'
   AND sa.monthly_report_template_code IS NULL
   AND sa.id IN (
     'b960015d-5510-4a43-8f43-04ab826463f5',
     '4bd8d8cd-acd9-42b1-8976-04a0bc75f6fa',
     'e9f43463-cbaa-4c53-a9b3-dad6ae0567e5',
     'c506e8b0-b59d-46c8-9fda-d844aef77b3f',
     '474958ad-f41b-4652-8a0d-c9ece3566612',
     'da9f9150-d1fb-47e6-b66c-b6a33d0f7ac4',
     'e53834ad-0a20-4d84-ba31-c7dbbb611939',
     '5da711eb-fc09-4cc5-ae08-450c0bbe6d0e'
   )
   AND EXISTS (
     SELECT 1 FROM public.report_templates rt
      WHERE rt.organization_id = sa.provider_organization_id
        AND rt.template_code = 'rm_monthly_accountability_v1'
   );
