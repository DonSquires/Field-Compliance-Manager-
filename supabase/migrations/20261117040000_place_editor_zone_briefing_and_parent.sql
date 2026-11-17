-- 20261117000100 (zone briefing) and 20261117010000 (reporting parent) each replace the place editor with only their own
-- addition. Live applied 010000 first and the branch runs 000100 first, so either order drops one set of fields. This
-- definition carries both and sorts after each. Body otherwise as 010000.
CREATE OR REPLACE FUNCTION public.get_crm_operational_place_editor(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_provider uuid;v_location public.locations%rowtype;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_location(p_location_id) then raise exception 'Active CRM administrator required for this location';end if;
  select * into v_location from public.locations l where l.id=p_location_id;if not found then raise exception 'Location not found';end if;
  return jsonb_build_object(
    'location',jsonb_build_object('id',v_location.id,'name',v_location.name,'organization_id',v_location.organization_id),
    'sites',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'risk_level',s.risk_level,'site_brief',s.site_brief,'access_instructions',s.access_instructions,'hs_notes',s.hs_notes,'active',s.active,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'configuration_version',s.configuration_version) order by s.name),'[]'::jsonb) from public.client_sites s where s.location_id=v_location.id),
    'zones',(select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'zone_type',z.zone_type,'module_key',z.module_key,'rule_type',z.rule_type,'is_active',z.is_active,'nightly_limit_consecutive',z.nightly_limit_consecutive,'nightly_limit_monthly',z.nightly_limit_monthly,'scv_required',z.scv_required,'enforcement_workflow_override',z.enforcement_workflow_override,'parent_zone_id',z.parent_zone_id,'boundary_status',z.boundary_status,'boundary_verification',z.boundary_verification,'configuration_version',z.configuration_version,'risk_level',z.risk_level,'site_brief',z.site_brief,'access_instructions',z.access_instructions,'hs_notes',z.hs_notes) order by z.name),'[]'::jsonb) from public.location_zones z where z.location_id=v_location.id AND NOT z.is_verification_point),
    'modules',(select coalesce(jsonb_agg(jsonb_build_object('module_key',m.module_key,'display_name',initcap(replace(m.module_key,'_',' '))) order by m.module_key),'[]'::jsonb) from public.module_catalog m where m.active),
    'closures',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'zone_id',c.zone_id,'closure_type',c.closure_type,'status',c.status,'effective_from',c.effective_from,'effective_to',c.effective_to,'reason',c.reason,'resolution_notes',c.resolution_notes) order by c.created_at desc),'[]'::jsonb) from public.zone_closures c join public.location_zones z on z.id=c.zone_id where z.location_id=v_location.id AND NOT z.is_verification_point)
  );
end;
$function$;

REVOKE ALL ON FUNCTION public.get_crm_operational_place_editor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crm_operational_place_editor(uuid) TO authenticated, service_role;
