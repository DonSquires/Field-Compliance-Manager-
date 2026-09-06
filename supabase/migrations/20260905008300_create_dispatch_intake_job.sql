CREATE OR REPLACE FUNCTION public.create_dispatch_intake_job(
  p_organization_id uuid, p_service_agreement_id uuid, p_client_request_id uuid,
  p_job_type text, p_priority text, p_sla_minutes integer, p_location_name text,
  p_location_address text, p_location_lat double precision, p_location_lng double precision,
  p_dispatch_resource_id uuid DEFAULT NULL, p_briefing_notes text DEFAULT NULL, p_shift_id uuid DEFAULT NULL
) RETURNS TABLE(id uuid, client_site_id uuid, created boolean, status text, sla_respond_by timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_site public.client_sites%rowtype;
  v_job record;
  v_address_key text := regexp_replace(lower(trim(coalesce(p_location_address, ''))), '[^a-z0-9]+', '', 'g');
  v_client_org_id uuid;
BEGIN
  IF NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Not authorised to create dispatch jobs for this organisation'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF nullif(trim(coalesce(p_location_name, '')), '') IS NULL OR nullif(trim(coalesce(p_location_address, '')), '') IS NULL THEN RAISE EXCEPTION 'Incident location name and address are required'; END IF;
  IF p_location_lat NOT BETWEEN -90 AND 90 OR p_location_lng NOT BETWEEN -180 AND 180 THEN RAISE EXCEPTION 'Resolve the incident address before dispatching'; END IF;

  SELECT agreement.client_organization_id INTO v_client_org_id FROM public.service_agreements AS agreement
  WHERE agreement.id = p_service_agreement_id AND agreement.provider_organization_id = p_organization_id;
  IF v_client_org_id IS NULL THEN RAISE EXCEPTION 'Service agreement is not available to this provider'; END IF;

  SELECT site.* INTO v_site FROM public.client_sites AS site
  WHERE site.client_organization_id = v_client_org_id AND site.address_match_key = v_address_key FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.client_sites(client_organization_id, organization_id, name, address, address_match_key, site_type, active, site_origin, boundary_status, boundary_verification, center_point)
    VALUES(v_client_org_id, p_organization_id, trim(p_location_name), trim(p_location_address), v_address_key, 'other', true, 'adhoc', 'provisional', 'unverified', ST_SetSRID(ST_MakePoint(p_location_lng, p_location_lat), 4326))
    RETURNING * INTO v_site;
  END IF;

  INSERT INTO public.service_agreement_locations(service_agreement_id, site_id, status, created_by)
  VALUES(p_service_agreement_id, v_site.id, 'active', auth.uid()) ON CONFLICT (service_agreement_id, site_id) DO NOTHING;

  SELECT * INTO v_job FROM public.create_dispatch_job(p_organization_id, p_service_agreement_id, v_site.id, p_client_request_id, p_job_type, p_priority, p_sla_minutes, p_dispatch_resource_id, p_briefing_notes, p_shift_id);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(p_organization_id, auth.uid(), 'dispatch_intake_location_created', 'client_sites', v_site.id, jsonb_build_object('service_agreement_id', p_service_agreement_id, 'dispatch_job_id', v_job.id, 'boundary_status', v_site.boundary_status));
  RETURN QUERY SELECT v_job.id, v_site.id, v_job.created, v_job.status, v_job.sla_respond_by;
END; $$;

REVOKE ALL ON FUNCTION public.create_dispatch_intake_job(uuid,uuid,uuid,text,text,integer,text,text,double precision,double precision,uuid,text,uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.create_dispatch_intake_job(uuid,uuid,uuid,text,text,integer,text,text,double precision,double precision,uuid,text,uuid) TO authenticated, service_role;