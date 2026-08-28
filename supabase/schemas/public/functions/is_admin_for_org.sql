create or replace function public.is_admin_for_org (
  target_org_id uuid
)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select exists (
    select 1 from user_profiles
    where id = auth.uid()
      and role in ('grand_master', 'master', 'admin')
      and (
        -- [EXISTING] grand_master: unrestricted
        role = 'grand_master'
        -- [EXISTING] master: check descendant tree (employer or org)
        or (role = 'master' and (
          target_org_id = any (public.get_descendant_organizations(employer_organization_id))
          or target_org_id = any (public.get_descendant_organizations(organization_id))
          -- [NEW — 0271] Agreement-based: master at provider can manage client
          or exists (
            select 1 from public.service_agreements sa
            where (sa.ends_on is null or sa.ends_on >= current_date)
              and sa.client_organization_id = target_org_id
              and (organization_id = sa.provider_organization_id
                   or employer_organization_id = sa.provider_organization_id)
          )
        ))
        -- [EXISTING] admin: direct org match OR descendant tree
        or (role = 'admin' and (
          organization_id = target_org_id
          or target_org_id = any (public.get_descendant_organizations(organization_id))
          -- [NEW — 0271] Agreement-based: admin at provider can manage client
          or exists (
            select 1 from public.service_agreements sa
            where (sa.ends_on is null or sa.ends_on >= current_date)
              and sa.client_organization_id = target_org_id
              and (organization_id = sa.provider_organization_id
                   or employer_organization_id = sa.provider_organization_id)
          )
        ))
      )
  );
$function$;

grant execute on function "public"."is_admin_for_org"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."is_admin_for_org"(uuid) is 'Returns true if the current user is admin, master, or grand_master for the target org. Admin/master check the org descendant tree (via get_descendant_organizations) and agreement-based provider access (0271 Model A). Grand master has unrestricted access.';
