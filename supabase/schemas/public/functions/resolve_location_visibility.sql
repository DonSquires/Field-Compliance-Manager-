create or replace function public.resolve_location_visibility (
  p_sal_id         uuid,
  p_viewing_org_id uuid
)
  returns table (
    share_contract_price boolean,
    share_actual_cost    boolean,
    is_provider          boolean,
    is_client            boolean
  )
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select
    -- Effective share_contract_price: location override if set, else agreement default.
    coalesce(sal.share_contract_price, sa.default_share_contract_price) as share_contract_price,
    coalesce(sal.share_actual_cost,    sa.default_share_actual_cost)    as share_actual_cost,
    -- Which side of the agreement is the viewing org?
    public.org_access_allowed(sa.provider_organization_id) as is_provider,
    public.org_access_allowed(sa.client_organization_id)   as is_client
  from public.service_agreement_locations sal
  join public.service_agreements sa on sa.id = sal.service_agreement_id
  where sal.id = p_sal_id;
$function$;

grant execute on function "public"."resolve_location_visibility"(uuid, uuid) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."resolve_location_visibility"(uuid, uuid) is 'Returns effective visibility settings for a location contract: share_contract_price and share_actual_cost (location override coalesced with agreement default), plus which side of the agreement the viewing org is on. Used by the UI finance tab and conductor egress gate (epic #179).';
