-- Complete delivery of the existing hazard workflow: a start requires the
-- assigned officer's current receipt, and an officer report reaches its reviewer.
CREATE OR REPLACE FUNCTION public.shift_safety_places(p_shift_id uuid, p_stop_id uuid DEFAULT NULL)
RETURNS TABLE(place_kind text, place_id uuid, location_id uuid, place_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT 'site'::text, cs.id, cs.location_id, cs.name
  FROM public.shift_stops st JOIN public.client_sites cs ON cs.id = st.site_id
  WHERE st.shift_id = p_shift_id AND st.status NOT IN ('cancelled', 'skipped') AND (p_stop_id IS NULL OR st.id = p_stop_id)
  UNION
  SELECT 'zone'::text, z.id, z.location_id, z.name
  FROM public.shift_stops st JOIN public.location_zones z ON z.id = st.zone_id
  WHERE st.shift_id = p_shift_id AND st.status NOT IN ('cancelled', 'skipped') AND (p_stop_id IS NULL OR st.id = p_stop_id)
  UNION
  SELECT 'zone'::text, z.id, z.location_id, z.name
  FROM public.shifts s JOIN public.location_zones z ON z.id = s.zone_id
  WHERE s.id = p_shift_id AND p_stop_id IS NULL
  UNION
  SELECT 'site'::text, cs.id, cs.location_id, cs.name
  FROM public.shifts s
  JOIN public.service_agreement_locations sal ON sal.id = s.service_agreement_location_id
  JOIN public.client_sites cs ON cs.id = sal.site_id
  WHERE s.id = p_shift_id AND p_stop_id IS NULL
  UNION
  SELECT 'zone'::text, z.id, z.location_id, z.name
  FROM public.shifts s
  JOIN public.service_agreement_locations sal ON sal.id = s.service_agreement_location_id
  JOIN public.location_zones z ON z.id = sal.zone_id
  WHERE s.id = p_shift_id AND p_stop_id IS NULL
  UNION
  SELECT 'site'::text, cs.id, cs.location_id, cs.name
  FROM public.shifts s JOIN public.client_sites cs ON cs.location_id = s.location_id
  WHERE s.id = p_shift_id AND p_stop_id IS NULL
  UNION
  SELECT 'zone'::text, z.id, z.location_id, z.name
  FROM public.shifts s JOIN public.location_zones z ON z.location_id = s.location_id
  WHERE s.id = p_shift_id AND p_stop_id IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.build_shift_safety_briefing(p_shift_id uuid, p_stop_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_places jsonb;
  v_hazards jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_place_ids uuid[];
BEGIN
  SELECT coalesce(jsonb_agg(p.item ORDER BY p.item::text), '[]'::jsonb) INTO v_places
  FROM (
    SELECT DISTINCT jsonb_build_object('kind', place_kind, 'id', place_id, 'location_id', location_id, 'name', place_name) AS item
    FROM public.shift_safety_places(p_shift_id, p_stop_id)
  ) p;
  WITH places AS (SELECT * FROM public.shift_safety_places(p_shift_id, p_stop_id)),
  scoped AS (
    SELECT h.* FROM public.place_hazards h WHERE h.status IN ('reported', 'active') AND (
      (h.client_site_id IS NULL AND h.zone_id IS NULL AND h.location_id IN (SELECT location_id FROM places))
      OR h.client_site_id IN (SELECT place_id FROM places WHERE place_kind = 'site')
      OR h.zone_id IN (SELECT place_id FROM places WHERE place_kind = 'zone')
      OR (p_stop_id IS NULL AND h.client_site_id IS NULL AND h.zone_id IS NULL
          AND h.location_id = (SELECT location_id FROM public.shifts WHERE id = p_shift_id))
    )
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'id', h.id, 'title', h.title, 'hazard_class', h.hazard_class, 'risk_level', h.risk_level,
    'controls', to_jsonb(h.controls), 'details', h.details, 'status', h.status, 'origin', h.origin, 'version', h.version,
    'place_name', coalesce(cs.name, z.name, l.name),
    'place_kind', CASE WHEN h.client_site_id IS NOT NULL THEN 'site' WHEN h.zone_id IS NOT NULL THEN 'zone' ELSE 'location' END,
    'source_name', h.source_name, 'source_locator', h.source_locator, 'source_as_of', h.source_as_of,
    'has_source_document', h.source_document_id IS NOT NULL, 'recorded_by', o.name, 'updated_at', h.updated_at
  ) ORDER BY CASE h.risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, h.status DESC, h.title, h.id), '[]'::jsonb)
  INTO v_hazards FROM scoped h
  JOIN public.locations l ON l.id = h.location_id
  JOIN public.organizations o ON o.id = h.organization_id
  LEFT JOIN public.client_sites cs ON cs.id = h.client_site_id
  LEFT JOIN public.location_zones z ON z.id = h.zone_id;
  SELECT array_agg(DISTINCT l.canonical_place_id) INTO v_place_ids FROM public.locations l
  WHERE l.id IN (SELECT location_id FROM public.shift_safety_places(p_shift_id, p_stop_id))
    OR (p_stop_id IS NULL AND l.id = (SELECT location_id FROM public.shifts WHERE id = p_shift_id));
  IF cardinality(v_place_ids) > 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'hazard_class', w.hazard_class, 'alert_level', w.alert_level, 'raised_at', w.raised_at,
      'organization_name', w.organization_name, 'contact_phone', w.contact_phone, 'reason', w.reason
    ) ORDER BY w.id), '[]'::jsonb) INTO v_warnings
    FROM public.get_safety_warnings('place', v_place_ids) w;
  END IF;
  RETURN jsonb_build_object(
    'shift_id', p_shift_id, 'stop_id', p_stop_id, 'places', v_places, 'hazards', v_hazards, 'warnings', v_warnings,
    'item_count', jsonb_array_length(v_hazards) + jsonb_array_length(v_warnings),
    'briefing_hash', md5(jsonb_build_object('places', v_places, 'hazards', v_hazards, 'warnings', v_warnings)::text)
  );
