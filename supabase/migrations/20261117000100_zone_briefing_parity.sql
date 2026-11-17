-- Zone briefing parity (place patrols & services, A1).
-- A site and a zone are equal: a zone carries the same officer briefing as a
-- site (risk level, what happens here, access, health and safety), so no
-- briefing, patrol stop or static post needs a Site when a zone will do.
-- The three reads below are copied from the live catalog (supabase/schema.sql);
-- only their zone branches change.

ALTER TABLE public.location_zones
  ADD COLUMN IF NOT EXISTS risk_level text CONSTRAINT location_zones_risk_level_check CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  ADD COLUMN IF NOT EXISTS site_brief text,
  ADD COLUMN IF NOT EXISTS access_instructions text,
  ADD COLUMN IF NOT EXISTS hs_notes text;

COMMENT ON COLUMN public.location_zones.risk_level IS 'Officer briefing risk level for this zone (low, medium, high, critical); same meaning as client_sites.risk_level.';
COMMENT ON COLUMN public.location_zones.site_brief IS 'Officer briefing: what happens in this zone.';
COMMENT ON COLUMN public.location_zones.access_instructions IS 'Officer briefing: how officers enter and move around this zone.';
COMMENT ON COLUMN public.location_zones.hs_notes IS 'Officer briefing: health and safety information for this zone.';

CREATE OR REPLACE FUNCTION public.manage_crm_zone_briefing(
  p_zone_id uuid,
  p_expected_version integer,
  p_risk_level text,
  p_site_brief text,
  p_access_instructions text,
  p_hs_notes text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_provider uuid;
  v_zone public.location_zones%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT p.organization_id INTO v_provider FROM public.user_profiles p WHERE p.id = v_actor AND p.deactivated_at IS NULL;
  SELECT z.* INTO v_zone FROM public.location_zones z WHERE z.id = p_zone_id FOR UPDATE;
  IF NOT FOUND OR v_provider IS NULL OR NOT public.is_admin_for_org(v_provider)
     OR NOT public.crm_actor_can_manage_location(v_zone.location_id) THEN
    RAISE EXCEPTION 'Active CRM administrator required for this location' USING ERRCODE = '42501';
  END IF;
  IF v_zone.configuration_version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'Zone changed since you opened it; reload' USING ERRCODE = '40001';
  END IF;
  UPDATE public.location_zones
     SET risk_level = nullif(trim(coalesce(p_risk_level, '')), ''),
         site_brief = nullif(trim(coalesce(p_site_brief, '')), ''),
         access_instructions = nullif(trim(coalesce(p_access_instructions, '')), ''),
         hs_notes = nullif(trim(coalesce(p_hs_notes, '')), ''),
         configuration_version = configuration_version + 1
   WHERE id = v_zone.id
   RETURNING * INTO v_zone;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_provider, v_actor, 'crm_zone_briefing_updated', 'location_zones', v_zone.id,
          jsonb_build_object('location_id', v_zone.location_id, 'configuration_version', v_zone.configuration_version, 'risk_level', v_zone.risk_level));
  RETURN jsonb_build_object('zone_id', v_zone.id, 'configuration_version', v_zone.configuration_version);
END;
$function$;
COMMENT ON FUNCTION public.manage_crm_zone_briefing(uuid, integer, text, text, text, text) IS
  'CRM-admin save of a zone officer briefing (risk level, what happens here, access, health and safety). Optimistic: p_expected_version must match configuration_version (else SQLSTATE 40001); bumps configuration_version and audits.';
