CREATE OR REPLACE FUNCTION public.grant_branch_area_access(p_operating_organization_id uuid,p_user_id uuid,p_area text,p_level text,p_reason text)
RETURNS public.staff_area_grants
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();v_grant public.staff_area_grants%rowtype;v_reason text:=nullif(trim(coalesce(p_reason,'')), '');
begin
  if v_reason is null then raise exception 'A change reason is required';end if;
  if p_area not in('timesheet_local_review','leave_branch_approve','roster_impact_approve','credentials_supervise','hr_case_local_investigate','incident_manage_local') then raise exception 'Unsupported branch authority area';end if;
  if p_level not in('view','verify','approve','adjust','manage') then raise exception 'Unsupported access level';end if;
  if p_user_id=v_actor then raise exception 'You cannot grant yourself branch authority';end if;
  if not public.user_can_operate_organization(p_operating_organization_id) or not public.staff_branch_authorisation_manager_can_manage(v_actor,p_operating_organization_id,p_user_id) then raise exception 'Not authorised to grant branch authority';end if;
  if not exists(select 1 from public.staff_branch_authorisations assignment where assignment.user_id=p_user_id and assignment.branch_org_id=p_operating_organization_id and assignment.status='active') then raise exception 'Active staff branch authorization required';end if;
  select * into v_grant from public.staff_area_grants where user_id=p_user_id and scope_org_id=p_operating_organization_id and area=p_area and status='active' for update;
  if found then raise exception 'An active grant already exists for this area';end if;
  insert into public.staff_area_grants(user_id,scope_org_id,area,level,status,source_preset,granted_by) values(p_user_id,p_operating_organization_id,p_area,p_level,'active',null,v_actor) returning * into v_grant;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)values(p_operating_organization_id,v_actor,'branch_area_grant_created','staff_area_grants',v_grant.id,jsonb_build_object('user_id',p_user_id,'area',p_area,'level',p_level,'reason',v_reason));
  return v_grant;
end;$$;
REVOKE ALL ON FUNCTION public.grant_branch_area_access(uuid,uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.grant_branch_area_access(uuid,uuid,text,text,text) TO authenticated,service_role;