END;
$$;
COMMENT ON FUNCTION public.build_shift_safety_briefing(uuid,uuid) IS
  'Internal authorised-caller helper. Canonical shift/stop risks and warnings, with deterministic hash over all displayed content; changes to controls, warning reasons and source references require a fresh receipt.';

CREATE OR REPLACE FUNCTION public.can_manage_place_hazards(p_organization_id uuid, p_location_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT public.is_admin_for_org(p_organization_id) AND (
    EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id AND l.organization_id = p_organization_id)
    OR EXISTS (
      SELECT 1 FROM public.service_agreement_locations sal
      JOIN public.service_agreements sa ON sa.id = sal.service_agreement_id
      LEFT JOIN public.client_sites s ON s.id = sal.site_id
      LEFT JOIN public.location_zones z ON z.id = sal.zone_id
      WHERE sal.status = 'active' AND sa.agreement_type = 'operational' AND sa.invitation_status = 'accepted'
        AND (sa.starts_on IS NULL OR sa.starts_on <= current_date)
        AND (sa.ends_on IS NULL OR sa.ends_on >= current_date)
        AND (s.location_id = p_location_id OR z.location_id = p_location_id)
        AND (sa.provider_organization_id = p_organization_id OR sa.client_organization_id = p_organization_id
             OR sal.head_contractor_org_id = p_organization_id)
    )
  );
