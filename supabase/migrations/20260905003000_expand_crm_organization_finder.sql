-- Bounded CRM discovery across the organization's durable identity and place spines.
-- Fuzzy matching applies only to organization names; identifiers remain exact/partial.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_organizations_name_trgm
  ON public.organizations USING gin (lower(name) extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_locations_address_trgm
  ON public.locations USING gin (lower(coalesce(address, '')) extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_name_trgm
  ON public.crm_contacts USING gin (lower(first_name || ' ' || last_name) extensions.gin_trgm_ops)
  WHERE deactivated_at IS NULL;

CREATE OR REPLACE FUNCTION public.find_crm_organization_candidates(
  p_query text,
  p_nzbn text DEFAULT NULL
)
RETURNS TABLE(
  id uuid,
  name text,
  organization_type text,
  status text,
  nzbn text,
  parent_organization_id uuid,
  match_reason text,
  manageable boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions
AS $$
declare
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_query text := lower(trim(coalesce(p_query, '')));
  v_nzbn text := nullif(regexp_replace(coalesce(p_nzbn, ''), '[^0-9]', '', 'g'), '');
begin
  select actor.organization_id into v_provider
  from public.user_profiles actor
  where actor.id = v_actor and actor.deactivated_at is null;

  if v_provider is null or not public.is_admin_for_org(v_provider) then
    raise exception 'Active CRM administrator required';
  end if;
  if char_length(v_query) < 2 and v_nzbn is null then
    raise exception 'Enter at least two search characters or an NZBN';
  end if;

  return query
  with visible_organizations as (
    select organization.*
    from public.organizations organization
    where organization.id = v_provider
       or organization.parent_organization_id = v_provider
       or public.crm_actor_can_manage_account(organization.id)
       or organization.discoverable
  ), matches as (
    select organization.*,
      case
        when v_nzbn is not null and regexp_replace(coalesce(organization.nzbn, ''), '[^0-9]', '', 'g') = v_nzbn then 0
        when regexp_replace(coalesce(organization.company_registration_number, ''), '[^0-9]', '', 'g') = regexp_replace(v_query, '[^0-9]', '', 'g') and regexp_replace(v_query, '[^0-9]', '', 'g') <> '' then 1
        when lower(trim(organization.name)) = v_query then 2
        when lower(organization.name) like '%' || v_query || '%' then 3
        when exists (select 1 from public.client_sites site where site.client_organization_id = organization.id and (lower(coalesce(site.address, '')) like '%' || v_query || '%' or lower(coalesce(site.external_ref, '')) like '%' || v_query || '%' or lower(coalesce(site.internal_client_ref, '')) like '%' || v_query || '%')) then 4
        when exists (select 1 from public.locations location where location.organization_id = organization.id and lower(coalesce(location.address, '')) like '%' || v_query || '%') then 5
        when exists (select 1 from public.crm_contacts contact where contact.organization_id = organization.id and contact.deactivated_at is null and (lower(contact.first_name || ' ' || contact.last_name) like '%' || v_query || '%' or lower(coalesce(contact.email, '')) like '%' || v_query || '%' or lower(coalesce(contact.phone, '')) like '%' || v_query || '%' or lower(coalesce(contact.mobile, '')) like '%' || v_query || '%')) then 6
        when extensions.similarity(lower(organization.name), v_query) >= 0.35 then 7
        else 99
      end as match_rank
    from visible_organizations organization
  )
  select match.id, match.name, match.organization_type, match.status, match.nzbn, match.parent_organization_id,
    case match.match_rank
      when 0 then 'Exact NZBN'
      when 1 then 'Exact Companies Office number'
      when 2 then 'Exact organization name'
      when 3 then 'Name contains search'
      when 4 then 'Matched site address or client ID'
      when 5 then 'Matched location address'
      when 6 then 'Matched active contact'
      else 'Similar organization name'
    end,
    (match.id = v_provider or match.parent_organization_id = v_provider or public.crm_actor_can_manage_account(match.id))
  from matches match
  where match.match_rank < 99
  order by match.match_rank, case when match.match_rank = 7 then extensions.similarity(lower(match.name), v_query) else 1 end desc, match.name
  limit 20;
end;
$$;

REVOKE ALL ON FUNCTION public.find_crm_organization_candidates(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_crm_organization_candidates(text,text) TO authenticated, service_role;
