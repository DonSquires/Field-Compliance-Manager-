CREATE OR REPLACE FUNCTION public.crm_actor_can_manage_account(p_account_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  select exists(
    select 1
    from public.user_profiles actor
    join public.organizations account on account.id=p_account_organization_id
    where actor.id=auth.uid()
      and actor.deactivated_at is null
      and (
        account.id=actor.organization_id
        or account.parent_organization_id=actor.organization_id
        or exists(
          select 1
          from public.service_agreements agreement
          where agreement.provider_organization_id = any(public.get_descendant_organizations(coalesce(actor.employer_organization_id,actor.organization_id)))
            and agreement.client_organization_id=account.id
            and agreement.agreement_type='operational'
            and agreement.invitation_status='accepted'
            and public.is_admin_for_org(agreement.provider_organization_id)
        )
      )
  );
$$;

REVOKE ALL ON FUNCTION public.crm_actor_can_manage_account(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.crm_actor_can_manage_account(uuid) TO authenticated,service_role;