CREATE TABLE public.patrol_config_responsibilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  patrol_config_id uuid NOT NULL REFERENCES public.client_site_patrol_config(id),
  patrol_route_id uuid NOT NULL REFERENCES public.patrol_routes(id),
  work_unit_id uuid NOT NULL REFERENCES public.roster_work_units(id),
  service_agreement_location_id uuid NOT NULL REFERENCES public.service_agreement_locations(id),
  service_agreement_module_id uuid NOT NULL REFERENCES public.service_agreement_modules(id),
  rate_selection_id uuid NOT NULL REFERENCES public.agreement_place_rate_selections(id),
  effective_from date NOT NULL,
  effective_to date,
  superseded_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(effective_to IS NULL OR effective_to>=effective_from)
);
COMMENT ON TABLE public.patrol_config_responsibilities IS
  'Versioned operational allocation of an existing contractual visit schedule. Does not change contracted days, visits, windows, dwell or SLA.';
CREATE UNIQUE INDEX patrol_config_responsibilities_version_idx
  ON public.patrol_config_responsibilities(patrol_config_id,effective_from)
  WHERE superseded_at IS NULL;
CREATE INDEX patrol_config_responsibilities_org_idx ON public.patrol_config_responsibilities(organization_id);
CREATE INDEX patrol_config_responsibilities_route_idx ON public.patrol_config_responsibilities(patrol_route_id);
CREATE INDEX patrol_config_responsibilities_unit_idx ON public.patrol_config_responsibilities(work_unit_id);
CREATE INDEX patrol_config_responsibilities_place_idx ON public.patrol_config_responsibilities(service_agreement_location_id);
CREATE INDEX patrol_config_responsibilities_module_idx ON public.patrol_config_responsibilities(service_agreement_module_id);
CREATE INDEX patrol_config_responsibilities_rate_idx ON public.patrol_config_responsibilities(rate_selection_id);
ALTER TABLE public.patrol_config_responsibilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.patrol_config_responsibilities FROM PUBLIC,anon,authenticated,service_role;

