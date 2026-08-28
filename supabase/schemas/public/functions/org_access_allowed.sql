create or replace function public.org_access_allowed (
  target_org_id uuid
)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select
    -- [EXISTING CLAUSE 1] Grand masters can access all organisations.
    is_grand_master()
    or exists (
      select 1
      from user_profiles p
      where p.id = auth.uid()
        and (
          p.organization_id = target_org_id
          or target_org_id = any(p.authorized_organization_ids)
        )
    )
    -- [EXISTING CLAUSE 3] Master/admin: any org within their OWNERSHIP TREE
    -- (anchor = organization_id or employer_organization_id). Mirrors
    -- is_master_for_org / 0093 policies so a provider master can SEE
    -- clients/sites hanging under their branches.
    or exists (
      select 1
      from user_profiles p
      where p.id = auth.uid()
        and p.role in ('grand_master', 'master', 'admin')
        and (
          target_org_id = any(get_descendant_organizations(p.organization_id))
          or (
            p.employer_organization_id is not null
            and target_org_id = any(get_descendant_organizations(p.employer_organization_id))
          )
        )
    )
    -- [EXISTING CLAUSE 4] Provider/client access grants extend visibility
    -- across org boundaries.
    or exists (
      select 1
      from provider_client_access_grants g
      join user_profiles p on p.id = auth.uid()
      where (
        p.organization_id = g.provider_organization_id
        or p.organization_id = g.client_organization_id
      )
        and (g.ends_at is null or g.ends_at > now())
        and (
          g.provider_organization_id = target_org_id
          or g.client_organization_id = target_org_id
        )
    )
    -- [NEW CLAUSE 5 — 0271] Agreement-based visibility (Model A).
    -- An own-rooted org linked only by a service_agreement is visible
    -- to users whose org (organization_id or employer_organization_id)
    -- is the other party on an active agreement. Bidirectional: provider
    -- sees client AND client sees provider.
    or exists (
      select 1
      from service_agreements sa
      join user_profiles p on p.id = auth.uid()
      where (sa.ends_on is null or sa.ends_on >= current_date)
        and (
          -- User's org is the PROVIDER, target is the CLIENT
          (sa.client_organization_id = target_org_id
           and (p.organization_id = sa.provider_organization_id
                or p.employer_organization_id = sa.provider_organization_id))
          or
          -- User's org is the CLIENT, target is the PROVIDER
          (sa.provider_organization_id = target_org_id
           and (p.organization_id = sa.client_organization_id
                or p.employer_organization_id = sa.client_organization_id))
        )
    );
$function$;

grant execute on function "public"."org_access_allowed"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."org_access_allowed"(uuid) is 'Returns true if the current user can access the target organisation. Respects grand_master, direct membership, authorized_organization_ids, master/admin ownership-tree descent (0132), provider/client access grants, and agreement-based visibility for own-rooted orgs (0271 Model A).';
