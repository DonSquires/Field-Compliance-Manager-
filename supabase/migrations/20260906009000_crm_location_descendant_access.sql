CREATE OR REPLACE FUNCTION public.crm_actor_can_manage_location(p_location_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  select exists(
    select 1 from public.locations l join public.user_profiles u on u.id=auth.uid() and u.deactivated_at is null
    where l.id=p_location_id and public.is_admin_for_org(u.organization_id) and (
      l.organization_id=u.organization_id
      or l.organization_id = any(public.get_descendant_organizations(coalesce(u.employer_organization_id,u.organization_id)))
      or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        left join public.client_sites s on s.id=sal.site_id left join public.location_zones z on z.id=sal.zone_id
        where sa.provider_organization_id=u.organization_id and sa.invitation_status='accepted' and sa.agreement_type='operational' and (s.location_id=l.id or z.location_id=l.id)
      )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.crm_actor_can_manage_location(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_actor_can_manage_location(uuid) TO service_role;