REVOKE ALL ON FUNCTION public.manage_crm_zone_briefing(uuid, integer, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_crm_zone_briefing(uuid, integer, text, text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_crm_operational_place_editor(p_location_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor uuid:=auth.uid();v_provider uuid;v_location public.locations%rowtype;
begin
  select organization_id into v_provider from public.user_profiles where id=v_actor and deactivated_at is null;
  if v_provider is null or not public.is_admin_for_org(v_provider) or not public.crm_actor_can_manage_location(p_location_id) then raise exception 'Active CRM administrator required for this location';end if;
  select * into v_location from public.locations l where l.id=p_location_id;if not found then raise exception 'Location not found';end if;
  return jsonb_build_object(
    'location',jsonb_build_object('id',v_location.id,'name',v_location.name,'organization_id',v_location.organization_id),
    'sites',(select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'risk_level',s.risk_level,'site_brief',s.site_brief,'access_instructions',s.access_instructions,'hs_notes',s.hs_notes,'active',s.active,'boundary_status',s.boundary_status,'boundary_verification',s.boundary_verification,'configuration_version',s.configuration_version) order by s.name),'[]'::jsonb) from public.client_sites s where s.location_id=v_location.id),
    'zones',(select coalesce(jsonb_agg(jsonb_build_object('id',z.id,'name',z.name,'zone_type',z.zone_type,'module_key',z.module_key,'rule_type',z.rule_type,'is_active',z.is_active,'nightly_limit_consecutive',z.nightly_limit_consecutive,'nightly_limit_monthly',z.nightly_limit_monthly,'scv_required',z.scv_required,'enforcement_workflow_override',z.enforcement_workflow_override,'boundary_status',z.boundary_status,'boundary_verification',z.boundary_verification,'configuration_version',z.configuration_version,'risk_level',z.risk_level,'site_brief',z.site_brief,'access_instructions',z.access_instructions,'hs_notes',z.hs_notes) order by z.name),'[]'::jsonb) from public.location_zones z where z.location_id=v_location.id AND NOT z.is_verification_point),
    'modules',(select coalesce(jsonb_agg(jsonb_build_object('module_key',m.module_key,'display_name',initcap(replace(m.module_key,'_',' '))) order by m.module_key),'[]'::jsonb) from public.module_catalog m where m.active),
    'closures',(select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'zone_id',c.zone_id,'closure_type',c.closure_type,'status',c.status,'effective_from',c.effective_from,'effective_to',c.effective_to,'reason',c.reason,'resolution_notes',c.resolution_notes) order by c.created_at desc),'[]'::jsonb) from public.zone_closures c join public.location_zones z on z.id=c.zone_id where z.location_id=v_location.id AND NOT z.is_verification_point)
  );
end;
$function$;
REVOKE ALL ON FUNCTION public.get_crm_operational_place_editor(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_crm_operational_place_editor(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_officer_patrol_stops(p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_shift_id is not null then
    select * into v_shift from public.shifts where id = p_shift_id and officer_user_id = v_actor;
  else
    select * into v_shift from public.shifts
    where officer_user_id = v_actor and status in ('in_progress', 'accepted')
    order by case status when 'in_progress' then 0 else 1 end, scheduled_start desc limit 1;
  end if;
  if not found then return null; end if;

  return jsonb_build_object(
    'shift', jsonb_build_object('id', v_shift.id, 'status', v_shift.status, 'scheduled_start', v_shift.scheduled_start, 'scheduled_end', v_shift.scheduled_end,
      'route_name', (select r.name from public.patrol_routes r where r.id = v_shift.patrol_route_id)),
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', st.id, 'stop_order', st.stop_order, 'visit_number', st.visit_number,
        'visits_total', (select count(*) from public.shift_stops v where v.shift_id = st.shift_id and v.patrol_config_id is not distinct from st.patrol_config_id and v.site_id is not distinct from st.site_id and v.zone_id is not distinct from st.zone_id and v.is_adhoc = false),
        'status', st.status, 'sla_status', st.sla_status,
        'sla_window_open', st.sla_window_open, 'sla_arrive_by', st.sla_arrive_by, 'sla_depart_by', st.sla_depart_by,
        'required_dwell_minutes', st.required_dwell_minutes, 'officer_instructions', st.officer_instructions,
        'actual_arrived_at', st.actual_arrived_at, 'actual_departed_at', st.actual_departed_at,
        'actual_travel_distance_km', st.actual_travel_distance_km, 'travel_from_stop_id', st.travel_from_stop_id, 'travel_distance_method', st.travel_distance_method, 'travel_distance_version', st.travel_distance_version, 'arrival_verification', st.arrival_verification, 'arrival_distance_m', st.arrival_distance_m, 'officer_notes', st.officer_notes,
        'module_key', st.module_key,
        -- The toolset for this stop: what the officer is there to do (module-as-data, from shift_stop_modules).
        'modules', coalesce((select jsonb_agg(jsonb_build_object('module_key', m.module_key, 'is_required', m.is_required, 'status', m.status) order by m.is_required desc, m.module_key)
                             from public.shift_stop_modules m where m.shift_stop_id = st.id), '[]'::jsonb),
        'place', case
          when st.site_id is not null then (select jsonb_build_object('kind', 'site', 'name', cs.name, 'address', cs.address, 'access_instructions', cs.access_instructions, 'hs_notes', cs.hs_notes) from public.client_sites cs where cs.id = st.site_id)
          when st.zone_id is not null then (select jsonb_build_object('kind', 'zone', 'name', lz.name, 'address', null, 'access_instructions', lz.access_instructions, 'hs_notes', lz.hs_notes) from public.location_zones lz where lz.id = st.zone_id)
          else jsonb_build_object('kind', 'unknown', 'name', 'Contracted place', 'address', null, 'access_instructions', null, 'hs_notes', null) end
      ) order by st.stop_order, st.visit_number)
      from public.shift_stops st
      where st.shift_id = v_shift.id and st.is_adhoc = false and st.module_key <> 'static_guarding'
    ), '[]'::jsonb)
  );
