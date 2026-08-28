create or replace function public.has_location_access (
  p_site_id   uuid,
  p_zone_id   uuid,
  p_direction text default 'provider_reads_client'::text
)
  returns boolean
  language sql
  stable
  security definer
  set search_path to 'public'
  AS $function$
  select
    -- Grand master always has access.
    public.is_grand_master()
    -- Ownership: the calling user''s org owns the location.
    or (
      p_site_id is not null
      and exists (
        select 1 from public.client_sites cs
        where cs.id = p_site_id
          and public.org_access_allowed(cs.client_organization_id)
      )
    )
    or (
      p_zone_id is not null
      and exists (
        select 1 from public.location_zones lz
        where lz.id = p_zone_id
          and public.org_access_allowed(lz.organization_id)
      )
    )
    -- Cross-org access via an active service_agreement_locations row.
    -- Direction: provider_reads_client = provider org has the agreement.
    --            client_reads_provider = client org has the agreement
    --              (Tier 1 operational results only; finance gated separately).
    or (
      p_direction = 'provider_reads_client'
      and exists (
        select 1
        from public.service_agreement_locations sal
        join public.service_agreements sa on sa.id = sal.service_agreement_id
        where sal.status = 'active'
          and (sal.site_id = p_site_id or sal.zone_id = p_zone_id)
          and public.org_access_allowed(sa.provider_organization_id)
      )
    )
    or (
      p_direction = 'client_reads_provider'
      and exists (
        select 1
        from public.service_agreement_locations sal
        join public.service_agreements sa on sa.id = sal.service_agreement_id
        where sal.status = 'active'
          and (sal.site_id = p_site_id or sal.zone_id = p_zone_id)
          and public.org_access_allowed(sa.client_organization_id)
      )
    )
    -- NEW (0270): head-contractor reads subcontracted work at the location.
    -- Depends on 0269 adding service_agreement_locations.head_contractor_org_id.
    or exists (
      select 1 from public.service_agreement_locations sal
      where sal.status = 'active'
        and (sal.site_id = p_site_id or sal.zone_id = p_zone_id)
        and sal.head_contractor_org_id is not null
        and public.org_access_allowed(sal.head_contractor_org_id)
    );
$function$;

grant execute on function "public"."has_location_access"(uuid, uuid, text) to public, "anon", "authenticated", "postgres", "service_role";

comment on function "public"."has_location_access"(uuid, uuid, text) is 'Returns true when the calling user''s org has access to a location (site or zone), either by ownership, via an active service_agreement_locations row, or as a head contractor with subcontracted work at the location. Direction controls cross-org read: provider_reads_client (provider reads client location data) or client_reads_provider (client reads Tier 1 operational results at their location). QA gaps G1+G2 from epic #179; head-contractor visibility from epic #203 R2 #205.';
