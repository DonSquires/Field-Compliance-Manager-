-- Officer-started (unscheduled) static guarding shifts were prepared without the
-- single static post that rostered static shifts receive. The safety briefing
-- reads that post, so the officer could not start the shift. Prepare the post
-- from the work unit's active contract, and repair an already-prepared shift
-- when the officer retries. Patrol preparation is unchanged.
CREATE OR REPLACE FUNCTION public.start_ad_hoc_officer_shift(
  p_work_unit_id uuid,
  p_module_key text,
  p_location_id uuid DEFAULT NULL::uuid,
  p_zone_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text
)
RETURNS public.shifts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_shift public.shifts%rowtype;
  v_sal public.service_agreement_locations%rowtype;
  v_site_location uuid;
  v_stop uuid;
  v_created boolean := false;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO v_profile FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL AND role IN ('officer', 'admin_officer') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active officer profile required'; END IF;
  SELECT * INTO v_unit FROM public.roster_work_units
  WHERE id = p_work_unit_id AND organization_id = v_profile.organization_id AND active FOR SHARE;
  IF NOT FOUND OR v_unit.service_type IS DISTINCT FROM p_module_key THEN
    RAISE EXCEPTION 'Authorized active work unit/module required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.shifts WHERE officer_user_id = v_actor AND status = 'in_progress') THEN
    RAISE EXCEPTION 'Officer already has an active shift';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.locations l WHERE l.id = p_location_id AND (
      l.organization_id = v_profile.organization_id
      OR EXISTS (SELECT 1 FROM public.client_sites s WHERE s.location_id = l.id AND public.has_location_access(s.id, NULL))
      OR EXISTS (SELECT 1 FROM public.location_zones z WHERE z.location_id = l.id AND public.has_location_access(NULL, z.id))
    )
  ) THEN RAISE EXCEPTION 'Work location is not authorised'; END IF;
  IF p_zone_id IS NOT NULL AND NOT public.has_location_access(NULL, p_zone_id) THEN
    RAISE EXCEPTION 'Work zone is not authorised';
  END IF;

  -- Same contract rule as materialize_roster_slot_core: the static post comes
  -- from the unit's active agreement location and enabled static module.
  IF v_unit.work_unit_type = 'static' THEN
    SELECT sal.* INTO v_sal FROM public.service_agreement_locations sal
    WHERE sal.id = v_unit.service_agreement_location_id AND sal.status = 'active';
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM public.service_agreement_modules sam
      WHERE sam.id = v_unit.service_agreement_module_id
        AND sam.service_agreement_id = v_sal.service_agreement_id
        AND sam.enabled
        AND sam.module_key = 'static_guarding'
    ) THEN
      RAISE EXCEPTION 'Static work unit contract is no longer active';
    END IF;
    IF v_sal.site_id IS NOT NULL THEN
      SELECT cs.location_id INTO v_site_location FROM public.client_sites cs WHERE cs.id = v_sal.site_id;
    END IF;
  END IF;

  SELECT * INTO v_shift FROM public.shifts
  WHERE officer_user_id = v_actor AND work_unit_id = v_unit.id AND shift_origin = 'ad_hoc'
    AND status = 'scheduled' AND scheduled_end > v_now
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.shifts (
      organization_id, officer_user_id, service_type, location_id, zone_id,
      patrol_route_id, service_agreement_location_id, service_agreement_module_id,
      scheduled_start, scheduled_end, status, notes, work_unit_id, module_key, shift_origin
    ) VALUES (
      v_profile.organization_id, v_actor, p_module_key,
      CASE WHEN v_unit.work_unit_type = 'static' THEN coalesce(v_site_location, p_location_id) ELSE p_location_id END,
      CASE WHEN v_unit.work_unit_type = 'static' THEN coalesce(v_sal.zone_id, p_zone_id) ELSE p_zone_id END,
      v_unit.patrol_route_id, v_unit.service_agreement_location_id, v_unit.service_agreement_module_id,
      v_now, v_now + interval '12 hours', 'scheduled', nullif(trim(p_notes), ''), p_work_unit_id, p_module_key, 'ad_hoc'
    ) RETURNING * INTO v_shift;
    v_created := true;
    IF v_unit.patrol_route_id IS NOT NULL THEN
      PERFORM public.generate_shift_stops(v_shift.id, (v_now AT TIME ZONE 'Pacific/Auckland')::date);
    END IF;
    INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_profile.organization_id, v_actor, 'officer_ad_hoc_shift_prepared', 'shifts', v_shift.id,
      jsonb_build_object('work_unit_id', p_work_unit_id, 'module_key', p_module_key, 'safety_check_required', true));
  END IF;

  IF v_unit.work_unit_type = 'static' AND NOT EXISTS (
    SELECT 1 FROM public.shift_stops st WHERE st.shift_id = v_shift.id AND st.module_key = 'static_guarding'
  ) THEN
    UPDATE public.shifts
    SET location_id = coalesce(location_id, v_site_location),
        zone_id = coalesce(zone_id, v_sal.zone_id),
        total_stops = 1,
        generated_at = clock_timestamp()
    WHERE id = v_shift.id;

    INSERT INTO public.shift_stops (
      organization_id, shift_id, site_id, zone_id, module_key, stop_order, visit_number,
      is_adhoc, sla_arrive_by, required_dwell_minutes, status, sla_status, officer_notes
    ) VALUES (
      v_shift.organization_id, v_shift.id, v_sal.site_id, v_sal.zone_id, 'static_guarding', 1, 1,
      false, v_shift.scheduled_start, 0, 'pending', 'on_track', v_shift.notes
    ) RETURNING id INTO v_stop;

    INSERT INTO public.shift_stop_modules (
      organization_id, shift_stop_id, module_key, is_required,
      service_agreement_module_id, service_agreement_location_id
    ) VALUES (
      v_shift.organization_id, v_stop, 'static_guarding', true,
      v_unit.service_agreement_module_id, v_unit.service_agreement_location_id
    );

    IF NOT v_created THEN
      INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
      VALUES (v_profile.organization_id, v_actor, 'officer_ad_hoc_static_post_created', 'shifts', v_shift.id,
        jsonb_build_object('work_unit_id', p_work_unit_id, 'shift_stop_id', v_stop));
    END IF;
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = v_shift.id;
  RETURN v_shift;
END;
$function$;

COMMENT ON FUNCTION public.start_ad_hoc_officer_shift(uuid, text, uuid, uuid, text) IS
  'Prepares a scheduled ad-hoc (unscheduled) shift with its work-unit contract, patrol route stops or single static post. The officer then reads risks, acknowledges and starts through start_officer_shift. Reuses an unstarted shift on retry and adds a missing static post to it.';

REVOKE ALL ON FUNCTION public.start_ad_hoc_officer_shift(uuid, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_ad_hoc_officer_shift(uuid, text, uuid, uuid, text) TO authenticated, service_role;
