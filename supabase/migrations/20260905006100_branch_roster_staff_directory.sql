CREATE OR REPLACE FUNCTION public.get_operating_branch_roster_staff(p_operating_organization_id uuid)
RETURNS TABLE(user_id uuid,staff_id uuid,display_name text,email text,employment_type text,work_ready boolean,credential_expiry date,credential_verified boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not public.user_can_operate_organization(p_operating_organization_id) then raise exception 'Active authorized operating branch required';end if;
  if not exists(select 1 from public.staff_branch_authorisations manager_assignment where manager_assignment.user_id=v_actor and manager_assignment.branch_org_id=p_operating_organization_id and manager_assignment.status='active' and manager_assignment.role_at_branch='branch_manager') and not exists(select 1 from public.resolve_access_grants(v_actor,p_operating_organization_id) authority_grant where authority_grant.area='roster_impact_approve' and authority_grant.level in('approve','adjust','manage')) then raise exception 'Branch roster authority required';end if;
  return query select user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready,min(credential.expiry_date),bool_and(credential.verified)
  from public.staff_branch_authorisations assignment join public.user_profiles user_profile on user_profile.id=assignment.user_id and user_profile.deactivated_at is null join public.staff_profiles staff on staff.id=coalesce(user_profile.id,staff.user_id) or staff.user_id=user_profile.id left join public.staff_credentials credential on credential.staff_id=staff.id
  where assignment.branch_org_id=p_operating_organization_id and assignment.status='active' and assignment.can_be_rostered and (assignment.ends_on is null or assignment.ends_on>=current_date) and (assignment.starts_on is null or assignment.starts_on<=current_date)
  group by user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready order by user_profile.display_name nulls last,user_profile.email;
end;$$;
REVOKE ALL ON FUNCTION public.get_operating_branch_roster_staff(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_operating_branch_roster_staff(uuid) TO authenticated,service_role;