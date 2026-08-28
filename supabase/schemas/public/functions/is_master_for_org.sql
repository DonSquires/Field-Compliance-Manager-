create or replace function public.is_master_for_org (
  p_org_id uuid
)
  returns boolean
  language sql
  stable
  security definer
  AS $function$
  select exists (
    select 1 from public.user_profiles up
    where up.id = auth.uid()
      and up.role = 'master'
      and (
        -- [EXISTING] Descendant tree of employer_organization_id
        p_org_id = any (public.get_descendant_organizations(up.employer_organization_id))
        -- [EXISTING] Descendant tree of organization_id
        or p_org_id = any (public.get_descendant_organizations(up.organization_id))
        -- [NEW — 0271] Agreement-based: master at the PROVIDER org
        -- can manage the CLIENT org on an active agreement.
        or exists (
          select 1 from public.service_agreements sa
          where (sa.ends_on is null or sa.ends_on >= current_date)
            and sa.client_organization_id = p_org_id
            and (up.organization_id = sa.provider_organization_id
                 or up.employer_organization_id = sa.provider_organization_id)
        )
      )
  );
$function$;

grant execute on function "public"."is_master_for_org"(uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."is_master_for_org"(uuid) is 'True when the current user is a master and p_org_id is within their authorised org tree (employer_organization_id or organization_id descendants) OR the user is a master at the provider org on an active service_agreement with p_org_id as client (0271 Model A). Scopes master self-management; never grants delete.';
