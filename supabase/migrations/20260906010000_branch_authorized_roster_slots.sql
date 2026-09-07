CREATE OR REPLACE FUNCTION public.create_roster_slot(
  p_client_request_id uuid,
  p_work_unit_id uuid,
  p_staff_id uuid,
  p_scheduled_start timestamptz,
  p_scheduled_end timestamptz,
  p_publish boolean DEFAULT false,
  p_notes text DEFAULT NULL
)
RETURNS public.roster_slots
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_slot public.roster_slots%rowtype;
BEGIN
  SELECT u.* INTO v_unit FROM public.roster_work_units u WHERE u.id=p_work_unit_id AND u.active;
  IF NOT FOUND OR NOT public.is_admin_for_org(v_unit.organization_id) THEN RAISE EXCEPTION 'Active authorized work unit required'; END IF;

  SELECT sp.* INTO v_staff
  FROM public.staff_profiles sp
  WHERE sp.id=p_staff_id AND sp.work_ready;
  IF NOT FOUND OR NOT (
    v_staff.organization_id = v_unit.organization_id
    OR EXISTS(
      SELECT 1 FROM public.staff_branch_authorisations sba
      WHERE sba.user_id = v_staff.user_id
        AND sba.branch_org_id = v_unit.organization_id
        AND sba.status = 'active'
    )
  ) THEN RAISE EXCEPTION 'Work-ready staff profile required'; END IF;

  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_scheduled_start >= p_scheduled_end OR p_scheduled_start < now() - interval '5 minutes' OR p_scheduled_end - p_scheduled_start > interval '24 hours' THEN RAISE EXCEPTION 'Slot timing is outside the accepted range'; END IF;

  SELECT s.* INTO v_slot FROM public.roster_slots s WHERE s.organization_id=v_unit.organization_id AND s.client_request_id=p_client_request_id;
  IF FOUND THEN RETURN v_slot; END IF;
  IF EXISTS(SELECT 1 FROM public.leave_requests l WHERE l.staff_id=p_staff_id AND l.status='approved' AND daterange(l.starts_on,l.ends_on,'[]') && daterange(p_scheduled_start::date,p_scheduled_end::date,'[]')) THEN RAISE EXCEPTION 'Staff member has approved leave'; END IF;
  IF EXISTS(SELECT 1 FROM public.roster_slots s WHERE s.staff_id=p_staff_id AND s.status NOT IN('declined','cancelled') AND s.scheduled_start < p_scheduled_end AND s.scheduled_end > p_scheduled_start) THEN RAISE EXCEPTION 'Staff member already has an overlapping roster slot'; END IF;

  INSERT INTO public.roster_slots(organization_id,work_unit_id,staff_id,scheduled_start,scheduled_end,status,client_request_id,notes,created_by)
  VALUES(v_unit.organization_id,v_unit.id,p_staff_id,p_scheduled_start,p_scheduled_end,CASE WHEN p_publish THEN 'published' ELSE 'draft' END,p_client_request_id,nullif(trim(coalesce(p_notes,'')),''),v_actor)
  RETURNING * INTO v_slot;

  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_unit.organization_id,v_actor,'roster_slot_created','roster_slots',v_slot.id,jsonb_build_object('work_unit_id',v_unit.id,'work_unit_type',v_unit.work_unit_type,'staff_id',p_staff_id,'status',v_slot.status));
  RETURN v_slot;
END;
$$;

