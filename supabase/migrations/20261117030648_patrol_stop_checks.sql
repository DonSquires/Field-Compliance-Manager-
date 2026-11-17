ALTER TABLE public.officer_record_photos
  ADD COLUMN shift_stop_id uuid REFERENCES public.shift_stops(id),
  DROP CONSTRAINT officer_record_photos_check,
  ADD CONSTRAINT officer_record_photos_check CHECK (num_nonnulls(field_report_id, incident_id, shift_stop_id) = 1),
  ADD CONSTRAINT officer_record_photos_shift_stop_hash_key UNIQUE (shift_stop_id, sha256_hash);

COMMENT ON TABLE public.officer_record_photos IS
  'Officer-owned source-photo links to exact reports, incidents or patrol stops. Private, unverified and pending privacy/Oracle review; never a client-publication grant.';

-- Extend the existing private, target-bound original-photo lane without changing
-- report/incident authorization or its privacy and provenance guarantees.
DO $patch$
DECLARE
  v_definition text;
  v_anchor text;
BEGIN
  v_definition := replace(pg_get_functiondef('public.officer_photo_target_context(text,uuid)'::regprocedure), chr(13), '');
  v_anchor := '  IF p_record_kind = ''field_report'' THEN';
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Photo target context changed; review patrol stop access before applying';
  END IF;
  v_definition := replace(v_definition, v_anchor, $replacement$
  IF p_record_kind = 'patrol_stop' THEN
    SELECT st.organization_id, s.id INTO v_org, v_shift
    FROM public.shift_stops st JOIN public.shifts s ON s.id = st.shift_id
    WHERE st.id = p_record_id AND st.organization_id = s.organization_id
      AND s.officer_user_id = v_user AND NOT st.is_adhoc
      AND st.dispatch_job_id IS NULL AND st.module_key <> 'static_guarding';
    IF v_org IS NULL THEN RAISE EXCEPTION 'Photo target is unavailable'; END IF;
    RETURN QUERY SELECT v_org, v_shift;
    RETURN;
  END IF;
  IF p_record_kind = 'field_report' THEN$replacement$);
  EXECUTE v_definition;

  v_definition := replace(pg_get_functiondef('public.officer_photo_path_allowed(text)'::regprocedure), chr(13), '');
  v_anchor := '(field_report|incident)';
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Photo path policy changed; review patrol stop paths before applying';
  END IF;
  EXECUTE replace(v_definition, v_anchor, '(field_report|incident|patrol_stop)');

  v_definition := replace(pg_get_functiondef('public.attach_officer_record_photo(text,uuid,text,text,timestamp with time zone)'::regprocedure), chr(13), '');
  v_anchor := replace($anchor$  ELSE
    PERFORM 1 FROM public.incidents WHERE id = p_record_id FOR SHARE;
    PERFORM 1 FROM public.dispatch_jobs WHERE id = (
      SELECT dispatch_job_id FROM public.incidents WHERE id = p_record_id
    ) FOR SHARE;
  END IF;$anchor$, chr(13), '');
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Photo registration locking changed; review patrol stop locking before applying';
  END IF;
  v_definition := replace(v_definition, v_anchor, $replacement$  ELSIF p_record_kind = 'incident' THEN
    PERFORM 1 FROM public.incidents WHERE id = p_record_id FOR SHARE;
    PERFORM 1 FROM public.dispatch_jobs WHERE id = (
      SELECT dispatch_job_id FROM public.incidents WHERE id = p_record_id
    ) FOR SHARE;
  ELSE
    BEGIN
      PERFORM 1 FROM public.shift_stops WHERE id = p_record_id FOR SHARE NOWAIT;
      PERFORM 1 FROM public.shifts WHERE id = v_shift FOR SHARE NOWAIT;
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'Shift is changing; refresh and retry' USING ERRCODE = '40001';
    END;
  END IF;$replacement$);
  v_anchor := 'organization_id,officer_id,field_report_id,incident_id,shift_id,evidence_id,';
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Photo registration columns changed; review patrol stop attribution before applying';
  END IF;
  v_definition := replace(v_definition, v_anchor,
    'organization_id,officer_id,field_report_id,incident_id,shift_stop_id,shift_id,evidence_id,');
  v_anchor := 'CASE WHEN p_record_kind=''incident'' THEN p_record_id END,v_shift,v_evidence,';
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Photo registration values changed; review patrol stop attribution before applying';
  END IF;
  v_definition := replace(v_definition, v_anchor,
    'CASE WHEN p_record_kind=''incident'' THEN p_record_id END,CASE WHEN p_record_kind=''patrol_stop'' THEN p_record_id END,v_shift,v_evidence,');
  EXECUTE v_definition;
END;
$patch$;

