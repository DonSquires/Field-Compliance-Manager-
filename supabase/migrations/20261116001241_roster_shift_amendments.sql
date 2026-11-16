CREATE INDEX IF NOT EXISTS audit_log_roster_amendment_request_idx
  ON public.audit_log(organization_id,(metadata->>'client_request_id'))
  WHERE action IN ('roster_slot_amended','roster_slot_handover');
CREATE INDEX IF NOT EXISTS audit_log_roster_handover_replacement_idx
  ON public.audit_log((metadata->'receipt'->>'replacement_slot_id'),created_at DESC)
  WHERE action = 'roster_slot_handover' AND target_table = 'roster_slots';

CREATE OR REPLACE FUNCTION public.get_roster_slot_edit_context(p_slot_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_context jsonb;
  v_shift_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles p
    WHERE p.id = auth.uid() AND p.deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Active roster administrator access required' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'slot', to_jsonb(s),
    'work_unit', jsonb_build_object('id',u.id,'name',u.name,'work_unit_type',u.work_unit_type),
    'shift', CASE WHEN sh.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', sh.id, 'organization_id', sh.organization_id, 'officer_user_id', sh.officer_user_id,
      'status', sh.status, 'scheduled_start', sh.scheduled_start, 'scheduled_end', sh.scheduled_end,
      'actual_start', sh.actual_start, 'actual_end', sh.actual_end, 'updated_at', sh.updated_at
    ) END,
    'contact', CASE WHEN c.roster_slot_id IS NULL THEN NULL ELSE jsonb_build_object(
      'contact_name', c.contact_name, 'contact_phone', c.contact_phone, 'version', c.version
    ) END,
    'finish_preview', NULL
  ) INTO v_context
  FROM public.roster_slots s
  JOIN public.roster_work_units u ON u.id = s.work_unit_id AND u.organization_id = s.organization_id
  LEFT JOIN public.shifts sh ON sh.id = s.linked_shift_id AND sh.organization_id = s.organization_id
  LEFT JOIN public.roster_slot_contacts c ON c.roster_slot_id = s.id
  WHERE s.id = p_slot_id
    AND public.is_admin_for_org(s.organization_id)
    AND public.user_can_operate_organization(s.organization_id);

  IF v_context IS NULL THEN
    RAISE EXCEPTION 'Roster slot not found or administrator access denied' USING ERRCODE = '42501';
  END IF;
  IF v_context #>> '{slot,linked_shift_id}' IS NOT NULL AND v_context->'shift' = 'null'::jsonb THEN
    RAISE EXCEPTION 'Linked field shift not found at the operating organisation';
  END IF;
  IF v_context #>> '{shift,status}' = 'in_progress'
    AND v_context #>> '{shift,actual_start}' IS NOT NULL
    AND v_context #>> '{shift,actual_end}' IS NULL THEN
    v_shift_id := (v_context #>> '{shift,id}')::uuid;
    v_context := jsonb_set(v_context, '{finish_preview}', public.get_admin_shift_finish_preview(v_shift_id));
  END IF;
  RETURN v_context;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_roster_slot_edit_context(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_roster_slot_edit_context(uuid) TO authenticated;
COMMENT ON FUNCTION public.get_roster_slot_edit_context(uuid) IS
  'Active operating-organisation roster administrators: versioned planned slot, linked attendance, private contact and live finish dependencies before a governed amendment. Read-only; no attendance or commercial records are changed.';

CREATE OR REPLACE FUNCTION public.staff_fatigue_conflict(
  p_staff_id uuid,p_scheduled_start timestamptz,p_scheduled_end timestamptz,p_exclude_slot_id uuid DEFAULT NULL
) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_org uuid;
  v_rules public.organization_fatigue_rules%rowtype;
  v_load record;
  v_source public.roster_slots%rowtype;
  v_previous uuid;
  v_start timestamptz := p_scheduled_start;
  v_boundary timestamptz := p_scheduled_start;
  v_context jsonb := nullif(current_setting('fcm.roster_handover_request',true),'')::jsonb;
BEGIN
  SELECT organization_id INTO v_org FROM public.staff_profiles WHERE id = p_staff_id;
  IF v_org IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_rules FROM public.organization_fatigue_rules WHERE organization_id = v_org;
  IF NOT FOUND OR NOT v_rules.enforced THEN RETURN NULL; END IF;
  SELECT least(p_scheduled_start,sh.actual_start),s.scheduled_start INTO v_start,v_boundary
    FROM public.roster_slots s JOIN public.shifts sh ON sh.id = s.linked_shift_id
      JOIN public.staff_profiles p ON p.id = s.staff_id
    WHERE s.id = p_exclude_slot_id AND s.staff_id = p_staff_id
      AND sh.officer_user_id = coalesce(p.user_id,p.id) AND sh.organization_id = s.organization_id
      AND sh.status = 'in_progress' AND sh.actual_start IS NOT NULL AND sh.actual_end IS NULL;
  IF NOT FOUND THEN v_start := p_scheduled_start; v_boundary := p_scheduled_start; END IF;
  SELECT a.target_id INTO v_previous FROM public.audit_log a
    WHERE a.action = 'roster_slot_handover' AND a.target_table = 'roster_slots'
      AND a.metadata->'receipt'->>'replacement_slot_id' = p_exclude_slot_id::text
    ORDER BY a.created_at DESC LIMIT 1;
  IF v_previous IS NULL AND v_context IS NOT NULL THEN
    SELECT s.id INTO v_previous FROM public.roster_slots s
      JOIN public.shifts sh ON sh.id = s.linked_shift_id
      JOIN public.audit_log a ON a.target_id = sh.id AND a.action = 'officer_shift_finished_by_admin'
    WHERE s.id = (v_context->>'slot_id')::uuid AND s.staff_id = p_staff_id
      AND a.organization_id = s.organization_id AND a.actor_user_id = auth.uid()
      AND a.metadata->>'client_request_id' = v_context->>'request_id'
      AND a.created_at >= transaction_timestamp() AND sh.actual_end = p_scheduled_start
      AND public.is_admin_for_org(s.organization_id);
  END IF;
  -- Only audited, exactly contiguous segments of the same person's duty share a rest interval.
  WHILE v_previous IS NOT NULL LOOP
    SELECT s.* INTO v_source FROM public.roster_slots s JOIN public.shifts sh ON sh.id = s.linked_shift_id
      WHERE s.id = v_previous AND s.staff_id = p_staff_id AND s.status = 'completed'
        AND sh.status = 'completed' AND sh.actual_end = v_boundary AND s.scheduled_end = v_boundary
        AND s.scheduled_start < v_boundary;
    EXIT WHEN NOT FOUND;
    v_start := least(v_start,v_source.scheduled_start,(SELECT actual_start FROM public.shifts WHERE id = v_source.linked_shift_id));
    v_boundary := v_source.scheduled_start;
    SELECT a.target_id INTO v_previous FROM public.audit_log a
      WHERE a.action = 'roster_slot_handover' AND a.target_table = 'roster_slots'
        AND a.metadata->'receipt'->>'replacement_slot_id' = v_source.id::text
      ORDER BY a.created_at DESC LIMIT 1;
  END LOOP;
  SELECT * INTO v_load FROM public.roster_assignment_load(p_staff_id,v_start,p_scheduled_end,p_exclude_slot_id);
  IF v_load.rest_hours IS NOT NULL AND v_load.rest_hours < v_rules.min_rest_hours_between_shifts THEN
    RETURN format('Only %s hours'' rest from the nearest other shift; this organisation requires %s',
      trim_scale(v_load.rest_hours),trim_scale(v_rules.min_rest_hours_between_shifts));
  END IF;
  IF v_load.week_hours > v_rules.max_hours_per_week THEN
    RETURN format('%s hours in the week starting %s, over the %s-hour limit',
      trim_scale(v_load.week_hours),to_char(v_load.week_start,'DD Mon'),trim_scale(v_rules.max_hours_per_week));
  END IF;
  IF v_load.consecutive_days > v_rules.max_consecutive_days THEN
    RETURN format('Day %s in a row, over the limit of %s',v_load.consecutive_days,v_rules.max_consecutive_days);
  END IF;
  RETURN NULL;
END;
$function$;
REVOKE ALL ON FUNCTION public.staff_fatigue_conflict(uuid,timestamptz,timestamptz,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.staff_fatigue_conflict(uuid,timestamptz,timestamptz,uuid) TO postgres,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.amend_roster_slot(
  p_client_request_id uuid, p_slot_id uuid, p_expected_updated_at timestamptz,
  p_expected_shift_updated_at timestamptz, p_changes jsonb, p_reason text,
  p_handover_at timestamptz DEFAULT NULL, p_officer_safety_confirmed boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '3s'
AS $function$
DECLARE
  v_slot public.roster_slots%rowtype;
  v_shift public.shifts%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_staff public.staff_profiles%rowtype;
  v_profile public.user_profiles%rowtype;
  v_contact public.roster_slot_contacts%rowtype;
  v_existing public.audit_log%rowtype;
  v_replacement public.roster_slots%rowtype;
  v_replacement_shift public.shifts%rowtype;
  v_stop public.shift_stops%rowtype;
  v_new_stop uuid;
  v_remaining uuid[];
  v_staff_id uuid;
  v_unit_id uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_break integer;
  v_unpaid boolean;
  v_notes text;
  v_reason text := nullif(btrim(p_reason), '');
  v_contact_version uuid;
  v_before jsonb;
  v_hash text;
  v_receipt jsonb;
  v_finish jsonb;
  v_live boolean;
  v_dimensions boolean;
  v_handover boolean;
  v_branch_authorized boolean;
  v_user uuid;
  v_keys text[] := ARRAY['staff_id','work_unit_id','scheduled_start','scheduled_end',
    'planned_break_minutes','break_unpaid','notes','contact_name','contact_phone','expected_contact_version'];
BEGIN
  IF p_client_request_id IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication and a request ID are required' USING ERRCODE = '42501';
  END IF;
  PERFORM public.get_roster_slot_edit_context(p_slot_id);
  SELECT * INTO v_slot FROM public.roster_slots WHERE id = p_slot_id;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'roster_amendment:' || v_slot.organization_id::text || ':' || p_client_request_id::text, 0));
  SELECT * INTO v_slot FROM public.roster_slots WHERE id = p_slot_id FOR UPDATE;
  IF NOT public.is_admin_for_org(v_slot.organization_id)
    OR NOT public.user_can_operate_organization(v_slot.organization_id) THEN
    RAISE EXCEPTION 'Roster administrator access required' USING ERRCODE = '42501';
  END IF;
  v_hash := encode(pg_catalog.sha256(pg_catalog.convert_to(jsonb_build_object(
    'actor',auth.uid(),'slot',p_slot_id,'version',p_expected_updated_at,
    'shift_version',p_expected_shift_updated_at,'changes',p_changes,'reason',v_reason,
    'handover_at',p_handover_at,'safety',p_officer_safety_confirmed)::text,'UTF8')),'hex');
  SELECT * INTO v_existing FROM public.audit_log
  WHERE organization_id = v_slot.organization_id AND action IN ('roster_slot_amended','roster_slot_handover')
    AND metadata->>'client_request_id' = p_client_request_id::text
  ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_existing.target_id IS DISTINCT FROM p_slot_id OR v_existing.metadata->>'request_hash' IS DISTINCT FROM v_hash THEN
      RAISE EXCEPTION 'Request ID already used with different amendment details';
    END IF;
    RETURN (v_existing.metadata->'receipt') || jsonb_build_object('replayed',true);
  END IF;
  IF EXISTS(SELECT 1 FROM public.roster_slots WHERE organization_id = v_slot.organization_id
    AND client_request_id = p_client_request_id) THEN
    RAISE EXCEPTION 'Request ID already used to create a roster slot';
  END IF;
  IF v_slot.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'Roster slot changed; reload before saving';
  END IF;
  IF v_slot.status NOT IN ('draft','published','accepted','declined')
    OR v_slot.external_refs->>'source' = 'rm_patrol_log_labour'
    OR v_slot.external_refs @> '{"historical_only":true}'::jsonb THEN
    RAISE EXCEPTION 'Completed, cancelled or historical source records cannot be amended';
  END IF;
  IF v_reason IS NULL OR length(v_reason) NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'A reason of 5 to 1000 characters is required';
  END IF;
  IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' OR NOT (p_changes ?& v_keys) THEN
    RAISE EXCEPTION 'All planned fields and contact versions are required';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_changes) k WHERE k <> ALL(v_keys)) THEN
    RAISE EXCEPTION 'Unsupported amendment field';
  END IF;
  IF jsonb_typeof(p_changes->'staff_id') NOT IN ('string','null')
    OR jsonb_typeof(p_changes->'work_unit_id') <> 'string'
    OR jsonb_typeof(p_changes->'scheduled_start') <> 'string'
    OR jsonb_typeof(p_changes->'scheduled_end') <> 'string'
    OR jsonb_typeof(p_changes->'planned_break_minutes') <> 'number'
    OR jsonb_typeof(p_changes->'break_unpaid') <> 'boolean'
    OR jsonb_typeof(p_changes->'notes') NOT IN ('string','null')
    OR jsonb_typeof(p_changes->'contact_name') NOT IN ('string','null')
    OR jsonb_typeof(p_changes->'contact_phone') NOT IN ('string','null')
    OR jsonb_typeof(p_changes->'expected_contact_version') NOT IN ('string','null') THEN
    RAISE EXCEPTION 'Invalid planned field type';
  END IF;
  IF (p_changes->>'planned_break_minutes')::numeric <> trunc((p_changes->>'planned_break_minutes')::numeric)
    OR (p_changes->>'planned_break_minutes')::numeric NOT BETWEEN 0 AND 240 THEN
    RAISE EXCEPTION 'Planned break must be a whole number from 0 to 240 minutes';
  END IF;
  v_staff_id := (p_changes->>'staff_id')::uuid;
  v_unit_id := (p_changes->>'work_unit_id')::uuid;
  v_start := (p_changes->>'scheduled_start')::timestamptz;
  v_end := (p_changes->>'scheduled_end')::timestamptz;
  v_break := (p_changes->>'planned_break_minutes')::integer;
  v_unpaid := (p_changes->>'break_unpaid')::boolean;
  v_notes := nullif(btrim(p_changes->>'notes'),'');
  v_contact_version := (p_changes->>'expected_contact_version')::uuid;
  IF NOT isfinite(v_start) OR NOT isfinite(v_end) OR v_end <= v_start
    OR v_end-v_start > interval '24 hours' OR v_break >= extract(epoch FROM v_end-v_start)/60 THEN
    RAISE EXCEPTION 'Invalid shift times or planned break allowance';
  END IF;
  IF v_slot.linked_shift_id IS NOT NULL THEN
    -- Finish takes the reverse row-lock order; never wait on its shift while holding its slot.
    SELECT * INTO v_shift FROM public.shifts WHERE id = v_slot.linked_shift_id
      AND organization_id = v_slot.organization_id FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RAISE EXCEPTION 'Linked field shift not found'; END IF;
    IF v_shift.updated_at IS DISTINCT FROM p_expected_shift_updated_at THEN
      RAISE EXCEPTION 'Field shift changed; reload before saving';
    END IF;
    IF v_shift.actual_end IS NOT NULL OR v_shift.status IN ('completed','cancelled','missed') THEN
      RAISE EXCEPTION 'Completed attendance cannot be amended';
    END IF;
  ELSIF p_expected_shift_updated_at IS NOT NULL THEN
    RAISE EXCEPTION 'Field shift changed; reload before saving';
  END IF;
  SELECT * INTO v_contact FROM public.roster_slot_contacts WHERE roster_slot_id = v_slot.id;
  IF v_contact.version IS DISTINCT FROM v_contact_version THEN
    RAISE EXCEPTION 'Shift contact changed; reload before saving';
  END IF;
  SELECT * INTO v_unit FROM public.roster_work_units WHERE id = v_unit_id AND organization_id = v_slot.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Authorized work unit required'; END IF;
  v_live := v_shift.status = 'in_progress' AND v_shift.actual_start IS NOT NULL;
  v_live := coalesce(v_live,false);
  v_dimensions := v_staff_id IS DISTINCT FROM v_slot.staff_id OR v_unit_id IS DISTINCT FROM v_slot.work_unit_id
    OR v_start IS DISTINCT FROM v_slot.scheduled_start OR v_end IS DISTINCT FROM v_slot.scheduled_end;
  v_handover := v_live AND (v_staff_id IS DISTINCT FROM v_slot.staff_id OR v_unit_id IS DISTINCT FROM v_slot.work_unit_id);
  IF v_dimensions AND v_staff_id IS NOT NULL THEN
    SELECT coalesce(user_id,id) INTO v_user FROM public.staff_profiles WHERE id = v_staff_id;
    IF v_user IS NOT NULL AND NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended('roster_staff:' || v_user::text,0)) THEN
      RAISE EXCEPTION 'Concurrent staff assignment; reload and retry' USING ERRCODE = '55P03';
    END IF;
  END IF;
  IF NOT v_handover AND (p_handover_at IS NOT NULL OR coalesce(p_officer_safety_confirmed,false)) THEN
    RAISE EXCEPTION 'Handover confirmation applies only to a change in live responsibility';
  END IF;
  IF v_unit.work_unit_type <> 'static'
    AND (nullif(btrim(p_changes->>'contact_name'),'') IS NOT NULL OR nullif(btrim(p_changes->>'contact_phone'),'') IS NOT NULL) THEN
    RAISE EXCEPTION 'Shift contact applies only to a static work unit';
  END IF;
  v_before := to_jsonb(v_slot);
  IF v_dimensions THEN
    IF NOT v_unit.active THEN RAISE EXCEPTION 'Active work unit required'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.organizations WHERE id = v_slot.organization_id AND active) THEN
      RAISE EXCEPTION 'Operating organisation not found';
    END IF;
    IF v_staff_id IS NOT NULL THEN
      SELECT * INTO v_staff FROM public.staff_profiles WHERE id = v_staff_id AND work_ready;
      IF NOT FOUND THEN RAISE EXCEPTION 'Work-ready authorized staff profile required'; END IF;
      v_user := coalesce(v_staff.user_id,v_staff.id);
      SELECT EXISTS(SELECT 1 FROM public.staff_branch_authorisations a
        WHERE a.user_id = v_user AND a.branch_org_id = v_slot.organization_id
          AND a.status = 'active' AND a.can_be_rostered
          AND (a.starts_on IS NULL OR a.starts_on <= current_date)
          AND (a.ends_on IS NULL OR a.ends_on >= current_date)) INTO v_branch_authorized;
      IF v_staff.organization_id IS DISTINCT FROM v_slot.organization_id AND NOT v_branch_authorized THEN
        RAISE EXCEPTION 'Work-ready authorized staff profile required';
      END IF;
      IF v_unit.work_unit_type IN ('patrol','static') THEN
        SELECT * INTO v_profile FROM public.user_profiles WHERE id = v_user
          AND organization_id IS NOT NULL AND deactivated_at IS NULL AND role IN ('officer','admin_officer');
        IF NOT FOUND THEN RAISE EXCEPTION 'Active field officer required'; END IF;
        IF v_profile.organization_id IS DISTINCT FROM v_slot.organization_id AND NOT v_branch_authorized THEN
          RAISE EXCEPTION 'Officer is not authorized to be rostered at this branch';
        END IF;
        IF nullif(btrim(v_unit.service_type),'') IS NULL THEN RAISE EXCEPTION 'Service type is required'; END IF;
      END IF;
      IF EXISTS(SELECT 1 FROM public.leave_requests l WHERE l.staff_id = v_staff_id AND l.status = 'approved'
        AND daterange(l.starts_on,l.ends_on,'[]') && daterange(v_start::date,v_end::date,'[]')) THEN
        RAISE EXCEPTION 'Staff member has approved leave';
      END IF;
    END IF;
    IF v_unit.work_unit_type = 'static' AND NOT EXISTS(
      SELECT 1 FROM public.service_agreement_locations l
        JOIN public.service_agreement_modules m ON m.service_agreement_id = l.service_agreement_id
      WHERE l.id = v_unit.service_agreement_location_id AND l.status = 'active'
        AND m.id = v_unit.service_agreement_module_id AND m.enabled AND m.module_key = 'static_guarding'
    ) THEN RAISE EXCEPTION 'Static work unit contract is no longer active'; END IF;
  END IF;

  IF v_handover THEN
    IF p_handover_at IS NULL OR p_handover_at <= v_shift.actual_start
      OR p_handover_at > clock_timestamp() OR p_handover_at < now()-interval '5 minutes'
      OR v_start IS DISTINCT FROM p_handover_at OR v_end <= p_handover_at OR v_staff_id IS NULL THEN
      RAISE EXCEPTION 'Choose an assigned replacement starting at the confirmed current handover time';
    END IF;
    SELECT array_agg(id) INTO v_remaining FROM (
      SELECT id FROM public.shift_stops
      WHERE shift_id = v_shift.id AND status IN ('pending','en_route') AND dispatch_job_id IS NULL
      ORDER BY id FOR UPDATE NOWAIT
    ) outstanding;
    v_finish := public.record_admin_shift_attendance(p_client_request_id,v_shift.id,v_shift.updated_at,
      'admin_finish',p_handover_at,v_reason,false,p_officer_safety_confirmed);
    UPDATE public.roster_slots SET
      scheduled_start = least(scheduled_start,v_shift.actual_start),
      scheduled_end = p_handover_at,
      planned_break_minutes = least(planned_break_minutes,greatest(0,
        ceil(extract(epoch FROM p_handover_at-least(scheduled_start,v_shift.actual_start))/60)::integer-1))
      WHERE id = v_slot.id;
    UPDATE public.shifts SET scheduled_start = least(scheduled_start,actual_start), scheduled_end = p_handover_at
      WHERE id = v_shift.id;
    PERFORM set_config('fcm.roster_handover_request',
      jsonb_build_object('slot_id',v_slot.id,'request_id',p_client_request_id)::text,true);
    SELECT * INTO v_replacement FROM public.create_roster_slot_with_break(
      p_client_request_id,v_unit_id,v_staff_id,v_start,v_end,false,v_notes,v_break,v_unpaid);
    IF v_unit.work_unit_type = 'patrol' AND v_unit_id = v_slot.work_unit_id THEN
      -- Link on insertion for overlap checks, without materializing the full route again.
      INSERT INTO public.shifts(organization_id,officer_user_id,service_type,patrol_route_id,
        scheduled_start,scheduled_end,status,notes,roster_slot_id)
      VALUES(v_slot.organization_id,v_user,btrim(v_unit.service_type),v_unit.patrol_route_id,
        v_start,v_end,'published',v_notes,v_replacement.id)
      RETURNING * INTO v_replacement_shift;
      INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
      VALUES(v_slot.organization_id,auth.uid(),'roster_shift_created','shifts',v_replacement_shift.id,
        jsonb_build_object('officer_user_id',v_user,'officer_home_organization_id',v_profile.organization_id,
          'staff_id',v_staff.id,'scheduled_start',v_start,'scheduled_end',v_end,'status','published',
          'handover_source_shift_id',v_shift.id));
      FOR v_stop IN SELECT * FROM public.shift_stops WHERE id = ANY(coalesce(v_remaining,'{}'::uuid[]))
        ORDER BY stop_order,id LOOP
        INSERT INTO public.shift_stops(organization_id,shift_id,patrol_config_id,site_id,zone_id,module_key,
          stop_order,visit_number,is_adhoc,sla_window_open,sla_arrive_by,sla_depart_by,required_dwell_minutes,
          officer_instructions,external_refs)
        VALUES(v_slot.organization_id,v_replacement_shift.id,v_stop.patrol_config_id,v_stop.site_id,v_stop.zone_id,
          v_stop.module_key,v_stop.stop_order,v_stop.visit_number,v_stop.is_adhoc,v_stop.sla_window_open,
          v_stop.sla_arrive_by,v_stop.sla_depart_by,v_stop.required_dwell_minutes,v_stop.officer_instructions,
          jsonb_build_object('handover_source_shift_id',v_shift.id,'handover_source_stop_id',v_stop.id))
        RETURNING id INTO v_new_stop;
        INSERT INTO public.shift_stop_modules(organization_id,shift_stop_id,module_key,is_required,
          service_agreement_module_id,service_agreement_location_id)
        SELECT organization_id,v_new_stop,module_key,is_required,service_agreement_module_id,service_agreement_location_id
          FROM public.shift_stop_modules WHERE shift_stop_id = v_stop.id AND status IN ('pending','in_progress');
      END LOOP;
      UPDATE public.shifts SET total_stops = coalesce(cardinality(v_remaining),0),generated_at = clock_timestamp()
        WHERE id = v_replacement_shift.id;
      UPDATE public.roster_slots SET status = 'published',linked_shift_id = v_replacement_shift.id
        WHERE id = v_replacement.id;
    ELSE
      PERFORM public.manage_roster_slot(v_replacement.id,'draft','publish',v_reason);
    END IF;
    IF v_unit.work_unit_type = 'static' THEN
      PERFORM public.set_roster_slot_contact(v_replacement.id,'published',
        p_changes->>'contact_name',p_changes->>'contact_phone',NULL);
    END IF;
    SELECT * INTO v_replacement FROM public.roster_slots WHERE id = v_replacement.id;
    SELECT * INTO v_replacement_shift FROM public.shifts WHERE id = v_replacement.linked_shift_id;
    PERFORM set_config('fcm.roster_handover_request','',true);
  ELSE
    IF v_dimensions THEN
      IF NOT v_live AND v_start < now()-interval '5 minutes' THEN
        RAISE EXCEPTION 'Shift timing is outside the accepted publication range';
      END IF;
      IF v_staff_id IS NOT NULL THEN
        IF EXISTS(SELECT 1 FROM public.roster_slots s
          LEFT JOIN public.shifts sh ON sh.id = s.linked_shift_id AND sh.status = 'completed'
          WHERE s.id <> v_slot.id AND s.staff_id = v_staff_id AND s.status NOT IN ('declined','cancelled')
            AND coalesce(sh.actual_start,s.scheduled_start) < v_end
            AND coalesce(sh.actual_end,s.scheduled_end) > v_start) THEN
          RAISE EXCEPTION 'Staff member already has an overlapping roster slot';
        END IF;
        IF EXISTS(SELECT 1 FROM public.shifts s WHERE s.id IS DISTINCT FROM v_shift.id
          AND s.officer_user_id = coalesce(v_staff.user_id,v_staff.id)
          AND s.status NOT IN ('declined','cancelled','missed')
          AND (CASE WHEN s.status = 'completed' THEN coalesce(s.actual_start,s.scheduled_start) ELSE s.scheduled_start END) < v_end
          AND (CASE WHEN s.status = 'completed' THEN coalesce(s.actual_end,s.scheduled_end) ELSE s.scheduled_end END) > v_start) THEN
          RAISE EXCEPTION 'Officer already has an overlapping field shift';
        END IF;
      END IF;
      IF v_shift.id IS NOT NULL AND NOT v_live THEN
        IF EXISTS(SELECT 1 FROM public.shift_stop_actions WHERE shift_id = v_shift.id)
          OR EXISTS(SELECT 1 FROM public.patrols WHERE shift_id = v_shift.id AND status = 'in_progress')
          OR EXISTS(SELECT 1 FROM public.dispatch_jobs WHERE shift_id = v_shift.id AND status NOT IN ('completed','cancelled'))
          OR EXISTS(SELECT 1 FROM public.shift_stops WHERE shift_id = v_shift.id
            AND (actual_arrived_at IS NOT NULL OR status NOT IN ('pending','skipped','cancelled'))) THEN
          RAISE EXCEPTION 'Recorded or active field work prevents replacing this unstarted shift';
        END IF;
        UPDATE public.shift_stop_modules m SET status = 'skipped',updated_at = clock_timestamp()
          FROM public.shift_stops s WHERE s.shift_id = v_shift.id AND m.shift_stop_id = s.id
            AND m.status IN ('pending','in_progress');
        UPDATE public.shift_stops SET status = 'cancelled',updated_at = clock_timestamp()
          WHERE shift_id = v_shift.id AND status = 'pending';
        UPDATE public.shifts SET status = 'cancelled',roster_slot_id = NULL WHERE id = v_shift.id;
      END IF;
      IF v_contact.roster_slot_id IS NOT NULL AND v_unit.work_unit_type <> 'static' THEN
        PERFORM public.set_roster_slot_contact(v_slot.id,v_slot.status,NULL,NULL,v_contact.version);
      END IF;
      UPDATE public.roster_slots SET staff_id = v_staff_id,work_unit_id = v_unit_id,
        scheduled_start = v_start,scheduled_end = v_end,planned_break_minutes = v_break,break_unpaid = v_unpaid,
        notes = v_notes,updated_at = clock_timestamp(),
        linked_shift_id = CASE WHEN v_live THEN linked_shift_id ELSE NULL END,
        status = CASE WHEN NOT v_live AND status <> 'draft' THEN 'published' ELSE status END
        WHERE id = v_slot.id RETURNING * INTO v_slot;
      IF NOT v_live AND v_slot.status = 'published' AND v_staff_id IS NOT NULL
        AND v_unit.work_unit_type IN ('patrol','static') THEN
        PERFORM public.materialize_roster_slot(v_slot.id,'published');
      END IF;
    ELSE
      UPDATE public.roster_slots SET planned_break_minutes = v_break,break_unpaid = v_unpaid,
        notes = v_notes,updated_at = clock_timestamp() WHERE id = v_slot.id RETURNING * INTO v_slot;
    END IF;
    IF v_live OR (NOT v_dimensions AND v_shift.id IS NOT NULL) THEN
      IF v_live AND v_end <= v_shift.actual_start THEN RAISE EXCEPTION 'Planned end must follow recorded attendance start'; END IF;
      UPDATE public.shifts SET scheduled_start = v_start,scheduled_end = v_end,notes = v_notes,updated_at = clock_timestamp()
        WHERE id = v_shift.id;
    END IF;
    IF v_unit.work_unit_type = 'static' THEN
      PERFORM public.set_roster_slot_contact(v_slot.id,v_slot.status,
        p_changes->>'contact_name',p_changes->>'contact_phone',v_contact_version);
    END IF;
  END IF;
  SELECT * INTO v_slot FROM public.roster_slots WHERE id = p_slot_id;
  SELECT * INTO v_shift FROM public.shifts WHERE id = v_slot.linked_shift_id;
  v_receipt := jsonb_build_object('client_request_id',p_client_request_id,
    'source',CASE WHEN v_handover THEN 'roster_slot_handover' ELSE 'roster_slot_amended' END,
    'slot_id',p_slot_id,'shift_id',v_shift.id,'slot_updated_at',v_slot.updated_at,'shift_updated_at',v_shift.updated_at,
    'replacement_slot_id',v_replacement.id,'replacement_shift_id',v_replacement_shift.id,
    'replacement_slot_updated_at',v_replacement.updated_at,'replacement_shift_updated_at',v_replacement_shift.updated_at,
    'released_dispatch_jobs',coalesce((v_finish->>'released_dispatch_jobs')::integer,0),
    'resolved_welfare_alerts',coalesce((v_finish->>'resolved_welfare_alerts')::integer,0),'replayed',false);
  INSERT INTO public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata)
  VALUES(v_slot.organization_id,auth.uid(),v_receipt->>'source','roster_slots',v_slot.id,
    jsonb_build_object('client_request_id',p_client_request_id,'request_hash',v_hash,'reason',v_reason,
      'previous',v_before,'resulting',to_jsonb(v_slot),'receipt',v_receipt));
  IF NOT v_handover AND v_staff_id IS NOT NULL THEN
    SELECT coalesce(user_id,id) INTO v_user FROM public.staff_profiles WHERE id = v_staff_id;
    PERFORM public.enqueue_notification(p_organization_id => v_slot.organization_id,p_category => 'roster',
      p_title => 'Shift plan updated',p_body => 'Operations amended your planned shift. Review your schedule and briefing.',
      p_severity => 'info',p_recipient_user_id => v_user,p_link_page => 'schedule',
      p_link_payload => jsonb_build_object('roster_slot_id',v_slot.id),
      p_dedup_key => 'roster_amendment:' || p_client_request_id::text);
  END IF;
  RETURN v_receipt;