$$;
ALTER TABLE public.notifications DROP CONSTRAINT notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check CHECK (category IN (
  'credential_expiry', 'sla_breach', 'report_ready', 'report_reviewed', 'leave_decision',
  'timesheet_decision', 'breach_decision', 'debrief_followup', 'noise_review', 'biosecurity_review',
  'document_review', 'welfare', 'dispatch', 'roster', 'open_job', 'video_review', 'system',
  'schema_change_request', 'bob_conversation', 'bob_self_memory', 'crm_client', 'builder_job',
  'place_hazard_review'
));
CREATE OR REPLACE FUNCTION public.acknowledge_safety_briefing(
  p_shift_id uuid, p_briefing_hash text, p_client_request_id uuid,
  p_stop_id uuid DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL, p_gps_lng double precision DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_briefing jsonb;
  v_existing public.safety_briefing_acknowledgements%rowtype;
  v_ack public.safety_briefing_acknowledgements%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR UPDATE;
  IF NOT FOUND OR v_shift.officer_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the assigned officer can acknowledge this briefing';
  END IF;
  IF v_shift.status NOT IN ('scheduled', 'published', 'accepted', 'in_progress') THEN
    RAISE EXCEPTION 'This shift is not open for a safety briefing (status %)', v_shift.status;
  END IF;
  IF p_stop_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.shift_stops WHERE id = p_stop_id AND shift_id = p_shift_id
  ) THEN RAISE EXCEPTION 'Stop is not part of this shift'; END IF;

  v_briefing := public.build_shift_safety_briefing(p_shift_id, p_stop_id);
  IF v_briefing->>'briefing_hash' IS DISTINCT FROM p_briefing_hash THEN
    RAISE EXCEPTION 'The safety briefing changed while you were reading it. Review the updated briefing and acknowledge again.'
      USING ERRCODE = 'P0001', HINT = 'briefing_changed';
  END IF;
  SELECT * INTO v_existing FROM public.safety_briefing_acknowledgements
  WHERE officer_user_id = v_actor AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.shift_id IS DISTINCT FROM p_shift_id
      OR v_existing.shift_stop_id IS DISTINCT FROM p_stop_id
      OR v_existing.briefing_hash IS DISTINCT FROM p_briefing_hash THEN
      RAISE EXCEPTION 'This request already acknowledged a different briefing. Reload and confirm again.'
        USING HINT = 'briefing_changed';
    END IF;
    RETURN jsonb_build_object('acknowledgement_id', v_existing.id, 'acknowledged_at', v_existing.acknowledged_at,
      'briefing_hash', v_existing.briefing_hash, 'replayed', true);
  END IF;
  INSERT INTO public.safety_briefing_acknowledgements (
    organization_id, shift_id, shift_stop_id, officer_user_id, briefing_hash,
    hazard_snapshot, item_count, gps_lat, gps_lng, client_request_id
  ) VALUES (
    v_shift.organization_id, p_shift_id, p_stop_id, v_actor, p_briefing_hash,
    v_briefing, (v_briefing->>'item_count')::integer,
    CASE WHEN p_gps_lat BETWEEN -90 AND 90 THEN p_gps_lat END,
    CASE WHEN p_gps_lng BETWEEN -180 AND 180 THEN p_gps_lng END, p_client_request_id
  ) RETURNING * INTO v_ack;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_shift.organization_id, v_actor, 'safety_briefing_acknowledged', 'safety_briefing_acknowledgements', v_ack.id,
    jsonb_build_object('shift_id', p_shift_id, 'stop_id', p_stop_id, 'item_count', v_ack.item_count, 'briefing_hash', p_briefing_hash));
  RETURN jsonb_build_object('acknowledgement_id', v_ack.id, 'acknowledged_at', v_ack.acknowledged_at,
    'briefing_hash', v_ack.briefing_hash, 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.require_shift_safety_acknowledgement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_briefing jsonb;
BEGIN
  IF NEW.status = 'in_progress' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'in_progress') THEN
    v_briefing := public.build_shift_safety_briefing(NEW.id, NULL);
    IF (v_briefing->>'item_count')::integer > 0 AND NOT EXISTS (
      SELECT 1 FROM public.safety_briefing_acknowledgements a
      WHERE a.shift_id = NEW.id AND a.officer_user_id = NEW.officer_user_id
        AND a.shift_stop_id IS NULL AND a.briefing_hash = v_briefing->>'briefing_hash'
    ) THEN
      RAISE EXCEPTION 'The assigned officer must read and acknowledge the current site risks before starting this shift.'
        USING ERRCODE = 'P0001', HINT = 'safety_briefing_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shifts_require_safety_briefing ON public.shifts;
CREATE TRIGGER shifts_require_safety_briefing
AFTER INSERT OR UPDATE OF status ON public.shifts
FOR EACH ROW EXECUTE FUNCTION public.require_shift_safety_acknowledgement();
REVOKE ALL ON FUNCTION public.require_shift_safety_acknowledgement() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.require_shift_safety_acknowledgement() IS
  'Starting a shift with recorded hazards requires the assigned officer''s current whole-shift acknowledgement, including direct inserts and admin-initiated starts. No silent client bypass.';

