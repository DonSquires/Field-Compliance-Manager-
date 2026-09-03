-- ============================================================
-- Migration 20260903140000 — Governed Officer Offline Data Package RPC
-- ============================================================
-- Issue #99: Organization-scoped offline data package download RPC,
-- security definition, RLS alignment, and audit logging.

create or replace function public.get_officer_data_package(
  p_shift_id uuid DEFAULT NULL
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_zones jsonb;
  v_matrix jsonb;
  v_flags jsonb;
  v_rules jsonb;
  v_stops jsonb;
  v_welfare jsonb;
  v_package jsonb;
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  select p.organization_id into v_org_id from public.user_profiles p where p.id = v_user_id and p.deactivated_at is null;
  if v_org_id is null then raise exception 'Active officer profile required for data package download'; end if;

  if p_shift_id is not null and not exists (select 1 from public.shifts s where s.id = p_shift_id and s.organization_id = v_org_id) then
    raise exception 'Shift does not belong to the officer organisation';
  end if;

  -- 1. Active location zones
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', z.id,
    'location_id', z.location_id,
    'name', z.name,
    'address', z.address,
    'zone_type', z.zone_type,
    'module_key', z.module_key,
    'rule_type', z.rule_type,
    'is_active', z.is_active
  )), '[]'::jsonb) into v_zones
  from public.location_zones z
  where z.organization_id = v_org_id and z.is_active = true;

  -- 2. Current zone compliance matrix
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'zone_id', m.zone_id,
    'max_consecutive_nights', m.max_consecutive_nights,
    'max_nights_per_month', m.max_nights_per_month,
    'scv_required', m.scv_required,
    'is_current', m.is_current
  )), '[]'::jsonb) into v_matrix
  from public.zone_compliance_matrix m
  where m.organization_id = v_org_id and m.is_current = true;

  -- 3. Active entity flags (vehicle/person)
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'entity_type', f.entity_type,
    'plate_number', f.plate_number,
    'flag_type', f.flag_type,
    'flag_reason', f.flag_reason,
    'severity', f.severity,
    'is_active', f.is_active
  )), '[]'::jsonb) into v_flags
  from public.entity_flags f
  where f.organization_id = v_org_id and f.is_active = true;

  -- 4. Module rule sets
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'module_key', r.module_key,
    'name', r.name,
    'evidence_requirements', r.evidence_requirements,
    'approval_policy', r.approval_policy
  )), '[]'::jsonb) into v_rules
  from public.module_rule_sets r
  where r.organization_id = v_org_id;

  -- 5. Patrol stops for current shift if supplied
  if p_shift_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', st.id,
      'site_id', st.site_id,
      'zone_id', st.zone_id,
      'status', st.status,
      'sla_respond_by', st.sla_respond_by,
      'notes', st.notes
    )), '[]'::jsonb) into v_stops
    from public.shift_stops st
    where st.shift_id = p_shift_id and st.organization_id = v_org_id;
  else
    v_stops := '[]'::jsonb;
  end if;

  -- 6. Welfare settings
  select to_jsonb(w.*) into v_welfare
  from public.officer_welfare_settings w
  where w.organization_id = v_org_id limit 1;

  v_package := jsonb_build_object(
    'package_timestamp', clock_timestamp(),
    'organization_id', v_org_id,
    'officer_id', v_user_id,
    'shift_id', p_shift_id,
    'location_zones', v_zones,
    'zone_compliance_matrix', v_matrix,
    'entity_flags', v_flags,
    'module_rule_sets', v_rules,
    'shift_stops', v_stops,
    'welfare_settings', coalesce(v_welfare, '{}'::jsonb)
  );

  insert into public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) values (
    v_org_id, v_user_id, 'officer_data_package_downloaded', 'user_profiles', v_user_id,
    jsonb_build_object('shift_id', p_shift_id, 'zone_count', jsonb_array_length(v_zones), 'flag_count', jsonb_array_length(v_flags))
  );

  return v_package;
end;
$$;

revoke all on function public.get_officer_data_package from public, anon;
grant execute on function public.get_officer_data_package to authenticated, service_role;