END;
$function$;
REVOKE ALL ON FUNCTION public.amend_roster_slot(uuid,uuid,timestamptz,timestamptz,jsonb,text,timestamptz,boolean)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.amend_roster_slot(uuid,uuid,timestamptz,timestamptz,jsonb,text,timestamptz,boolean)
  TO authenticated;
COMMENT ON FUNCTION public.amend_roster_slot(uuid,uuid,timestamptz,timestamptz,jsonb,text,timestamptz,boolean) IS
  'Versioned, reasoned roster-plan amendment. Live officer/place changes atomically finish the original responsibility segment and publish a new, unstarted remainder; same-run patrol handovers carry only outstanding non-dispatch obligations. Actual evidence and existing financial snapshots are never reassigned. Request hashes and receipts are persisted in the org-scoped audit path.';

CREATE OR REPLACE FUNCTION public.enforce_roster_assignment_serialization()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $function$
DECLARE
  v_person uuid;
  v_slot_id uuid;
  v_shift_id uuid;
BEGIN
  IF NEW.status IN ('completed','cancelled','declined','missed') THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'roster_slots' THEN
    IF NEW.staff_id IS NULL THEN RETURN NEW; END IF;
    SELECT coalesce(user_id,id) INTO v_person FROM public.staff_profiles WHERE id = NEW.staff_id;
    v_slot_id := NEW.id;
    v_shift_id := NEW.linked_shift_id;
  ELSE
    v_person := NEW.officer_user_id;
    v_slot_id := NEW.roster_slot_id;
    v_shift_id := NEW.id;
  END IF;
  IF v_person IS NULL THEN RETURN NEW; END IF;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('roster_staff:' || v_person::text,0)) THEN
    RAISE EXCEPTION 'Concurrent staff assignment; reload and retry' USING ERRCODE = '55P03';
  END IF;
  IF EXISTS(
    SELECT 1 FROM public.roster_slots s JOIN public.staff_profiles p ON p.id = s.staff_id
      LEFT JOIN public.shifts sh ON sh.id = s.linked_shift_id AND sh.status = 'completed'
    WHERE s.id IS DISTINCT FROM v_slot_id
      AND (v_shift_id IS NULL OR s.linked_shift_id IS DISTINCT FROM v_shift_id)
      AND coalesce(p.user_id,p.id) = v_person AND s.status NOT IN ('declined','cancelled')
      AND coalesce(sh.actual_start,s.scheduled_start) < NEW.scheduled_end
      AND coalesce(sh.actual_end,s.scheduled_end) > NEW.scheduled_start
  ) THEN RAISE EXCEPTION 'Staff member already has an overlapping roster slot'; END IF;
  IF EXISTS(
    SELECT 1 FROM public.shifts s WHERE s.id IS DISTINCT FROM v_shift_id
      AND (v_slot_id IS NULL OR s.roster_slot_id IS DISTINCT FROM v_slot_id)
      AND s.officer_user_id = v_person AND s.status NOT IN ('declined','cancelled','missed')
      AND (CASE WHEN s.status = 'completed' THEN coalesce(s.actual_start,s.scheduled_start) ELSE s.scheduled_start END) < NEW.scheduled_end
      AND (CASE WHEN s.status = 'completed' THEN coalesce(s.actual_end,s.scheduled_end) ELSE s.scheduled_end END) > NEW.scheduled_start
  ) THEN RAISE EXCEPTION 'Officer already has an overlapping field shift'; END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_roster_assignment_serialization()
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.enforce_roster_assignment_serialization() TO postgres;
CREATE TRIGGER a_roster_slot_assignment_serialization
  BEFORE INSERT OR UPDATE OF staff_id,scheduled_start,scheduled_end,status ON public.roster_slots
  FOR EACH ROW EXECUTE FUNCTION public.enforce_roster_assignment_serialization();