CREATE TABLE public.location_patrol_setup_receipts (
  client_request_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  operating_organization_id uuid NOT NULL REFERENCES public.organizations(id),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  actor_id uuid NOT NULL,
  request_fingerprint jsonb NOT NULL,
  receipt jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX location_patrol_setup_receipts_org_idx ON public.location_patrol_setup_receipts(organization_id);
CREATE INDEX location_patrol_setup_receipts_operating_idx ON public.location_patrol_setup_receipts(operating_organization_id);
CREATE INDEX location_patrol_setup_receipts_location_idx ON public.location_patrol_setup_receipts(location_id);
ALTER TABLE public.location_patrol_setup_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.location_patrol_setup_receipts FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.patrol_config_route_at(p_config_id uuid,p_date date)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
  SELECT coalesce((
    SELECT r.patrol_route_id FROM public.patrol_config_responsibilities r
    WHERE r.patrol_config_id=c.id AND r.superseded_at IS NULL
      AND r.effective_from<=p_date AND (r.effective_to IS NULL OR r.effective_to>=p_date)
    ORDER BY r.effective_from DESC LIMIT 1
  ),c.patrol_route_id) FROM public.client_site_patrol_config c WHERE c.id=p_config_id
$function$;
REVOKE ALL ON FUNCTION public.patrol_config_route_at(uuid,date) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.patrol_shift_plan_locked_reason(p_shift_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=''
AS $function$
  SELECT CASE
    WHEN EXISTS(SELECT 1 FROM public.shift_stops st WHERE st.shift_id=s.id
      AND (st.status<>'pending' OR st.actual_arrived_at IS NOT NULL OR st.actual_departed_at IS NOT NULL
        OR st.officer_notes IS NOT NULL OR st.arrived_gps_lat IS NOT NULL OR st.departed_gps_lat IS NOT NULL
        OR st.bwc_reference IS NOT NULL OR st.actual_travel_distance_km IS NOT NULL))
      OR EXISTS(SELECT 1 FROM public.shift_stop_modules m JOIN public.shift_stops st ON st.id=m.shift_stop_id
        WHERE st.shift_id=s.id AND (m.status<>'pending' OR m.started_at IS NOT NULL
          OR m.completed_at IS NOT NULL OR m.result_record_id IS NOT NULL OR m.outcome IS NOT NULL))
      OR EXISTS(SELECT 1 FROM public.shift_stop_actions a WHERE a.shift_id=s.id)
      OR EXISTS(SELECT 1 FROM public.patrols p WHERE p.shift_id=s.id)
      OR EXISTS(SELECT 1 FROM public.officer_gps_log g WHERE g.shift_id=s.id)
      OR EXISTS(SELECT 1 FROM public.patrol_checkpoint_visits v JOIN public.shift_stops st ON st.id=v.shift_stop_id WHERE st.shift_id=s.id)
      OR EXISTS(SELECT 1 FROM public.safety_briefing_acknowledgements a WHERE a.shift_id=s.id)
      OR EXISTS(SELECT 1 FROM public.patrol_stop_charge_lines c WHERE c.shift_id=s.id)
      THEN 'Recorded field, safety or financial evidence must be preserved'
    WHEN s.status NOT IN('scheduled','published','accepted') OR s.actual_start IS NOT NULL
      OR s.actual_end IS NOT NULL THEN 'Shift already started or is no longer an unstarted plan'
    WHEN s.scheduled_start<=statement_timestamp() THEN 'Scheduled start has passed'
    ELSE NULL END
  FROM public.shifts s WHERE s.id=p_shift_id
$function$;
REVOKE ALL ON FUNCTION public.patrol_shift_plan_locked_reason(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.generate_shift_stops_internal(p_shift_id uuid,p_shift_date date,p_config_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='public'
AS $function$
DECLARE
  v_shift public.shifts%rowtype;
  v_config public.client_site_patrol_config%rowtype;
  v_stop_id uuid; v_stop_count integer:=0; v_visit integer; v_visits integer;
  v_window_open timestamptz; v_window_close timestamptz; v_eff_open timestamptz; v_eff_close timestamptz;
  v_step interval; v_sla_open timestamptz; v_sla_arrive_by timestamptz; v_sla_depart_by timestamptz;
  v_day integer:=extract(isodow FROM p_shift_date)::integer;
  v_month integer:=extract(month FROM p_shift_date)::integer;
  v_module_count integer; v_windowed boolean; v_reason text; v_initial_materialization boolean;
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id;
  IF NOT FOUND OR p_shift_date IS NULL THEN RAISE EXCEPTION 'Shift and NZ service date are required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('patrol-plan-org:'||v_shift.organization_id,0));
  SELECT * INTO STRICT v_shift FROM public.shifts WHERE id=p_shift_id FOR UPDATE NOWAIT;
  IF p_shift_date<>(v_shift.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date THEN
    RAISE EXCEPTION 'Stop generation must use the shift NZ service date';
  END IF;
  v_reason:=public.patrol_shift_plan_locked_reason(p_shift_id);
  v_initial_materialization:=p_config_id IS NULL AND v_shift.generated_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM public.shift_stops WHERE shift_id=p_shift_id)
    AND (
      (v_reason='Scheduled start has passed' AND v_shift.status IN('scheduled','published','accepted')
        AND v_shift.actual_start IS NULL AND v_shift.actual_end IS NULL)
      OR (v_reason='Shift already started or is no longer an unstarted plan'
        AND v_shift.shift_origin='ad_hoc' AND v_shift.status='in_progress' AND v_shift.actual_end IS NULL)
    );
  IF v_reason IS NOT NULL AND NOT coalesce(v_initial_materialization,false) THEN
    RAISE EXCEPTION 'Cannot regenerate patrol plan: %',v_reason USING ERRCODE='40001';
  END IF;
  DELETE FROM public.shift_stops WHERE shift_id=p_shift_id AND NOT is_adhoc
    AND (p_config_id IS NULL OR patrol_config_id=p_config_id);
  FOR v_config IN SELECT c.* FROM public.client_site_patrol_config c
    WHERE c.organization_id=v_shift.organization_id AND c.active AND c.time_window_type<>'as_attended'
      AND public.patrol_config_route_at(c.id,p_shift_date)=v_shift.patrol_route_id
      AND (p_config_id IS NULL OR c.id=p_config_id)
      AND (array_length(c.active_days,1) IS NULL OR v_day=ANY(c.active_days))
      AND (array_length(c.active_months,1) IS NULL OR cardinality(c.active_months)=0 OR v_month=ANY(c.active_months))
    ORDER BY c.preferred_stop_order,c.id
  LOOP
    v_visits:=greatest(coalesce(v_config.visits_per_shift,1),1);
    v_windowed:=v_config.time_window_type='fixed' AND v_config.window_start IS NOT NULL;
    IF v_windowed THEN
      SELECT b.window_open,b.window_close INTO v_window_open,v_window_close
        FROM public.patrol_window_bounds(p_shift_date,v_config.window_start,v_config.window_end,
          v_shift.scheduled_start,v_shift.scheduled_end) b;
      v_eff_open:=greatest(v_window_open,v_shift.scheduled_start);
      v_eff_close:=least(coalesce(v_window_close,v_shift.scheduled_end),v_shift.scheduled_end);
      IF v_eff_close<=v_eff_open THEN
        v_eff_open:=v_window_open;
        v_eff_close:=coalesce(v_window_close,v_window_open+make_interval(mins=>coalesce(v_config.sla_arrive_within_minutes,30)));
      END IF;
    ELSE v_eff_open:=v_shift.scheduled_start; v_eff_close:=v_shift.scheduled_end;
    END IF;
    v_step:=CASE WHEN v_visits>1 THEN (v_eff_close-v_eff_open)/v_visits ELSE interval '0' END;
    FOR v_visit IN 1..v_visits LOOP
      IF v_windowed THEN
        v_sla_open:=v_eff_open+v_step*(v_visit-1);
        v_sla_arrive_by:=v_sla_open+make_interval(mins=>coalesce(v_config.sla_arrive_within_minutes,30));
        v_sla_depart_by:=v_sla_arrive_by+make_interval(mins=>coalesce(v_config.sla_depart_within_minutes,45));
      ELSIF v_visits>1 THEN
        v_sla_open:=v_eff_open+v_step*(v_visit-1); v_sla_arrive_by:=v_sla_open+v_step; v_sla_depart_by:=NULL;
      ELSE v_sla_open:=NULL; v_sla_arrive_by:=v_shift.scheduled_end; v_sla_depart_by:=NULL;
      END IF;
      INSERT INTO public.shift_stops(organization_id,shift_id,patrol_config_id,site_id,zone_id,module_key,
        stop_order,visit_number,is_adhoc,sla_window_open,sla_arrive_by,sla_depart_by,
        required_dwell_minutes,officer_instructions,status,sla_status)
      VALUES(v_shift.organization_id,p_shift_id,v_config.id,v_config.site_id,v_config.zone_id,v_config.module_key,
        v_config.preferred_stop_order*10+v_visit,v_visit,false,v_sla_open,v_sla_arrive_by,v_sla_depart_by,
        v_config.dwell_minutes,v_config.officer_instructions,'pending','on_track') RETURNING id INTO v_stop_id;
      INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required,
        service_agreement_module_id,service_agreement_location_id)
        SELECT v_shift.organization_id,v_stop_id,m.module_key,m.is_required,
          m.service_agreement_module_id,m.service_agreement_location_id
        FROM public.patrol_route_stop_modules m WHERE m.patrol_config_id=v_config.id AND m.active
        ON CONFLICT(shift_stop_id,module_key) DO NOTHING;
      GET DIAGNOSTICS v_module_count=ROW_COUNT;
      IF v_module_count=0 THEN
        INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required)
          VALUES(v_shift.organization_id,v_stop_id,v_config.module_key,true)
          ON CONFLICT(shift_stop_id,module_key) DO NOTHING;
      END IF;
      v_stop_count:=v_stop_count+1;
    END LOOP;
  END LOOP;
  UPDATE public.shifts SET total_stops=(SELECT count(*) FROM public.shift_stops WHERE shift_id=p_shift_id),
    generated_at=clock_timestamp() WHERE id=p_shift_id;
  RETURN v_stop_count;
END;
$function$;
REVOKE ALL ON FUNCTION public.generate_shift_stops_internal(uuid,date,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.generate_shift_stops(p_shift_id uuid,p_shift_date date)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE v_shift public.shifts%rowtype;
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id=p_shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF auth.uid() IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.user_profiles p
    WHERE p.id=auth.uid() AND p.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'Active officer or administrator authority required' USING ERRCODE='42501';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.is_admin_for_org(v_shift.organization_id)
    AND v_shift.officer_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Assigned officer or operating branch administrator required' USING ERRCODE='42501';
  END IF;
  IF auth.uid() IS NULL AND current_setting('role',true) NOT IN('service_role','none') THEN
    RAISE EXCEPTION 'Authenticated patrol planning authority required' USING ERRCODE='42501';
  END IF;
  RETURN public.generate_shift_stops_internal(p_shift_id,p_shift_date,NULL);
END;
$function$;
REVOKE ALL ON FUNCTION public.generate_shift_stops(uuid,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.generate_shift_stops(uuid,date) TO authenticated,service_role;

CREATE FUNCTION public.get_location_patrol_setup(p_location_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_result jsonb; v_agreements jsonb; v_configs jsonb; v_runs jsonb; v_billing jsonb:='[]'; v_workspace jsonb;
  v_billing_context record; v_today date:=(current_timestamp AT TIME ZONE 'Pacific/Auckland')::date;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.user_profiles p WHERE p.id=auth.uid() AND p.deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'Active location administrator authority required' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]') INTO v_agreements FROM(
    SELECT DISTINCT agreement.id,agreement.name,agreement.provider_organization_id,
      agreement.client_organization_id,agreement.starts_on,agreement.ends_on
    FROM public.service_agreements agreement
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id=agreement.id AND sal.status='active'
    LEFT JOIN public.client_sites s ON s.id=sal.site_id AND s.active AND s.client_organization_id=agreement.client_organization_id
    LEFT JOIN public.location_zones z ON z.id=sal.zone_id AND z.is_active AND NOT z.is_verification_point
      AND z.organization_id=agreement.client_organization_id
    JOIN public.locations l ON l.id=p_location_id AND l.organization_id=agreement.client_organization_id
      AND (s.location_id=l.id OR z.location_id=l.id)
    WHERE agreement.agreement_type='operational'
      AND (agreement.ends_on IS NULL OR agreement.ends_on>=v_today)
      AND public.is_admin_for_org(agreement.provider_organization_id)
      AND public.user_can_operate_organization(agreement.provider_organization_id)
  ) a;
  IF jsonb_array_length(v_agreements)=0 THEN
    RAISE EXCEPTION 'Location administrator authority and a covered operational agreement are required' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id,c.service_agreement_location_id,c.service_agreement_module_id),'[]') INTO v_configs FROM(
    SELECT cfg.*,d.service_agreement_id,d.module_key AS contracted_module_key,
      to_jsonb(d) AS contractual_terms,a.provider_organization_id,a.name AS agreement_name,
      sal.id AS service_agreement_location_id,sam.id AS service_agreement_module_id,
      coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.effective_from,r.id)
        FROM public.patrol_config_responsibilities r WHERE r.patrol_config_id=cfg.id),'[]') AS responsibilities
    FROM public.client_site_patrol_config cfg
    JOIN public.service_agreement_delivery_schedules d ON (d.id=cfg.delivery_schedule_id
      OR (cfg.delivery_schedule_id IS NULL AND cfg.proposal_scope_schedule_id IS NOT NULL AND d.proposal_scope_schedule_id=cfg.proposal_scope_schedule_id))
    JOIN public.service_agreements a ON a.id=d.service_agreement_id
    JOIN public.service_agreement_locations sal ON sal.service_agreement_id=a.id AND sal.status='active'
      AND (sal.site_id=cfg.site_id OR sal.zone_id=cfg.zone_id)
    JOIN public.service_agreement_modules sam ON sam.service_agreement_id=a.id AND sam.module_key=d.module_key AND sam.enabled
    LEFT JOIN public.client_sites s ON s.id=cfg.site_id AND s.active AND s.client_organization_id=a.client_organization_id
    LEFT JOIN public.location_zones z ON z.id=cfg.zone_id AND z.is_active AND NOT z.is_verification_point
    JOIN public.locations l ON l.id=p_location_id AND l.organization_id=a.client_organization_id
      AND (s.location_id=l.id OR z.location_id=l.id)
    WHERE cfg.active AND d.active AND a.agreement_type='operational'
      AND (a.ends_on IS NULL OR a.ends_on>=v_today)
      AND public.is_admin_for_org(a.provider_organization_id) AND public.user_can_operate_organization(a.provider_organization_id)
      AND public.is_admin_for_org(cfg.organization_id) AND public.user_can_operate_organization(cfg.organization_id)
      AND (cfg.organization_id=a.provider_organization_id
        OR cfg.organization_id=ANY(public.get_descendant_organizations(a.provider_organization_id)))
  ) c;
  SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.name,r.id),'[]') INTO v_runs FROM(
    SELECT route.*,coalesce((SELECT jsonb_agg(to_jsonb(u) ORDER BY u.name,u.id)
      FROM public.roster_work_units u WHERE u.patrol_route_id=route.id AND u.organization_id=route.organization_id
        AND u.work_unit_type='patrol' AND u.active),'[]') AS work_units
    FROM public.patrol_routes route
    WHERE public.is_admin_for_org(route.organization_id) AND public.user_can_operate_organization(route.organization_id)
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_agreements) a
        WHERE route.organization_id=(a->>'provider_organization_id')::uuid
          OR route.organization_id=ANY(public.get_descendant_organizations((a->>'provider_organization_id')::uuid)))
  ) r;
  FOR v_billing_context IN SELECT (a->>'provider_organization_id')::uuid AS provider_id,
    greatest(v_today,min((a->>'starts_on')::date)) AS effective_on FROM jsonb_array_elements(v_agreements) a
    GROUP BY (a->>'provider_organization_id')::uuid ORDER BY (a->>'provider_organization_id')::uuid
  LOOP
    v_workspace:=public.get_location_billing_workspace(v_billing_context.provider_id,p_location_id,v_billing_context.effective_on);
    v_workspace:=jsonb_set(v_workspace,'{selections}',(
      SELECT coalesce(jsonb_agg(s ORDER BY s->>'id'),'[]') FROM jsonb_array_elements(v_workspace->'selections') s));
    v_billing:=v_billing||jsonb_build_array(v_workspace);
  END LOOP;
  SELECT coalesce(jsonb_agg(w ORDER BY w->>'provider_id'),'[]') INTO v_billing FROM jsonb_array_elements(v_billing) w;
  v_result:=jsonb_build_object('location_id',p_location_id,'service_date',v_today,
    'agreements',v_agreements,'configs',v_configs,'runs',v_runs,'billing_workspaces',v_billing,
    'billing_units',(SELECT coalesce(jsonb_agg(to_jsonb(u) ORDER BY u.code),'[]') FROM public.patrol_billing_units u),
    'evidence_policy_ready',false);
  RETURN v_result||jsonb_build_object('version',md5(v_result::text));
