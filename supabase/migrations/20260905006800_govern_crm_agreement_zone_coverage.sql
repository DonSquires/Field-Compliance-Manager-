CREATE OR REPLACE FUNCTION public.get_crm_agreement_setup(p_agreement_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;
BEGIN
  SELECT sa.* INTO v_agreement FROM public.service_agreements sa WHERE sa.id=p_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found';END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Provider administrator required';END IF;
  RETURN jsonb_build_object(
    'agreement',jsonb_build_object('id',v_agreement.id,'name',v_agreement.name,'client_organization_id',v_agreement.client_organization_id,'invitation_status',v_agreement.invitation_status,'enabled_modules',v_agreement.enabled_modules),
    'sites',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'address',s.address,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'linked',sal.id IS NOT NULL,'link_status',sal.status) ORDER BY s.name),'[]'::jsonb) FROM public.client_sites s LEFT JOIN public.service_agreement_locations sal ON sal.service_agreement_id=v_agreement.id AND sal.site_id=s.id WHERE s.client_organization_id=v_agreement.client_organization_id AND s.active),
    'zones',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'address',z.address,'boundary_status',z.boundary_status,'boundary_verification',z.boundary_verification,'linked',sal.id IS NOT NULL,'link_status',sal.status) ORDER BY z.name),'[]'::jsonb) FROM public.location_zones z LEFT JOIN public.service_agreement_locations sal ON sal.service_agreement_id=v_agreement.id AND sal.zone_id=z.id WHERE z.organization_id=v_agreement.client_organization_id AND z.is_active),
    'modules',(SELECT coalesce(jsonb_agg(jsonb_build_object('module_key',mc.module_key,'enabled',coalesce(sam.enabled,false),'sla_minutes',sam.sla_minutes,'allows_client_submission',coalesce(sam.allows_client_submission,false),'allows_auto_dispatch',coalesce(sam.allows_auto_dispatch,false)) ORDER BY mc.module_key),'[]'::jsonb) FROM public.module_catalog mc LEFT JOIN public.service_agreement_modules sam ON sam.service_agreement_id=v_agreement.id AND sam.module_key=mc.module_key WHERE mc.active)
  );
END;$$;

CREATE OR REPLACE FUNCTION public.manage_crm_agreement_zone_coverage(p_agreement_id uuid,p_expected_invitation_status text,p_action text,p_zone_id uuid)
RETURNS public.service_agreement_locations LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE v_actor uuid:=auth.uid();v_agreement public.service_agreements%rowtype;v_link public.service_agreement_locations%rowtype;
BEGIN
  SELECT sa.* INTO v_agreement FROM public.service_agreements sa WHERE sa.id=p_agreement_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found';END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Provider administrator required';END IF;
  IF v_agreement.agreement_type<>'operational' OR v_agreement.invitation_status<>'accepted' THEN RAISE EXCEPTION 'Only accepted operational agreements can be configured';END IF;
  IF v_agreement.invitation_status IS DISTINCT FROM p_expected_invitation_status THEN RAISE EXCEPTION 'Service agreement changed since it was opened';END IF;
  IF p_action NOT IN ('link_zone','unlink_zone') THEN RAISE EXCEPTION 'Unsupported agreement zone coverage action';END IF;
  IF p_zone_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.location_zones z WHERE z.id=p_zone_id AND z.organization_id=v_agreement.client_organization_id AND z.is_active) THEN RAISE EXCEPTION 'Active client zone required';END IF;
  IF p_action='link_zone' THEN
    INSERT INTO public.service_agreement_locations(service_agreement_id,zone_id,status,created_by) VALUES(v_agreement.id,p_zone_id,'active',v_actor)
    ON CONFLICT(service_agreement_id,zone_id) DO UPDATE SET status='active',updated_at=clock_timestamp() RETURNING * INTO v_link;
  ELSE
    UPDATE public.service_agreement_locations SET status='ended',updated_at=clock_timestamp() WHERE service_agreement_id=v_agreement.id AND zone_id=p_zone_id RETURNING * INTO v_link;
    IF NOT FOUND THEN RAISE EXCEPTION 'Covered zone link not found';END IF;
  END IF;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) VALUES(v_agreement.provider_organization_id,v_actor,'crm_agreement_'||p_action,'service_agreement_locations',v_link.id,jsonb_build_object('agreement_id',v_agreement.id,'zone_id',p_zone_id,'status',v_link.status));
  RETURN v_link;
END;$$;

REVOKE ALL ON FUNCTION public.manage_crm_agreement_zone_coverage(uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_agreement_setup(uuid),public.manage_crm_agreement_zone_coverage(uuid,text,text,uuid) TO authenticated,service_role;