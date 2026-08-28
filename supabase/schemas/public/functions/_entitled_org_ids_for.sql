create or replace function public._entitled_org_ids_for (
  p_user_id uuid
)
  returns SETOF uuid
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  -- CLAUSE 1: grand_master sees ALL orgs.
  select o.id
  from public.organizations o
  where exists (
    select 1 from public.user_profiles p
    where p.id = p_user_id and p.role = 'grand_master'
  )

  union

  -- CLAUSE 2: own org + authorized_organization_ids.
  select target.id
  from public.organizations target
  join public.user_profiles p on p.id = p_user_id
  where target.id = p.organization_id
     or target.id = any(p.authorized_organization_ids)

  union

  -- CLAUSE 3: master/admin ownership-tree descent (org + employer anchors).
  select d.org_id
  from public.user_profiles p
  cross join lateral (
    select unnest(
      public.get_descendant_organizations(p.organization_id)
      || case
           when p.employer_organization_id is not null
           then public.get_descendant_organizations(p.employer_organization_id)
           else array[]::uuid[]
         end
    ) as org_id
  ) d
  where p.id = p_user_id
    and p.role in ('grand_master', 'master', 'admin')

  union

  -- CLAUSE 4: provider_client_access_grants (active).
  select g_target.org_id
  from public.provider_client_access_grants g
  join public.user_profiles p on p.id = p_user_id
  cross join lateral (
    values (g.provider_organization_id), (g.client_organization_id)
  ) as g_target(org_id)
  where (
      p.organization_id = g.provider_organization_id
      or p.organization_id = g.client_organization_id
    )
    and (g.ends_at is null or g.ends_at > now())

  union

  -- CLAUSE 5 (0271): agreement-based, bidirectional.
  select sa_target.org_id
  from public.service_agreements sa
  join public.user_profiles p on p.id = p_user_id
  cross join lateral (
    values
      (case when (p.organization_id = sa.provider_organization_id
                  or p.employer_organization_id = sa.provider_organization_id)
            then sa.client_organization_id end),
      (case when (p.organization_id = sa.client_organization_id
                  or p.employer_organization_id = sa.client_organization_id)
            then sa.provider_organization_id end)
  ) as sa_target(org_id)
  where (sa.ends_on is null or sa.ends_on >= current_date)
    and sa_target.org_id is not null;
$function$;

grant execute on function "public"."_entitled_org_ids_for"(uuid) to "postgres", "service_role";

comment on function "public"."_entitled_org_ids_for"(uuid) is 'INTERNAL shared entitlement resolver: the five org_access_allowed clauses keyed on an EXPLICIT resolved user id. NOT user-callable (revoked from public / authenticated / anon) - it accepts an arbitrary user id, so it is reachable ONLY through the governed wrappers my_entitled_org_ids() (self-only) and my_entitled_org_ids_for_user() (service-role only). Single source of truth for both; 0352 parity matrix applies. #306.';

revoke all on function "public"."_entitled_org_ids_for"(uuid) from public;