END;
$function$;
REVOKE ALL ON FUNCTION public.get_location_patrol_setup(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_location_patrol_setup(uuid) TO authenticated;

CREATE FUNCTION public.preview_location_patrol_setup(p_location_id uuid,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_setup jsonb:=public.get_location_patrol_setup(p_location_id);
  v_config jsonb; v_run jsonb; v_from date; v_billing jsonb:=p_changes->'billing';
  v_affected jsonb; v_blocked jsonb; v_snapshot jsonb; v_org uuid; v_rates jsonb;
BEGIN
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR p_changes-ARRAY[
    'patrol_config_id','service_agreement_location_id','service_agreement_module_id',
    'patrol_route_id','work_unit_id','effective_from','billing']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Unsupported changes: contractual terms must use the agreement variation approval path';
  END IF;
  SELECT c INTO v_config FROM jsonb_array_elements(v_setup->'configs') c
    WHERE c->>'id'=p_changes->>'patrol_config_id'
      AND c->>'service_agreement_location_id'=p_changes->>'service_agreement_location_id'
      AND c->>'service_agreement_module_id'=p_changes->>'service_agreement_module_id';
  IF v_config IS NULL THEN RAISE EXCEPTION 'Choose the exact authorized contract, service and patrol schedule'; END IF;
  v_org:=(v_config->>'organization_id')::uuid;
  v_from:=(p_changes->>'effective_from')::date;
  IF v_from IS NULL OR v_from<(v_setup->>'service_date')::date THEN
    RAISE EXCEPTION 'Choose today or a future effective date; historical responsibility is preserved';
  END IF;
  IF EXISTS(SELECT 1 FROM public.service_agreements a WHERE a.id=(v_config->>'service_agreement_id')::uuid
    AND ((a.starts_on IS NOT NULL AND a.starts_on>v_from) OR (a.ends_on IS NOT NULL AND a.ends_on<v_from))) THEN
    RAISE EXCEPTION 'Effective date is outside the approved agreement';
  END IF;
  IF EXISTS(SELECT 1 FROM public.patrol_config_responsibilities r
    WHERE r.patrol_config_id=(v_config->>'id')::uuid AND r.superseded_at IS NULL AND r.effective_from>v_from) THEN
    RAISE EXCEPTION 'A later responsibility version exists; reload and preserve its effective date';
  END IF;
  SELECT r INTO v_run FROM jsonb_array_elements(v_setup->'runs') r
    WHERE r->>'id'=p_changes->>'patrol_route_id' AND (r->>'is_active')::boolean
      AND r->>'organization_id'=v_config->>'organization_id';
  IF v_run IS NULL THEN RAISE EXCEPTION 'Choose an active authorized patrol run in the operating branch'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_run->'work_units') u WHERE u->>'id'=p_changes->>'work_unit_id') THEN
    RAISE EXCEPTION 'Choose an active rosterable patrol work unit for that run';
  END IF;
  IF jsonb_typeof(v_billing) IS DISTINCT FROM 'object' OR v_billing-ARRAY[
    'source','rate_type','billing_unit_code','rate_rule_id','new_rate','expected_selection_id','expected_updated_at']<>'{}'::jsonb
    OR NOT EXISTS(SELECT 1 FROM public.patrol_billing_units u WHERE u.code=v_billing->>'billing_unit_code'
      AND u.rate_type=v_billing->>'rate_type' AND u.active) THEN
    RAISE EXCEPTION 'Choose an explicit active patrol charging unit and billing source';
  END IF;
  v_rates:=public.get_location_billing_workspace((v_config->>'provider_organization_id')::uuid,p_location_id,v_from);
  v_rates:=jsonb_set(v_rates,'{selections}',(
    SELECT coalesce(jsonb_agg(s ORDER BY s->>'id'),'[]') FROM jsonb_array_elements(v_rates->'selections') s));
  SELECT coalesce(jsonb_agg(item ORDER BY item->>'shift_id') FILTER(WHERE reason IS NULL),'[]'),
    coalesce(jsonb_agg(item||jsonb_build_object('reason',reason) ORDER BY item->>'shift_id') FILTER(WHERE reason IS NOT NULL),'[]')
    INTO v_affected,v_blocked FROM(
      SELECT public.patrol_shift_plan_locked_reason(s.id) AS reason,
        jsonb_build_object('shift_id',s.id,'status',s.status,'scheduled_start',s.scheduled_start,
          'scheduled_end',s.scheduled_end,'route_id',s.patrol_route_id,'actual_start',s.actual_start,
          'actual_end',s.actual_end,'updated_at',s.updated_at,
          'stops',coalesce((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.id) FROM public.shift_stops st
            WHERE st.shift_id=s.id AND st.patrol_config_id=(v_config->>'id')::uuid),'[]')) AS item
      FROM public.shifts s WHERE s.organization_id=v_org
        AND (s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date>=v_from
        AND (s.patrol_route_id=(p_changes->>'patrol_route_id')::uuid
          OR s.patrol_route_id=public.patrol_config_route_at((v_config->>'id')::uuid,
            (s.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date)
          OR EXISTS(SELECT 1 FROM public.shift_stops st WHERE st.shift_id=s.id AND st.patrol_config_id=(v_config->>'id')::uuid))
    ) candidates;
  v_snapshot:=jsonb_build_object('actor',auth.uid(),'location',p_location_id,
    'version',v_setup->>'version','changes',p_changes,'billing_workspace',v_rates,'affected',v_affected,'blocked',v_blocked);
  RETURN jsonb_build_object('version',v_setup->>'version','preview_fingerprint',md5(v_snapshot::text),
    'affected',v_affected,'blocked',v_blocked,'billing_workspace',v_rates,'contractual_terms',v_config->'contractual_terms');
END;
$function$;
REVOKE ALL ON FUNCTION public.preview_location_patrol_setup(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_location_patrol_setup(uuid,jsonb) TO authenticated;

CREATE FUNCTION public.save_location_patrol_setup(p_location_id uuid,p_client_request_id uuid,
  p_expected_version text,p_preview_fingerprint text,p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $function$
DECLARE
  v_saved public.location_patrol_setup_receipts%rowtype;
  v_previous public.patrol_config_responsibilities%rowtype;
  v_setup jsonb; v_config jsonb; v_preview jsonb; v_billing jsonb:=p_changes->'billing';
  v_rate jsonb; v_receipt jsonb; v_id uuid; v_provider uuid; v_org uuid; v_from date; v_shift record;
  v_fingerprint jsonb:=jsonb_build_object('actor',auth.uid(),'location',p_location_id,
    'version',p_expected_version,'preview',p_preview_fingerprint,'changes',p_changes);
BEGIN
  IF auth.uid() IS NULL OR p_client_request_id IS NULL THEN RAISE EXCEPTION 'Authenticated request required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('location-patrol-request:'||p_client_request_id,0));
  SELECT * INTO v_saved FROM public.location_patrol_setup_receipts WHERE client_request_id=p_client_request_id;
  IF FOUND THEN
    IF v_saved.request_fingerprint IS DISTINCT FROM v_fingerprint OR v_saved.actor_id IS DISTINCT FROM auth.uid()
      OR NOT public.is_admin_for_org(v_saved.organization_id) OR NOT public.user_can_operate_organization(v_saved.organization_id)
      OR NOT public.is_admin_for_org(v_saved.operating_organization_id)
      OR NOT public.user_can_operate_organization(v_saved.operating_organization_id) THEN
      RAISE EXCEPTION 'Patrol setup request replay conflicts or actor authority changed' USING ERRCODE='42501';
    END IF;
    RETURN v_saved.receipt||jsonb_build_object('replayed',true);
  END IF;
  v_setup:=public.get_location_patrol_setup(p_location_id);
  SELECT c INTO v_config FROM jsonb_array_elements(v_setup->'configs') c WHERE c->>'id'=p_changes->>'patrol_config_id'
    AND c->>'service_agreement_location_id'=p_changes->>'service_agreement_location_id'
    AND c->>'service_agreement_module_id'=p_changes->>'service_agreement_module_id';
  IF v_config IS NULL THEN RAISE EXCEPTION 'Authorized contract and patrol configuration required' USING ERRCODE='42501'; END IF;
  v_provider:=(v_config->>'provider_organization_id')::uuid;
  v_org:=(v_config->>'organization_id')::uuid;
  PERFORM pg_advisory_xact_lock(hashtextextended('patrol-plan-org:'||v_org,0));
  PERFORM 1 FROM public.service_agreements WHERE id=(v_config->>'service_agreement_id')::uuid FOR SHARE NOWAIT;
  PERFORM 1 FROM public.service_agreement_delivery_schedules WHERE id=(v_config->'contractual_terms'->>'id')::uuid FOR SHARE NOWAIT;
  PERFORM 1 FROM public.service_agreement_locations WHERE id=(v_config->>'service_agreement_location_id')::uuid FOR SHARE NOWAIT;
  PERFORM 1 FROM public.service_agreement_modules WHERE id=(v_config->>'service_agreement_module_id')::uuid FOR SHARE NOWAIT;
  PERFORM 1 FROM public.crm_commercial_settings WHERE service_agreement_id=(v_config->>'service_agreement_id')::uuid FOR SHARE NOWAIT;
  PERFORM 1 FROM public.rate_rules WHERE organization_id=v_provider AND id=(v_billing->>'rate_rule_id')::uuid FOR SHARE NOWAIT;
  PERFORM 1 FROM public.patrol_billing_units WHERE code=v_billing->>'billing_unit_code' FOR SHARE NOWAIT;
  PERFORM 1 FROM public.patrol_routes WHERE organization_id=v_org ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.roster_work_units WHERE organization_id=v_org ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.client_site_patrol_config WHERE id=(v_config->>'id')::uuid FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.patrol_route_stop_modules WHERE patrol_config_id=(v_config->>'id')::uuid FOR SHARE NOWAIT;
  v_preview:=public.preview_location_patrol_setup(p_location_id,p_changes);
  v_from:=(p_changes->>'effective_from')::date;
  FOR v_shift IN SELECT s.id FROM public.shifts s WHERE s.organization_id=v_org
    AND s.id IN(SELECT (item->>'shift_id')::uuid
      FROM jsonb_array_elements((v_preview->'affected')||(v_preview->'blocked')) item)
    ORDER BY s.id FOR UPDATE NOWAIT
  LOOP
    PERFORM 1 FROM public.shift_stops WHERE shift_id=v_shift.id ORDER BY id FOR UPDATE NOWAIT;
    PERFORM 1 FROM public.shift_stop_modules WHERE shift_stop_id IN(
      SELECT id FROM public.shift_stops WHERE shift_id=v_shift.id) ORDER BY id FOR SHARE NOWAIT;
  END LOOP;
  v_preview:=public.preview_location_patrol_setup(p_location_id,p_changes);
  IF v_preview->>'version' IS DISTINCT FROM p_expected_version
    OR v_preview->>'preview_fingerprint' IS DISTINCT FROM p_preview_fingerprint THEN
    RAISE EXCEPTION 'Patrol setup or future plans changed; reload and confirm a fresh preview' USING ERRCODE='40001';
  END IF;
  v_rate:=public.save_location_patrol_billing_selection(
    v_provider,p_location_id,p_client_request_id,(p_changes->>'service_agreement_location_id')::uuid,
    (p_changes->>'service_agreement_module_id')::uuid,v_billing->>'rate_type',v_billing->>'source',
    (v_billing->>'rate_rule_id')::uuid,v_from,(v_billing->>'expected_selection_id')::uuid,
    (v_billing->>'expected_updated_at')::timestamptz,v_billing->'new_rate',v_billing->>'billing_unit_code');
  SELECT * INTO v_previous FROM public.patrol_config_responsibilities WHERE patrol_config_id=(v_config->>'id')::uuid
    AND superseded_at IS NULL ORDER BY effective_from DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE public.patrol_config_responsibilities SET
      effective_to=CASE WHEN effective_from<v_from THEN v_from-1 ELSE effective_to END,
      superseded_at=CASE WHEN effective_from=v_from THEN clock_timestamp() ELSE NULL END WHERE id=v_previous.id;
  END IF;
  INSERT INTO public.patrol_config_responsibilities(organization_id,patrol_config_id,patrol_route_id,work_unit_id,
    service_agreement_location_id,service_agreement_module_id,rate_selection_id,effective_from,created_by)
  VALUES(v_org,(v_config->>'id')::uuid,(p_changes->>'patrol_route_id')::uuid,(p_changes->>'work_unit_id')::uuid,
    (p_changes->>'service_agreement_location_id')::uuid,(p_changes->>'service_agreement_module_id')::uuid,
    (v_rate->'selection'->>'id')::uuid,v_from,auth.uid()) RETURNING id INTO v_id;
  FOR v_shift IN SELECT s.id,s.scheduled_start FROM public.shifts s WHERE s.id IN(
    SELECT (a->>'shift_id')::uuid FROM jsonb_array_elements(v_preview->'affected') a) ORDER BY s.id
  LOOP
    PERFORM public.generate_shift_stops_internal(v_shift.id,
      (v_shift.scheduled_start AT TIME ZONE 'Pacific/Auckland')::date,(v_config->>'id')::uuid);
  END LOOP;
  v_receipt:=jsonb_build_object('client_request_id',p_client_request_id,'location_id',p_location_id,
    'responsibility_id',v_id,'billing',v_rate,'affected',v_preview->'affected','blocked',v_preview->'blocked','replayed',false);
  INSERT INTO public.location_patrol_setup_receipts(client_request_id,organization_id,operating_organization_id,
    location_id,actor_id,request_fingerprint,receipt)
    VALUES(p_client_request_id,v_provider,v_org,p_location_id,auth.uid(),v_fingerprint,v_receipt);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
    VALUES(v_org,auth.uid(),'location_patrol_setup_saved','patrol_config_responsibilities',v_id,
      jsonb_build_object('client_request_id',p_client_request_id,'location_id',p_location_id,
        'patrol_config_id',v_config->>'id','patrol_route_id',p_changes->>'patrol_route_id',
        'effective_from',v_from,'previous_responsibility_id',v_previous.id,
        'preview_fingerprint',p_preview_fingerprint,
        'changed_shift_count',jsonb_array_length(v_preview->'affected'),
        'preserved_shift_count',jsonb_array_length(v_preview->'blocked')));
  RETURN v_receipt;
END;
$function$;
REVOKE ALL ON FUNCTION public.save_location_patrol_setup(uuid,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.save_location_patrol_setup(uuid,uuid,text,text,jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.preview_work_unit_coverage(p_work_unit_id uuid,p_shift_date date,
  p_scheduled_start timestamptz DEFAULT NULL,p_scheduled_end timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='public'
AS $function$
DECLARE
  v_unit public.roster_work_units%rowtype;
  v_dow integer:=extract(isodow FROM p_shift_date)::integer;
  v_month integer:=extract(month FROM p_shift_date)::integer;
  v_stop_count integer:=0; v_config_count integer:=0; v_days integer[]:='{}';
  v_place_name text; v_place_kind text; v_boundary_verified boolean:=false;
  v_window_start time; v_window_end time; v_visits_max integer:=1; v_min_gap integer:=0;
  v_outside_window boolean:=false; v_too_short boolean:=false; v_cfg record;
  v_open timestamptz; v_close timestamptz; v_eff_open timestamptz; v_eff_close timestamptz;
  v_overlaps integer:=0; v_windowed integer:=0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_shift_date IS NULL THEN RAISE EXCEPTION 'A shift date is required'; END IF;
  SELECT * INTO v_unit FROM public.roster_work_units w WHERE w.id=p_work_unit_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Work unit not found'; END IF;
  IF NOT(public.is_admin_for_org(v_unit.organization_id) OR public.user_can_operate_organization(v_unit.organization_id)) THEN
    RAISE EXCEPTION 'Not authorised to roster this work unit';
  END IF;
  IF v_unit.work_unit_type='patrol' THEN
    SELECT coalesce(sum(CASE WHEN (array_length(c.active_days,1) IS NULL OR v_dow=ANY(c.active_days))
      AND (array_length(c.active_months,1) IS NULL OR cardinality(c.active_months)=0 OR v_month=ANY(c.active_months))
      THEN coalesce(c.visits_per_shift,1) ELSE 0 END),0)::integer,count(*)::integer,
      min(c.window_start) FILTER(WHERE c.time_window_type='fixed'),
      max(c.window_end) FILTER(WHERE c.time_window_type='fixed'),
      coalesce(max(c.visits_per_shift),1),coalesce(max(c.min_gap_between_visits_minutes),0)
    INTO v_stop_count,v_config_count,v_window_start,v_window_end,v_visits_max,v_min_gap
    FROM public.client_site_patrol_config c
    WHERE c.organization_id=v_unit.organization_id AND c.active AND c.time_window_type<>'as_attended'
      AND public.patrol_config_route_at(c.id,p_shift_date)=v_unit.patrol_route_id;
    SELECT coalesce(array_agg(DISTINCT d ORDER BY d),'{}') INTO v_days
    FROM public.client_site_patrol_config c
    CROSS JOIN LATERAL unnest(CASE WHEN array_length(c.active_days,1) IS NULL
      THEN '{1,2,3,4,5,6,7}'::integer[] ELSE c.active_days END) d
    WHERE c.organization_id=v_unit.organization_id AND c.active AND c.time_window_type<>'as_attended'
      AND public.patrol_config_route_at(c.id,p_shift_date)=v_unit.patrol_route_id;
    IF p_scheduled_start IS NOT NULL AND p_scheduled_end IS NOT NULL AND p_scheduled_end>p_scheduled_start THEN
      FOR v_cfg IN SELECT c.* FROM public.client_site_patrol_config c
        WHERE c.organization_id=v_unit.organization_id AND c.active AND c.time_window_type<>'as_attended'
          AND public.patrol_config_route_at(c.id,p_shift_date)=v_unit.patrol_route_id
          AND (array_length(c.active_days,1) IS NULL OR v_dow=ANY(c.active_days))
          AND (array_length(c.active_months,1) IS NULL OR cardinality(c.active_months)=0 OR v_month=ANY(c.active_months))
      LOOP
        IF v_cfg.time_window_type='fixed' AND v_cfg.window_start IS NOT NULL THEN
          v_windowed:=v_windowed+1;
          SELECT b.window_open,b.window_close INTO v_open,v_close FROM public.patrol_window_bounds(
            p_shift_date,v_cfg.window_start,v_cfg.window_end,p_scheduled_start,p_scheduled_end) b;
          v_eff_open:=greatest(v_open,p_scheduled_start);
          v_eff_close:=least(coalesce(v_close,p_scheduled_end),p_scheduled_end);
          IF v_eff_close>v_eff_open THEN
            v_overlaps:=v_overlaps+1;
            IF coalesce(v_cfg.visits_per_shift,1)>1
              AND extract(epoch FROM(v_eff_close-v_eff_open))/60
                <(coalesce(v_cfg.visits_per_shift,1)-1)*coalesce(v_cfg.min_gap_between_visits_minutes,0) THEN
              v_too_short:=true;
            END IF;
          END IF;
        ELSIF coalesce(v_cfg.visits_per_shift,1)>1
          AND extract(epoch FROM(p_scheduled_end-p_scheduled_start))/60
            <(coalesce(v_cfg.visits_per_shift,1)-1)*coalesce(v_cfg.min_gap_between_visits_minutes,0) THEN
          v_too_short:=true;
        END IF;
      END LOOP;
      v_outside_window:=v_windowed>0 AND v_overlaps=0;
    END IF;
    RETURN jsonb_build_object('kind','patrol','day_of_week',v_dow,'stop_count',v_stop_count,
      'config_count',v_config_count,'contracted_days',to_jsonb(v_days),'has_route',v_unit.patrol_route_id IS NOT NULL,
      'window_start',to_char(v_window_start,'HH24:MI'),'window_end',to_char(v_window_end,'HH24:MI'),
      'visits_max',v_visits_max,'min_gap_minutes',v_min_gap,'outside_window',v_outside_window,
      'too_short_for_visits',v_too_short,'ok',v_stop_count>0 AND NOT v_outside_window);
  ELSIF v_unit.work_unit_type='static' THEN
    SELECT coalesce(s.name,z.name),CASE WHEN s.id IS NOT NULL THEN 'site' WHEN z.id IS NOT NULL THEN 'zone' ELSE NULL END,
      s.id IS NOT NULL AND s.active AND s.boundary IS NOT NULL AND s.boundary_verification='verified'
        AND st_isvalid(s.boundary) AND NOT st_isempty(s.boundary)
    INTO v_place_name,v_place_kind,v_boundary_verified
    FROM public.service_agreement_locations sal
    LEFT JOIN public.client_sites s ON s.id=sal.site_id LEFT JOIN public.location_zones z ON z.id=sal.zone_id
    WHERE sal.id=v_unit.service_agreement_location_id;
    RETURN jsonb_build_object('kind','static','place_name',v_place_name,'place_kind',v_place_kind,
      'boundary_verified',coalesce(v_boundary_verified,false),
      'has_module',v_unit.service_agreement_module_id IS NOT NULL,
      'ok',coalesce(v_boundary_verified,false) AND v_unit.service_agreement_module_id IS NOT NULL);
  END IF;
  RETURN jsonb_build_object('kind',coalesce(v_unit.work_unit_type,'internal'),'ok',true);
END;
$function$;
REVOKE ALL ON FUNCTION public.preview_work_unit_coverage(uuid,date,timestamptz,timestamptz) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.preview_work_unit_coverage(uuid,date,timestamptz,timestamptz) TO authenticated,service_role;
