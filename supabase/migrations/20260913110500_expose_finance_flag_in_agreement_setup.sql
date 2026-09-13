-- get_crm_agreement_setup did not expose client_portal_finance_enabled, so the
-- frontend setup dialog had no way to read the current value before
-- manage_crm_agreement_finance was introduced. Re-create with the field added
-- to the returned 'agreement' object; body is otherwise unchanged from
-- 20260906009900_govern_agreement_reporting.sql.
CREATE OR REPLACE FUNCTION public.get_crm_agreement_setup(p_agreement_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_agreement public.service_agreements%rowtype;
BEGIN
  SELECT sa.* INTO v_agreement FROM public.service_agreements sa WHERE sa.id=p_agreement_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service agreement not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_agreement.provider_organization_id) THEN RAISE EXCEPTION 'Provider administrator required'; END IF;

  RETURN jsonb_build_object(
    'agreement', jsonb_build_object(
      'id', v_agreement.id,
      'name', v_agreement.name,
      'client_organization_id', v_agreement.client_organization_id,
      'invitation_status', v_agreement.invitation_status,
      'enabled_modules', v_agreement.enabled_modules,
      'client_portal_reports_enabled', v_agreement.client_portal_reports_enabled,
      'monthly_report_template_code', v_agreement.monthly_report_template_code,
      'client_portal_finance_enabled', v_agreement.client_portal_finance_enabled
    ),
    'sites', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'address',s.address,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'linked',sal.id IS NOT NULL,'link_status',sal.status) ORDER BY s.name),'[]'::jsonb) FROM public.client_sites s LEFT JOIN public.service_agreement_locations sal ON sal.service_agreement_id=v_agreement.id AND sal.site_id=s.id WHERE s.client_organization_id=v_agreement.client_organization_id AND s.active),
    'zones', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'address',NULL,'boundary_status',z.boundary_status,'boundary_verification',z.boundary_verification,'linked',sal.id IS NOT NULL,'link_status',sal.status) ORDER BY z.name),'[]'::jsonb) FROM public.location_zones z LEFT JOIN public.service_agreement_locations sal ON sal.service_agreement_id=v_agreement.id AND sal.zone_id=z.id WHERE z.organization_id=v_agreement.client_organization_id AND z.is_active),
    'modules', (SELECT coalesce(jsonb_agg(jsonb_build_object('module_key',mc.module_key,'enabled',coalesce(sam.enabled,false),'sla_minutes',sam.sla_minutes,'allows_client_submission',coalesce(sam.allows_client_submission,false),'allows_auto_dispatch',coalesce(sam.allows_auto_dispatch,false)) ORDER BY mc.module_key),'[]'::jsonb) FROM public.module_catalog mc LEFT JOIN public.service_agreement_modules sam ON sam.service_agreement_id=v_agreement.id AND sam.module_key=mc.module_key WHERE mc.active),
    'report_templates', (SELECT coalesce(jsonb_agg(jsonb_build_object('template_code',rt.template_code,'name',rt.name,'module_key',rt.module_key) ORDER BY rt.name),'[]'::jsonb) FROM public.report_templates rt WHERE rt.organization_id=v_agreement.provider_organization_id)
  );
END;
$$;