end;
$function$;
REVOKE ALL ON FUNCTION public.get_officer_patrol_stops(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_officer_patrol_stops(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_officer_static_post(p_shift_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor uuid:=auth.uid();
  v_shift public.shifts%rowtype;
  v_stop public.shift_stops%rowtype;
  v_module public.shift_stop_modules%rowtype;
  v_site public.client_sites%rowtype;
  v_zone public.location_zones%rowtype;
  v_arrival_receipt jsonb;
  v_departure_receipt jsonb;
begin
  if v_actor is null then raise exception 'Authentication required';end if;
  select s.* into v_shift from public.shifts s
  where s.officer_user_id=v_actor and s.service_type='static_guarding'
    and s.status in('scheduled','published','accepted','in_progress') and (p_shift_id is null or s.id=p_shift_id)
  order by
    case
      when s.status='in_progress' then 0
      when now() between s.scheduled_start and s.scheduled_end then 1
      when s.scheduled_start>now() then 2
      else 3
    end,
    case when s.scheduled_start>now() then s.scheduled_start end,
    s.scheduled_start desc
  limit 1;
  if not found then return null;end if;

  select st.* into v_stop from public.shift_stops st
  where st.shift_id=v_shift.id and st.module_key='static_guarding'
  order by st.stop_order limit 1;
  if not found then raise exception 'Static guarding stop is missing';end if;
  select sm.* into v_module from public.shift_stop_modules sm
  where sm.shift_stop_id=v_stop.id and sm.module_key='static_guarding' and sm.is_required
  order by sm.created_at limit 1;
  if not found then raise exception 'Static guarding module task is missing';end if;
  if not exists(select 1 from public.service_agreement_modules sam join public.service_agreement_locations sal on sal.service_agreement_id=sam.service_agreement_id where sam.id=v_module.service_agreement_module_id and sal.id=v_module.service_agreement_location_id and sam.module_key='static_guarding' and sam.enabled and sal.status='active') then raise exception 'Static guarding contract is no longer active';end if;

  if v_stop.site_id is not null then select cs.* into v_site from public.client_sites cs where cs.id=v_stop.site_id and cs.active;end if;
  if v_stop.zone_id is not null then select z.* into v_zone from public.location_zones z where z.id=v_stop.zone_id;end if;
  select a.receipt into v_arrival_receipt from public.shift_stop_actions a where a.shift_stop_id=v_stop.id and a.action_type='static_post_arrived' order by a.performed_at desc limit 1;
  select a.receipt into v_departure_receipt from public.shift_stop_actions a where a.shift_stop_id=v_stop.id and a.action_type='static_post_departed' order by a.performed_at desc limit 1;

  return jsonb_build_object(
    'shift',jsonb_build_object('id',v_shift.id,'status',v_shift.status,'scheduled_start',v_shift.scheduled_start,'scheduled_end',v_shift.scheduled_end,'notes',v_shift.notes),
    'stop',jsonb_build_object('id',v_stop.id,'status',v_stop.status,'sla_arrive_by',v_stop.sla_arrive_by,'actual_arrived_at',v_stop.actual_arrived_at,'actual_departed_at',v_stop.actual_departed_at,'officer_notes',v_stop.officer_notes),
    'module',jsonb_build_object('id',v_module.id,'status',v_module.status,'started_at',v_module.started_at,'completed_at',v_module.completed_at),
    'place',jsonb_build_object('id',coalesce(v_site.id,v_zone.id),'name',coalesce(v_site.name,v_zone.name),'address',v_site.address,'risk_level',coalesce(v_site.risk_level,v_zone.risk_level),'site_brief',coalesce(v_site.site_brief,v_zone.site_brief),'access_instructions',coalesce(v_site.access_instructions,v_zone.access_instructions),'hs_notes',coalesce(v_site.hs_notes,v_zone.hs_notes)),
    'attendance_evidence',jsonb_build_object('arrival',v_arrival_receipt,'departure',v_departure_receipt)
  );
end;$function$;
REVOKE ALL ON FUNCTION public.get_officer_static_post(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_officer_static_post(uuid) TO authenticated, service_role;
