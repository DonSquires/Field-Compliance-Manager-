-- Financial Layer 1 agreements do not authorize access to provider/client
-- places. Cross-organization location visibility requires accepted operations.
CREATE OR REPLACE FUNCTION public.has_location_access(
  p_site_id uuid,
  p_zone_id uuid,
  p_direction text DEFAULT 'provider_reads_client'
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  select public.is_grand_master()
    or (p_site_id is not null and exists (select 1 from public.client_sites site where site.id = p_site_id and public.org_access_allowed(site.client_organization_id)))
    or (p_zone_id is not null and exists (select 1 from public.location_zones zone where zone.id = p_zone_id and public.org_access_allowed(zone.organization_id)))
    or (p_direction = 'provider_reads_client' and exists (
      select 1 from public.service_agreement_locations location
      join public.service_agreements agreement on agreement.id = location.service_agreement_id
      where location.status = 'active' and agreement.agreement_type = 'operational' and agreement.invitation_status = 'accepted'
        and (location.site_id = p_site_id or location.zone_id = p_zone_id)
        and public.org_access_allowed(agreement.provider_organization_id)
    ))
    or (p_direction = 'client_reads_provider' and exists (
      select 1 from public.service_agreement_locations location
      join public.service_agreements agreement on agreement.id = location.service_agreement_id
      where location.status = 'active' and agreement.agreement_type = 'operational' and agreement.invitation_status = 'accepted'
        and (location.site_id = p_site_id or location.zone_id = p_zone_id)
        and public.org_access_allowed(agreement.client_organization_id)
    ))
    or exists (
      select 1 from public.service_agreement_locations location
      join public.service_agreements agreement on agreement.id = location.service_agreement_id
      where location.status = 'active' and agreement.agreement_type = 'operational' and agreement.invitation_status = 'accepted'
        and (location.site_id = p_site_id or location.zone_id = p_zone_id)
        and location.head_contractor_org_id is not null and public.org_access_allowed(location.head_contractor_org_id)
    );
$$;

REVOKE ALL ON FUNCTION public.has_location_access(uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_location_access(uuid,uuid,text) TO authenticated, service_role;