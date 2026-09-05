-- CRM portfolio visibility is derived from the operating provider tree and
-- accepted operational agreements. It does not re-own client organizations.
CREATE OR REPLACE FUNCTION public.get_crm_provider_portfolio(
  p_operating_provider_organization_id uuid DEFAULT NULL
)
RETURNS TABLE(
  organization_id uuid,
  organization_name text,
  organization_type text,
  organization_status text,
  operating_provider_organization_id uuid,
  operating_provider_name text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
declare
  v_actor uuid := auth.uid();
  v_home_provider uuid;
  v_selected_provider uuid;
begin
  select profile.organization_id into v_home_provider from public.user_profiles profile where profile.id = v_actor and profile.deactivated_at is null;
  if v_home_provider is null or not public.is_admin_for_org(v_home_provider) then raise exception 'Active CRM administrator required'; end if;
  v_selected_provider := coalesce(p_operating_provider_organization_id, v_home_provider);
  if not public.is_admin_for_org(v_selected_provider) then raise exception 'Operating provider is not within your managed organization tree'; end if;
  if not exists (select 1 from public.organizations provider where provider.id = v_selected_provider and provider.organization_type in ('owner', 'service_provider', 'branch')) then raise exception 'Operating provider must be a provider organization or branch'; end if;

  return query
  with provider_scope as (
    select provider.id, provider.name
    from public.organizations provider
    where provider.id = any(case when v_selected_provider = v_home_provider then public.get_descendant_organizations(v_home_provider) else array[v_selected_provider] end)
      and provider.organization_type in ('service_provider', 'branch')
  ), portfolio as (
    select child.id as organization_id, child.name as organization_name, child.organization_type, child.status as organization_status, provider.id as operating_provider_organization_id, provider.name as operating_provider_name
    from provider_scope provider
    join public.organizations child on child.parent_organization_id = provider.id
    where child.organization_type in ('client', 'government', 'private_enterprise', 'contractor')
    union
    select client.id, client.name, client.organization_type, client.status, provider.id, provider.name
    from provider_scope provider
    join public.service_agreements agreement on agreement.provider_organization_id = provider.id and agreement.agreement_type = 'operational'
    join public.organizations client on client.id = agreement.client_organization_id
  )
  select distinct on (portfolio.organization_id, portfolio.operating_provider_organization_id)
    portfolio.organization_id, portfolio.organization_name, portfolio.organization_type, portfolio.organization_status, portfolio.operating_provider_organization_id, portfolio.operating_provider_name
  from portfolio
  order by portfolio.organization_id, portfolio.operating_provider_organization_id, portfolio.organization_name;
end;
$$;

REVOKE ALL ON FUNCTION public.get_crm_provider_portfolio(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_crm_provider_portfolio(uuid) TO authenticated, service_role;