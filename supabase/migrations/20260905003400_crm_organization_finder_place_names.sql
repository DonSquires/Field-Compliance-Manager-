-- Organization discovery may use an owned place's public name or address for duplicate prevention.
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
  select profile.organization_id into v_provider from public.user_profiles profile where profile.id = v_actor and profile.deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required'; end if;
  if char_length(v_query) < 2 and v_nzbn is null then raise exception 'Enter at least two search characters or an NZBN'; end if;

  return query
  with matches as (
    select organization.*,
      case
        when v_nzbn is not null and regexp_replace(coalesce(organization.nzbn, ''), '[^0-9]', '', 'g') = v_nzbn then 0
        when lower(trim(organization.name)) = v_query then 1
        when lower(organization.name) like '%' || v_query || '%' then 2
        when exists (select 1 from public.client_sites site where site.client_organization_id = organization.id and (lower(site.name) like '%' || v_query || '%' or lower(coalesce(site.address, '')) like '%' || v_query || '%')) then 3
        when exists (select 1 from public.locations location where location.organization_id = organization.id and (lower(location.name) like '%' || v_query || '%' or lower(coalesce(location.address, '')) like '%' || v_query || '%')) then 4
        when extensions.word_similarity(v_query, lower(organization.name)) >= 0.5 then 5
        else 99
      end as match_rank
    from public.organizations organization
  )
  select match.id, match.name, match.organization_type, match.status, match.nzbn, match.parent_organization_id,
    case match.match_rank
      when 0 then 'Exact NZBN'
      when 1 then 'Exact organization name'
      when 2 then 'Name contains search'
      when 3 then 'Matched owned site'
      when 4 then 'Matched owned location'
      else 'Similar organization name'
    end,
    coalesce(match.id = v_provider or match.parent_organization_id = v_provider or public.crm_actor_can_manage_account(match.id), false)
  from matches match
  where match.match_rank < 99
  order by match.match_rank, case when match.match_rank = 5 then extensions.word_similarity(v_query, lower(match.name)) else 1 end desc, match.name
  limit 20;
end;
$$;

REVOKE ALL ON FUNCTION public.find_crm_organization_candidates(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.find_crm_organization_candidates(text,text) TO authenticated, service_role;
