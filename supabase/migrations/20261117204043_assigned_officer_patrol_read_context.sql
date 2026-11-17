-- Assignment-scoped context, without broadening raw-table RLS.
CREATE OR REPLACE FUNCTION public.get_assigned_officer_shift_context()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles p WHERE p.id=v_actor AND p.deactivated_at IS NULL
      AND p.role IN ('grand_master','master','admin','admin_officer','officer')
  ) THEN RAISE EXCEPTION 'Active Patrol officer required'; END IF;
  RETURN coalesce((
    WITH candidates AS (
      SELECT s.*, CASE WHEN s.scheduled_end<=now() THEN false
        ELSE EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id=s.id
          AND st.organization_id IS DISTINCT FROM s.organization_id)
          OR (s.patrol_route_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.patrol_routes r
            WHERE r.id=s.patrol_route_id AND r.organization_id=s.organization_id))
        END AS inconsistent
      FROM public.shifts s WHERE s.officer_user_id=v_actor
        AND ((s.status='in_progress' AND s.scheduled_end<=now())
          OR (s.status IN ('published','accepted','in_progress') AND s.scheduled_end>now()
            AND s.scheduled_start<=now()+interval '24 hours'))
    )
    SELECT jsonb_agg(CASE WHEN s.scheduled_end<=now() OR s.inconsistent THEN jsonb_build_object(
      'id',s.id,'organization_id',s.organization_id,'officer_user_id',s.officer_user_id,
      'scheduled_start',s.scheduled_start,'scheduled_end',s.scheduled_end,'status',s.status,
      'context_status',CASE WHEN s.scheduled_end<=now() THEN 'recovery_only' ELSE 'requires_review' END
    ) ELSE jsonb_build_object(
      'id',s.id,'organization_id',s.organization_id,'officer_user_id',s.officer_user_id,
      'service_type',s.service_type,'scheduled_start',s.scheduled_start,'scheduled_end',s.scheduled_end,
      'status',s.status,'location_id',s.location_id,'zone_id',s.zone_id,
      'patrol_route_id',s.patrol_route_id,'created_at',s.created_at,'updated_at',s.updated_at,
      'service_agreement_location_id',NULL,'service_agreement_module',NULL,
      'zone_name',NULL,'route_name',NULL,'route_code',NULL,
      'context_status','available',
      'shift_stops',coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',st.id,'shift_id',st.shift_id,'zone_id',st.zone_id,'site_id',st.site_id,
        'site',NULL,'stop_order',st.stop_order,'actual_arrived_at',st.actual_arrived_at,
        'actual_departed_at',st.actual_departed_at) ORDER BY st.stop_order,st.visit_number,st.id)
        FROM public.shift_stops st WHERE st.shift_id=s.id AND st.organization_id=s.organization_id), '[]'::jsonb)
    ) END ORDER BY s.scheduled_start,s.id)
    FROM candidates s
  ),'[]'::jsonb);
END;
$function$;
REVOKE ALL ON FUNCTION public.get_assigned_officer_shift_context() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_assigned_officer_shift_context() TO authenticated;

CREATE OR REPLACE FUNCTION public.get_assigned_patrol_session(p_shift_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE
  v_actor uuid:=auth.uid(); v_shift public.shifts%ROWTYPE; v_patrol public.patrols%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles p WHERE p.id=v_actor AND p.deactivated_at IS NULL
      AND p.role IN ('grand_master','master','admin','admin_officer','officer')
  ) THEN RAISE EXCEPTION 'Active Patrol officer required'; END IF;
  SELECT * INTO v_shift FROM public.shifts s WHERE s.id=p_shift_id AND s.officer_user_id=v_actor
    AND s.status IN ('published','accepted','in_progress') AND s.scheduled_end>now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_shift.id
    AND st.organization_id IS DISTINCT FROM v_shift.organization_id)
    OR (v_shift.patrol_route_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.patrol_routes r WHERE r.id=v_shift.patrol_route_id AND r.organization_id=v_shift.organization_id))
  THEN RAISE EXCEPTION 'Patrol configuration requires operations review'; END IF;
  IF EXISTS (SELECT 1 FROM public.patrols p WHERE p.shift_id=v_shift.id AND p.status='in_progress'
    AND (p.officer_user_id IS DISTINCT FROM v_actor OR p.organization_id IS DISTINCT FROM v_shift.organization_id))
    OR (SELECT count(*) FROM public.patrols p WHERE p.shift_id=v_shift.id AND p.status='in_progress')>1
  THEN RAISE EXCEPTION 'Patrol session configuration requires operations review'; END IF;
  SELECT * INTO v_patrol FROM public.patrols p WHERE p.shift_id=v_shift.id
    AND p.officer_user_id=v_actor AND p.organization_id=v_shift.organization_id
    ORDER BY p.started_at DESC,p.id DESC LIMIT 1;
  IF NOT FOUND THEN RETURN jsonb_build_object('shift_id',v_shift.id,'session',NULL,'visits','[]'::jsonb); END IF;
  IF EXISTS (SELECT 1 FROM public.patrol_checkpoint_visits v WHERE v.patrol_id=v_patrol.id
    AND (v.organization_id IS DISTINCT FROM v_shift.organization_id OR v.officer_user_id IS DISTINCT FROM v_actor
      OR (v.checkpoint_id IS NULL) = (v.route_checkpoint_id IS NULL)
      OR (v.route_checkpoint_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.patrol_route_checkpoints c WHERE c.id=v.route_checkpoint_id
          AND c.patrol_route_id=v_shift.patrol_route_id))
      OR (v.checkpoint_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.patrol_checkpoints c WHERE c.id=v.checkpoint_id
          AND c.organization_id=v_shift.organization_id
          AND ((c.zone_id IS NOT NULL AND c.zone_id=v_shift.zone_id)
            OR EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.shift_id=v_shift.id
              AND ((c.client_site_id IS NOT NULL AND c.client_site_id=st.site_id)
                OR (c.zone_id IS NOT NULL AND c.zone_id=st.zone_id))))))))
  THEN RAISE EXCEPTION 'Patrol visit configuration requires operations review'; END IF;
  RETURN jsonb_build_object('shift_id',v_shift.id,
    'session',jsonb_build_object('id',v_patrol.id,'status',v_patrol.status,
      'started_at',v_patrol.started_at,'ended_at',v_patrol.ended_at),
    'visits',coalesce((SELECT jsonb_agg(jsonb_build_object(
      'id',v.id,'checkpoint_id',v.checkpoint_id,'route_checkpoint_id',v.route_checkpoint_id,
      'visited_at',v.visited_at,'scan_method',v.scan_method,'notes',NULL,
      'within_radius',v.within_radius,'checkpoint_verification_at_visit',v.checkpoint_verification_at_visit)
      ORDER BY v.visited_at,v.id) FROM public.patrol_checkpoint_visits v
      WHERE v.patrol_id=v_patrol.id AND v.organization_id=v_shift.organization_id
        AND v.officer_user_id=v_actor),'[]'::jsonb));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_assigned_patrol_session(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_assigned_patrol_session(uuid) TO authenticated;