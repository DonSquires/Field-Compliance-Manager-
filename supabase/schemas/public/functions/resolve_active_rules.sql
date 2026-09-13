create or replace function public.resolve_active_rules (
  p_organization_id uuid,
  p_module_key text,
  p_lat double precision default null,
  p_lng double precision default null,
  p_zone_id uuid default null,
  p_site_id uuid default null,
  p_location_id uuid default null,
  p_at timestamptz default now()
)
returns table (
  organization_id uuid,
  module_key text,
  enabled boolean,
  dominant_anchor_kind text,
  active_zone_id uuid,
  active_site_id uuid,
  active_location_id uuid,
  governing_jurisdiction_id uuid,
  governing_jurisdiction_name text,
  module_rule_set_id uuid,
  module_rule_set_name text,
  evidence_requirements jsonb,
  approval_policy jsonb,
  report_template_code text,
  jurisdiction_rule_set_id uuid,
  jurisdiction_rule_set_name text,
  jurisdiction_name text,
  jurisdiction_rules jsonb,
  resolution_status text,
  effective_rules jsonb,
  policy_status text
)
language plpgsql
stable
security definer
set search_path=public as $$
DECLARE
  v_zone_id uuid := p_zone_id;
  v_site_id uuid := p_site_id;
  v_location_id uuid := p_location_id;
  v_rule jsonb := '{}'::jsonb;
  v_jur_id uuid := null;
  v_jur_name text := null;
  v_module_rule_set_id uuid := null;
  v_module_rule_set_name text := null;
  v_module_evidence_requirements jsonb := '{}'::jsonb;
  v_module_approval_policy jsonb := '{}'::jsonb;
  v_module_report_template_code text := null;
  v_jurisdiction_rule_set_id uuid := null;
  v_jurisdiction_rule_set_name text := null;
  v_jurisdiction_name text := null;
  v_jurisdiction_rules jsonb := '{}'::jsonb;
  v_resolution text := 'outside_all_geofences';
  v_enabled boolean := false;
  v_anchor text := 'unresolved';
BEGIN
  IF p_organization_id IS NULL OR nullif(trim(coalesce(p_module_key, '')), '') IS NULL THEN
    RETURN;
  END IF;

  select om.enabled into v_enabled from public.organization_modules om where om.organization_id = p_organization_id and om.module_key = p_module_key limit 1;
  if v_enabled is null then v_enabled := false; end if;

  if p_zone_id is not null then
    select z.id, z.site_id, z.location_id, z.jurisdiction_rule_set_id,
           coalesce(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, coalesce(jrs.rules, '{}'::jsonb),
           case when z.boundary is not null then 'zone' else 'unresolved' end
      into v_zone_id, v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules, v_anchor
    from public.location_zones z left join public.jurisdiction_rule_sets jrs on jrs.id = z.jurisdiction_rule_set_id
    where z.id = p_zone_id limit 1;
    v_resolution := 'resolved';
  elsif p_site_id is not null then
    select cs.id, cs.location_id, coalesce(z.jurisdiction_rule_set_id, null),
           coalesce(jrs.name, 'jurisdiction_rules'), jrs.jurisdiction_name, coalesce(jrs.rules, '{}'::jsonb), 'site'
      into v_site_id, v_location_id, v_jurisdiction_rule_set_id,
           v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules, v_anchor
    from public.client_sites cs left join public.location_zones z on z.site_id = cs.id and z.module_key = p_module_key
    left join public.jurisdiction_rule_sets jrs on jrs.id = z.jurisdiction_rule_set_id
    where cs.id = p_site_id limit 1;
    v_resolution := 'resolved';
  elsif p_lat is not null and p_lng is not null then
    select rc.matched_zone_id, rc.site_id, rc.client_org_id, rc.governing_jurisdiction_id,
           rc.governing_jurisdiction_name, rc.effective_rules, rc.resolution_status
      into v_zone_id, v_site_id, v_location_id, v_jur_id, v_jur_name, v_rule, v_resolution
    from public.resolve_context(p_lat, p_lng, p_organization_id, p_module_key, p_at) rc
    limit 1;
    if v_zone_id is not null then
      select z.location_id into v_location_id from public.location_zones z where z.id = v_zone_id limit 1;
    end if;
    v_anchor := case when v_zone_id is not null then 'zone' when v_site_id is not null then 'site' else 'unresolved' end;
  end if;

  select mrs.id, mrs.name, mrs.evidence_requirements, mrs.approval_policy, mrs.report_template_code
    into v_module_rule_set_id, v_module_rule_set_name, v_module_evidence_requirements, v_module_approval_policy, v_module_report_template_code
  from public.module_rule_sets mrs where mrs.organization_id = p_organization_id and mrs.module_key = p_module_key order by mrs.created_at desc limit 1;

  if v_jurisdiction_rule_set_id is null and p_organization_id is not null and p_module_key is not null then
    select jrs.id, jrs.name, jrs.jurisdiction_name, jrs.rules into v_jurisdiction_rule_set_id, v_jurisdiction_rule_set_name, v_jurisdiction_name, v_jurisdiction_rules
    from public.jurisdiction_rule_sets jrs where jrs.organization_id = p_organization_id and jrs.module_key = p_module_key order by jrs.created_at desc limit 1;
  end if;

  if v_rule = '{}'::jsonb then
    v_rule := coalesce(v_jurisdiction_rules, '{}'::jsonb);
  end if;

  return query select
    p_organization_id,
    p_module_key,
    v_enabled,
    v_anchor,
    v_zone_id,
    v_site_id,
    v_location_id,
    v_jur_id,
    v_jur_name,
    v_module_rule_set_id,
    v_module_rule_set_name,
    v_module_evidence_requirements,
    v_module_approval_policy,
    v_module_report_template_code,
    v_jurisdiction_rule_set_id,
    v_jurisdiction_rule_set_name,
    v_jurisdiction_name,
    v_jurisdiction_rules,
    v_resolution,
    v_rule,
    case when v_enabled = false then 'disabled'
         when v_resolution in ('unresolved_no_geofence','unresolved_invalid','unresolved_unverified','outside_all_geofences') then 'needs_resolution'
         when v_module_rule_set_id is null then 'missing_module_rule_set'
         when v_jurisdiction_rule_set_id is null then 'missing_jurisdiction_rule_set'
         else 'effective_rules_ready' end as policy_status;
END;
$$;

grant execute on function public.resolve_active_rules(uuid, text, double precision, double precision, uuid, uuid, uuid, timestamptz) to authenticated, service_role;
