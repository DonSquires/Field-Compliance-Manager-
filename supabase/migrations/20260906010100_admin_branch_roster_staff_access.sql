CREATE OR REPLACE FUNCTION public.get_operating_branch_roster_staff(p_operating_organization_id uuid)
RETURNS TABLE(user_id uuid, staff_id uuid, display_name text, email text, employment_type text, work_ready boolean, credential_expiry date, credential_verified boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT public.user_can_operate_organization(p_operating_organization_id) THEN
    RAISE EXCEPTION 'Active authorized operating branch required';
  END IF;
  IF NOT public.is_admin_for_org(p_operating_organization_id)
     AND NOT EXISTS(
       SELECT 1 FROM public.staff_branch_authorisations manager_assignment
       WHERE manager_assignment.user_id = v_actor
         AND manager_assignment.branch_org_id = p_operating_organization_id
         AND manager_assignment.status = 'active'
         AND manager_assignment.role_at_branch = 'branch_manager'
     )
     AND NOT EXISTS(
       SELECT 1 FROM public.resolve_access_grants(v_actor,p_operating_organization_id) authority_grant
       WHERE authority_grant.area = 'roster_impact_approve'
         AND authority_grant.level IN ('approve','adjust','manage')
     ) THEN
    RAISE EXCEPTION 'Branch roster authority required';
  END IF;

  RETURN QUERY
  SELECT user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready,min(credential.expiry_date),bool_and(credential.verified)
  FROM public.staff_branch_authorisations assignment
  JOIN public.user_profiles user_profile ON user_profile.id=assignment.user_id AND user_profile.deactivated_at IS NULL
  JOIN public.staff_profiles staff ON staff.id=coalesce(user_profile.id,staff.user_id) OR staff.user_id=user_profile.id
  LEFT JOIN public.staff_credentials credential ON credential.staff_id=staff.id
  WHERE assignment.branch_org_id=p_operating_organization_id
    AND assignment.status='active'
    AND assignment.can_be_rostered
    AND (assignment.ends_on IS NULL OR assignment.ends_on>=current_date)
    AND (assignment.starts_on IS NULL OR assignment.starts_on<=current_date)
  GROUP BY user_profile.id,staff.id,user_profile.display_name,user_profile.email,staff.employment_type,staff.work_ready
  ORDER BY user_profile.display_name NULLS LAST,user_profile.email;
END;
$$;

REVOKE ALL ON FUNCTION public.get_operating_branch_roster_staff(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_operating_branch_roster_staff(uuid) TO authenticated,service_role;