-- Resolve check types against the agreement provider, not the operating branch.
-- Inactive types remain available to stops generated before deactivation.
CREATE OR REPLACE FUNCTION public.patrol_stop_check_details_internal(p_stop_id uuid)
RETURNS TABLE(check_key text, label text, needs_photo boolean, needs_note boolean,
  outcome text, notes text, performed_at timestamptz, known_type boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $function$
  SELECT required.check_key, coalesce(check_type.label, required.check_key),
    check_type.needs_photo, check_type.needs_note, action.outcome, action.notes,
    action.performed_at, check_type.id IS NOT NULL
  FROM public.shift_stops stop
  CROSS JOIN LATERAL unnest(stop.required_checks) WITH ORDINALITY AS required(check_key, position)
  LEFT JOIN public.client_site_patrol_config config ON config.id = stop.patrol_config_id
  LEFT JOIN public.service_agreement_delivery_schedules schedule ON schedule.id = config.delivery_schedule_id
  LEFT JOIN public.service_agreements agreement ON agreement.id = schedule.service_agreement_id
  LEFT JOIN LATERAL (
    SELECT t.* FROM public.patrol_check_types t
    WHERE t.check_key = required.check_key
      AND (t.organization_id IS NULL OR t.organization_id = agreement.provider_organization_id)
    ORDER BY (t.organization_id IS NOT NULL) DESC, t.id
    LIMIT 1
  ) check_type ON true
  LEFT JOIN LATERAL (
    SELECT a.outcome, a.notes, a.performed_at FROM public.shift_stop_actions a
    WHERE a.shift_stop_id = stop.id AND a.action_type = required.check_key
      AND a.outcome IN ('done', 'could_not_complete')
      AND a.evidence_metadata ->> 'kind' = 'patrol_stop_check'
    ORDER BY a.performed_at DESC, a.created_at DESC, a.id DESC
    LIMIT 1
  ) action ON true
  WHERE stop.id = p_stop_id
  ORDER BY required.position
$function$;
REVOKE ALL ON FUNCTION public.patrol_stop_check_details_internal(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_patrol_stop_check(
  p_request_id uuid, p_stop_id uuid, p_check_key text, p_outcome text, p_notes text,
  p_photo_path text, p_gps_lat double precision, p_gps_lng double precision,
  p_gps_accuracy_metres double precision
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_stop public.shift_stops%rowtype;
  v_shift public.shifts%rowtype;
  v_existing public.shift_stop_actions%rowtype;
  v_check record;
  v_notes text := nullif(btrim(p_notes), '');
  v_photo text := nullif(btrim(p_photo_path), '');
  v_fingerprint text;
  v_action_id uuid := gen_random_uuid();
  v_at timestamptz;
  v_receipt jsonb;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.user_profiles u WHERE u.id = v_actor AND u.deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Active officer authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'Request id is required'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('patrol-check:' || p_request_id::text, 0));
  SELECT * INTO v_stop FROM public.shift_stops WHERE id = p_stop_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Patrol stop not found'; END IF;
  BEGIN
    SELECT * INTO v_shift FROM public.shifts WHERE id = v_stop.shift_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RAISE EXCEPTION 'Shift is changing; refresh and retry' USING ERRCODE = '40001';
  END;
  IF NOT FOUND OR v_shift.officer_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'This stop is not on your shift' USING ERRCODE = '42501';
  END IF;

  v_fingerprint := md5(jsonb_build_array(v_actor, p_stop_id, p_check_key, p_outcome,
    p_notes, p_photo_path, p_gps_lat, p_gps_lng, p_gps_accuracy_metres)::text);
  SELECT * INTO v_existing FROM public.shift_stop_actions
  WHERE organization_id = v_shift.organization_id AND client_request_id = p_request_id;
  IF FOUND THEN
    IF v_existing.evidence_metadata ->> 'kind' IS DISTINCT FROM 'patrol_stop_check'
      OR v_existing.evidence_metadata ->> 'request_fingerprint' IS DISTINCT FROM v_fingerprint THEN
      RAISE EXCEPTION 'Check request replay conflicts' USING ERRCODE = '42501';
    END IF;
    RETURN v_existing.receipt;
  END IF;

  IF v_shift.status <> 'in_progress' OR v_stop.status <> 'on_scene' THEN
    RAISE EXCEPTION 'Record checks after arrival on an active shift';
  END IF;
  IF v_stop.is_adhoc OR v_stop.dispatch_job_id IS NOT NULL OR v_stop.module_key = 'static_guarding' THEN
    RAISE EXCEPTION 'Checks are available only for contracted patrol stops';
  END IF;
  SELECT * INTO v_check FROM public.patrol_stop_check_details_internal(v_stop.id) c
  WHERE c.check_key = p_check_key;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose a required check for this stop'; END IF;
  IF NOT v_check.known_type THEN RAISE EXCEPTION 'The required check type is unavailable; contact an administrator'; END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('done', 'could_not_complete') THEN
    RAISE EXCEPTION 'Choose done or could not complete';
  END IF;
  IF p_outcome = 'could_not_complete' AND v_notes IS NULL THEN
    RAISE EXCEPTION 'Say why the check could not be completed';
  END IF;
  IF p_outcome = 'done' AND v_check.needs_note AND v_notes IS NULL THEN
    RAISE EXCEPTION 'A note is required for %', v_check.label;
  END IF;
  IF p_outcome = 'done' AND v_check.needs_photo AND v_photo IS NULL THEN
    RAISE EXCEPTION 'A photo is required for %', v_check.label;
  END IF;
  IF v_photo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.officer_record_photos photo
    WHERE photo.storage_path = v_photo AND photo.shift_stop_id = v_stop.id
      AND photo.shift_id = v_shift.id AND photo.organization_id = v_shift.organization_id
      AND photo.officer_id = v_actor
  ) THEN
    RAISE EXCEPTION 'The photo attachment was not confirmed for this stop';
  END IF;
  IF (p_gps_lat IS NULL) <> (p_gps_lng IS NULL)
    OR (p_gps_lat IS NOT NULL AND p_gps_lat NOT BETWEEN -90 AND 90)
    OR (p_gps_lng IS NOT NULL AND p_gps_lng NOT BETWEEN -180 AND 180)
    OR (p_gps_accuracy_metres IS NOT NULL AND
      (p_gps_accuracy_metres < 0 OR p_gps_accuracy_metres >= 'Infinity'::double precision)) THEN
    RAISE EXCEPTION 'GPS position or accuracy is invalid';
  END IF;
  v_at := clock_timestamp();
  v_receipt := jsonb_build_object('action_id', v_action_id, 'check_key', p_check_key,
    'outcome', p_outcome, 'performed_at', v_at,
    'reference', 'PC-' || upper(left(replace(v_action_id::text, '-', ''), 8)));
  INSERT INTO public.shift_stop_actions(id, organization_id, shift_stop_id, shift_id, action_type,
    outcome, notes, gps_lat, gps_lng, performed_at, client_request_id, gps_accuracy_metres,
    evidence_metadata, receipt)
  VALUES (v_action_id, v_shift.organization_id, v_stop.id, v_shift.id, p_check_key, p_outcome,
    v_notes, p_gps_lat, p_gps_lng, v_at, p_request_id, p_gps_accuracy_metres,
    jsonb_build_object('kind', 'patrol_stop_check', 'photo_path', v_photo,
      'request_fingerprint', v_fingerprint), v_receipt);
  RETURN v_receipt;
END;
$function$;
REVOKE ALL ON FUNCTION public.record_patrol_stop_check(uuid,uuid,text,text,text,text,double precision,double precision,double precision)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_patrol_stop_check(uuid,uuid,text,text,text,text,double precision,double precision,double precision)
  TO authenticated, service_role;

-- A check receipt is not an arrival or departure receipt, even if a caller reuses its ID.
DO $patch$
DECLARE
  v_definition text;
  v_anchor text := '  IF FOUND THEN RETURN v_receipt; END IF;';
BEGIN
  v_definition := replace(pg_get_functiondef(
    'public.manage_officer_patrol_stop(uuid,text,text,uuid,text,double precision,double precision,double precision,text)'::regprocedure), chr(13), '');
  IF length(v_definition) - length(replace(v_definition, v_anchor, '')) <> length(v_anchor) THEN
    RAISE EXCEPTION 'Officer patrol stop replay changed; review check receipt protection before applying';
  END IF;
  EXECUTE replace(v_definition, v_anchor, $replacement$
  IF FOUND THEN
    IF EXISTS (SELECT 1 FROM public.shift_stop_actions a
      WHERE a.organization_id = v_shift.organization_id AND a.client_request_id = p_request_id
        AND a.evidence_metadata ->> 'kind' = 'patrol_stop_check') THEN
      RAISE EXCEPTION 'Patrol stop request conflicts with a check receipt' USING ERRCODE = '42501';
    END IF;
    RETURN v_receipt;
  END IF;$replacement$);
END;
$patch$;

-- A stop row lock serializes check recording with every completion path.
CREATE OR REPLACE FUNCTION public.require_patrol_stop_checks_before_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_missing text;
BEGIN
  IF NEW.status = 'completed' AND OLD.status IS DISTINCT FROM 'completed'
    AND cardinality(OLD.required_checks) > 0 THEN
    SELECT string_agg(c.label, ', ' ORDER BY c.ordinality) INTO v_missing
    FROM public.patrol_stop_check_details_internal(OLD.id) WITH ORDINALITY c
    WHERE c.outcome IS NULL;
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'Record every required check before leaving: %', v_missing;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.require_patrol_stop_checks_before_completion() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER require_patrol_stop_checks_before_completion
  BEFORE UPDATE OF status ON public.shift_stops
  FOR EACH ROW EXECUTE FUNCTION public.require_patrol_stop_checks_before_completion();

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
        'checks', coalesce((select jsonb_agg(jsonb_build_object(
          'check_key', c.check_key, 'label', c.label, 'needs_photo', c.needs_photo,
          'needs_note', c.needs_note, 'outcome', c.outcome, 'notes', c.notes,
          'performed_at', c.performed_at) order by c.ordinality)
          from public.patrol_stop_check_details_internal(st.id) with ordinality c), '[]'::jsonb),
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