CREATE TRIGGER a_field_shift_assignment_serialization
  BEFORE INSERT OR UPDATE OF officer_user_id,scheduled_start,scheduled_end,status ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_roster_assignment_serialization();

CREATE OR REPLACE FUNCTION public.enforce_roster_slot_availability()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE v_fatigue text;
BEGIN
  IF current_setting('fcm.historical_labour_import',true) = 'on'
    AND NEW.status = 'completed' AND NEW.scheduled_end <= now()
    AND NEW.external_refs->>'source' = 'rm_patrol_log_labour' THEN RETURN NEW; END IF;
  -- Closing evidenced attendance must not requalify the officer for work already done.
  IF TG_OP = 'UPDATE' AND NEW.status = 'completed'
    AND OLD.status IN ('published','accepted','completed')
    AND NEW.staff_id IS NOT DISTINCT FROM OLD.staff_id
    AND NEW.work_unit_id IS NOT DISTINCT FROM OLD.work_unit_id
    AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
    AND NEW.linked_shift_id IS NOT DISTINCT FROM OLD.linked_shift_id
    AND EXISTS(
      SELECT 1 FROM public.shifts s JOIN public.staff_profiles p ON p.id = NEW.staff_id
      WHERE s.id = NEW.linked_shift_id AND s.organization_id = NEW.organization_id
        AND s.officer_user_id = coalesce(p.user_id,p.id) AND s.status = 'completed'
        AND s.actual_start IS NOT NULL AND s.actual_end IS NOT NULL
        AND (
          (NEW.scheduled_start IS NOT DISTINCT FROM OLD.scheduled_start
            AND NEW.scheduled_end IS NOT DISTINCT FROM OLD.scheduled_end)
          OR (NEW.scheduled_start = least(OLD.scheduled_start,s.actual_start)
            AND NEW.scheduled_end = s.actual_end)
        )
    ) THEN RETURN NEW;
  END IF;
  IF NEW.staff_id IS NOT NULL AND NEW.status NOT IN ('declined','cancelled') THEN
    IF public.staff_has_roster_availability_conflict(NEW.staff_id,NEW.scheduled_start,NEW.scheduled_end) THEN
      RAISE EXCEPTION 'Staff member is unavailable during this roster slot';
    END IF;
    v_fatigue := public.staff_fatigue_conflict(NEW.staff_id,NEW.scheduled_start,NEW.scheduled_end,NEW.id);
    IF v_fatigue IS NOT NULL THEN RAISE EXCEPTION 'Fatigue rule breach: %',v_fatigue; END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_roster_slot_availability() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.enforce_roster_slot_availability() TO postgres,service_role;