CREATE OR REPLACE FUNCTION public.start_ad_hoc_officer_shift(
  p_work_unit_id uuid, p_module_key text, p_location_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS public.shifts LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_profile public.user_profiles%rowtype;
  v_unit public.roster_work_units%rowtype;
  v_shift public.shifts%rowtype;
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
  SELECT * INTO v_shift FROM public.shifts
  WHERE officer_user_id = v_actor AND work_unit_id = v_unit.id AND shift_origin = 'ad_hoc'
    AND status = 'scheduled' AND scheduled_end > v_now
  ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN RETURN v_shift; END IF;
  INSERT INTO public.shifts (
    organization_id, officer_user_id, service_type, location_id, zone_id,
    patrol_route_id, service_agreement_location_id, service_agreement_module_id,
    scheduled_start, scheduled_end, status, notes, work_unit_id, module_key, shift_origin
  ) VALUES (
    v_profile.organization_id, v_actor, p_module_key, p_location_id, p_zone_id,
    v_unit.patrol_route_id, v_unit.service_agreement_location_id, v_unit.service_agreement_module_id,
    v_now, v_now + interval '12 hours', 'scheduled', nullif(trim(p_notes), ''), p_work_unit_id, p_module_key, 'ad_hoc'
  ) RETURNING * INTO v_shift;
  IF v_unit.patrol_route_id IS NOT NULL THEN
    PERFORM public.generate_shift_stops(v_shift.id, (v_now AT TIME ZONE 'Pacific/Auckland')::date);
  END IF;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_profile.organization_id, v_actor, 'officer_ad_hoc_shift_prepared', 'shifts', v_shift.id,
    jsonb_build_object('work_unit_id', p_work_unit_id, 'module_key', p_module_key, 'safety_check_required', true));
  SELECT * INTO v_shift FROM public.shifts WHERE id = v_shift.id;
  RETURN v_shift;
END;
$$;
COMMENT ON FUNCTION public.start_ad_hoc_officer_shift(uuid,text,uuid,uuid,text) IS
  'Prepares a scheduled ad-hoc shift with its work-unit contract/route and stops. The officer then reads risks, acknowledges and starts through start_officer_shift. Reuses an unstarted shift on retry.';

CREATE OR REPLACE FUNCTION public.require_stop_safety_acknowledgement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_briefing jsonb; v_officer uuid;
BEGIN
  IF NEW.status = 'on_scene' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'on_scene') THEN
    SELECT officer_user_id INTO v_officer FROM public.shifts WHERE id = NEW.shift_id;
    v_briefing := public.build_shift_safety_briefing(NEW.shift_id, NEW.id);
    IF (v_briefing->>'item_count')::integer > 0 AND NOT EXISTS (
      SELECT 1 FROM public.safety_briefing_acknowledgements a
      WHERE a.shift_id = NEW.shift_id AND a.officer_user_id = v_officer
        AND a.shift_stop_id = NEW.id AND a.briefing_hash = v_briefing->>'briefing_hash'
    ) THEN
      RAISE EXCEPTION 'Read and acknowledge the current risks for this stop before recording arrival.'
        USING ERRCODE = 'P0001', HINT = 'safety_briefing_required';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS shift_stops_require_safety_briefing ON public.shift_stops;
CREATE TRIGGER shift_stops_require_safety_briefing
AFTER INSERT OR UPDATE OF status ON public.shift_stops
FOR EACH ROW EXECUTE FUNCTION public.require_stop_safety_acknowledgement();
REVOKE ALL ON FUNCTION public.require_stop_safety_acknowledgement() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.notify_place_hazard_report()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_reviewer record;
BEGIN
  IF NEW.status = 'reported' AND NEW.origin = 'officer_reported' THEN
    FOR v_reviewer IN
      SELECT p.id FROM public.user_profiles p
      WHERE p.organization_id = NEW.organization_id AND p.deactivated_at IS NULL
        AND p.role IN ('admin', 'master', 'grand_master')
    LOOP
      PERFORM public.enqueue_notification(
        p_organization_id => NEW.organization_id, p_category => 'place_hazard_review',
        p_title => 'Reported site hazard needs review',
        p_body => 'An officer reported a hazard. It is visible to officers as not yet reviewed. Confirm, amend or retire it in the place hazard register.',
        p_severity => CASE WHEN NEW.risk_level IN ('high', 'critical') THEN 'warning' ELSE 'info' END,
        p_recipient_user_id => v_reviewer.id, p_link_page => 'sites',
        p_link_payload => jsonb_build_object('site_id', NEW.client_site_id, 'location_id', NEW.location_id, 'hazard_id', NEW.id),
        p_dedup_key => 'place_hazard_review:' || NEW.id::text || ':' || v_reviewer.id::text
      );
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS place_hazards_notify_report ON public.place_hazards;
CREATE TRIGGER place_hazards_notify_report
AFTER INSERT ON public.place_hazards
FOR EACH ROW EXECUTE FUNCTION public.notify_place_hazard_report();
REVOKE ALL ON FUNCTION public.notify_place_hazard_report() FROM PUBLIC, anon, authenticated;
