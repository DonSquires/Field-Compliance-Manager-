-- Org-authored jurisdiction rules (#zone-bylaw-authoring-gap). Every
-- organisation configures its own bylaws -- this is a data-driven app, not
-- a hardcoded per-vertical module list. jurisdiction_rule_sets already
-- exists ("Jurisdiction-specific legal/operational rules per module.
-- Supports councils, government, and private enterprise.") scoped by
-- organization_id + module_key + jurisdiction_name, with a free-form rules
-- jsonb column -- but it was SELECT-only, so no org could ever author one.
--
-- Also exposes location_zones.jurisdiction_rule_set_id through
-- get_crm_operational_geography() so ZoneDetailPage can link a zone to a
-- rule set (the column already existed; the read boundary just never
-- selected it).

create policy "jurisdiction_rule_sets_insert" on public.jurisdiction_rule_sets
  for insert with check (public.is_admin_for_org(organization_id));

create policy "jurisdiction_rule_sets_update" on public.jurisdiction_rule_sets
  for update using (public.is_admin_for_org(organization_id)) with check (public.is_admin_for_org(organization_id));

create policy "jurisdiction_rule_sets_delete" on public.jurisdiction_rule_sets
  for delete using (public.is_admin_for_org(organization_id));

create or replace function public.get_crm_operational_geography()
returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare v_actor uuid:=auth.uid();v_provider uuid;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) then raise exception 'Active CRM administrator required';end if;
  return jsonb_build_object(
    'locations',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from(
      select distinct l.id,l.organization_id,l.name,l.address,l.suburb,l.postcode,l.notes
      from public.locations l
      where l.organization_id=v_provider or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        left join public.client_sites s on s.id=sal.site_id left join public.location_zones z on z.id=sal.zone_id
        where sa.provider_organization_id=v_provider and sa.invitation_status='accepted' and sa.agreement_type='operational' and (s.location_id=l.id or z.location_id=l.id)
      )
    )x),
    'sites',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from(
      select distinct s.id,s.client_organization_id,s.location_id,s.name,s.address,s.site_type,s.active,s.gps_lat,s.gps_lng,st_asgeojson(s.boundary)::jsonb boundary,s.boundary_status,s.boundary_verification
      from public.client_sites s
      where s.client_organization_id=v_provider or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        where sa.provider_organization_id=v_provider and sa.invitation_status='accepted' and sa.agreement_type='operational' and sal.site_id=s.id
      )
    )x),
    'zones',(select coalesce(jsonb_agg(to_jsonb(x) order by x.name),'[]'::jsonb) from(
      select distinct z.id,z.organization_id,z.location_id,z.site_id,z.name,z.address,z.zone_type,z.module_key,z.rule_type,z.is_active,z.active_schedule,z.onsite_profile,z.enforcement_workflow_override,st_asgeojson(z.boundary)::jsonb boundary,st_asgeojson(z.center_point)::jsonb center_point,z.boundary_status,z.boundary_verification,z.bylaw_clause,z.bylaw_source_url,z.nightly_limit_consecutive,z.nightly_limit_monthly,z.scv_required,z.jurisdiction_rule_set_id
      from public.location_zones z
      where z.organization_id=v_provider or exists(
        select 1 from public.service_agreements sa join public.service_agreement_locations sal on sal.service_agreement_id=sa.id and sal.status='active'
        where sa.provider_organization_id=v_provider and sa.invitation_status='accepted' and sa.agreement_type='operational' and sal.zone_id=z.id
      )
    )x)
  );
end;$$;

revoke all on function public.get_crm_operational_geography() from public,anon,authenticated;
grant execute on function public.get_crm_operational_geography() to authenticated,service_role;