CREATE OR REPLACE FUNCTION public.materialize_roster_slot(p_slot_id uuid, p_expected_status text DEFAULT 'published')
RETURNS TABLE(slot_id uuid, shift_id uuid, created boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_slot public.roster_slots%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_user uuid;
  v_shift public.shifts%rowtype;
  v_sal public.service_agreement_locations%rowtype;
  v_site_location uuid;
  v_stop uuid;
BEGIN
  SELECT s.* INTO v_slot FROM public.roster_slots s WHERE s.id=p_slot_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Roster slot not found'; END IF;
  IF NOT public.is_admin_for_org(v_slot.organization_id) THEN RAISE EXCEPTION 'Not authorised to materialize this roster slot'; END IF;
  IF v_slot.status <> p_expected_status THEN RAISE EXCEPTION 'Roster slot changed from expected status % to %', p_expected_status, v_slot.status; END IF;
  IF v_slot.linked_shift_id IS NOT NULL THEN RETURN QUERY SELECT v_slot.id,v_slot.linked_shift_id,false; RETURN; END IF;

  SELECT u.* INTO v_unit FROM public.roster_work_units u WHERE u.id=v_slot.work_unit_id AND u.organization_id=v_slot.organization_id AND u.active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active work unit not found'; END IF;
  IF v_unit.work_unit_type='internal' THEN RAISE EXCEPTION 'Internal roster slots do not materialize field shifts'; END IF;

  SELECT sp.* INTO v_staff
  FROM public.staff_profiles sp
  WHERE sp.id=v_slot.staff_id AND sp.work_ready;
  IF NOT FOUND OR NOT (
    v_staff.organization_id = v_slot.organization_id
    OR EXISTS(
      SELECT 1 FROM public.staff_branch_authorisations sba
      WHERE sba.user_id = v_staff.user_id
        AND sba.branch_org_id = v_slot.organization_id
        AND sba.status = 'active'
    )
  ) THEN RAISE EXCEPTION 'Work-ready staff profile required'; END IF;

  v_user := coalesce(v_staff.user_id,v_staff.id);
  IF NOT EXISTS(SELECT 1 FROM public.user_profiles up WHERE up.id=v_user AND up.deactivated_at IS NULL AND up.role IN('officer','admin_officer')) THEN RAISE EXCEPTION 'Roster slot staff is not an active field officer'; END IF;

  IF v_unit.work_unit_type='patrol' THEN
    SELECT * INTO v_shift FROM public.create_roster_shift(v_user,v_unit.service_type,v_slot.scheduled_start,v_slot.scheduled_end,NULL,NULL,v_unit.patrol_route_id,v_slot.notes,true);
    UPDATE public.shifts SET organization_id=v_slot.organization_id, roster_slot_id=v_slot.id WHERE id=v_shift.id RETURNING * INTO v_shift;
    PERFORM public.generate_shift_stops(v_shift.id,(v_slot.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date);
  ELSIF v_unit.work_unit_type='static' THEN
    SELECT sal.* INTO v_sal FROM public.service_agreement_locations sal WHERE sal.id=v_unit.service_agreement_location_id AND sal.status='active';
    IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM public.service_agreement_modules sam WHERE sam.id=v_unit.service_agreement_module_id AND sam.service_agreement_id=v_sal.service_agreement_id AND sam.enabled AND sam.module_key='static_guarding') THEN RAISE EXCEPTION 'Static work unit contract is no longer active'; END IF;
    IF v_sal.site_id IS NOT NULL THEN SELECT cs.location_id INTO v_site_location FROM public.client_sites cs WHERE cs.id=v_sal.site_id; END IF;
    SELECT * INTO v_shift FROM public.create_roster_shift(v_user,v_unit.service_type,v_slot.scheduled_start,v_slot.scheduled_end,v_site_location,v_sal.zone_id,NULL,v_slot.notes,true);
    UPDATE public.shifts
    SET organization_id=v_slot.organization_id,
        roster_slot_id=v_slot.id,
        service_agreement_location_id=v_unit.service_agreement_location_id,
        service_agreement_module_id=v_unit.service_agreement_module_id,
        total_stops=1,
        generated_at=clock_timestamp()
    WHERE id=v_shift.id
    RETURNING * INTO v_shift;
    INSERT INTO public.shift_stops(organization_id,shift_id,site_id,zone_id,module_key,stop_order,visit_number,is_adhoc,sla_arrive_by,required_dwell_minutes,status,sla_status,officer_notes)
    VALUES(v_slot.organization_id,v_shift.id,v_sal.site_id,v_sal.zone_id,'static_guarding',1,1,false,v_slot.scheduled_start,0,'pending','on_track',v_slot.notes)
    RETURNING id INTO v_stop;
    INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required,service_agreement_module_id,service_agreement_location_id)
    VALUES(v_slot.organization_id,v_stop,'static_guarding',true,v_unit.service_agreement_module_id,v_unit.service_agreement_location_id);
  ELSE
    RAISE EXCEPTION 'Unsupported field work unit type';
  END IF;

  UPDATE public.roster_slots SET linked_shift_id=v_shift.id WHERE id=v_slot.id;
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_slot.organization_id,v_actor,'roster_slot_materialized','roster_slots',v_slot.id,jsonb_build_object('work_unit_id',v_unit.id,'work_unit_type',v_unit.work_unit_type,'shift_id',v_shift.id));
  RETURN QUERY SELECT v_slot.id,v_shift.id,true;
END;
$$;

REVOKE ALL ON FUNCTION public.create_roster_slot(uuid,uuid,uuid,timestamptz,timestamptz,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_roster_slot(uuid,uuid,uuid,timestamptz,timestamptz,boolean,text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.materialize_roster_slot(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.materialize_roster_slot(uuid,text) TO authenticated, service_role;
