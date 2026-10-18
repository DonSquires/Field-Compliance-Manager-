-- Owner decisions: officers sign dynamic assessments; unsafe work stops.
-- H&S field reports open reviews automatically. Other incidents are linked by a supervisor.
ALTER TABLE public.place_hazards
  ADD COLUMN risk_owner_id uuid REFERENCES public.user_profiles(id),
  ADD COLUMN control_levels jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE public.dynamic_risk_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  shift_id uuid NOT NULL REFERENCES public.shifts(id),
  officer_id uuid NOT NULL REFERENCES public.user_profiles(id),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  site_id uuid REFERENCES public.client_sites(id),
  zone_id uuid REFERENCES public.location_zones(id),
  task text NOT NULL CHECK (length(btrim(task)) BETWEEN 3 AND 200),
  hazards text NOT NULL CHECK (length(btrim(hazards)) BETWEEN 3 AND 4000),
  controls text[] NOT NULL CHECK (cardinality(controls) BETWEEN 1 AND 12),
  likelihood smallint NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
  consequence smallint NOT NULL CHECK (consequence BETWEEN 1 AND 5),
  decision text NOT NULL CHECK (decision IN ('proceed_with_controls', 'stop_work')),
  briefing_snapshot jsonb NOT NULL,
  signed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  client_request_id uuid NOT NULL,
  UNIQUE (officer_id, client_request_id),
  CHECK (num_nonnulls(site_id, zone_id) = 1)
);
COMMENT ON TABLE public.dynamic_risk_assessments IS
  'Immutable officer-authored task assessment and electronic attestation, not a supervisor approval or legal certification. Unsafe means stop this task and contact the supervisor; a later assessment never rewrites the original.';

CREATE TABLE public.safety_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  location_id uuid REFERENCES public.locations(id),
  field_report_id uuid UNIQUE REFERENCES public.officer_field_reports(id),
  incident_id uuid UNIQUE REFERENCES public.incidents(id),
  assessment_id uuid UNIQUE REFERENCES public.dynamic_risk_assessments(id),
  title text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  outcome text,
  hazard_id uuid REFERENCES public.place_hazards(id),
  investigation_id uuid REFERENCES public.investigations(id),
  reviewed_by uuid REFERENCES public.user_profiles(id),
  reviewed_at timestamptz,
  created_by uuid DEFAULT auth.uid() REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(field_report_id, incident_id, assessment_id) = 1),
  CHECK ((status = 'open' AND reviewed_at IS NULL) OR
    (status = 'closed' AND reviewed_at IS NOT NULL AND length(btrim(outcome)) >= 10))
);
COMMENT ON TABLE public.safety_reviews IS
  'Custodian-private H&S triage and corrective-action receipt. References original field evidence and the existing investigation spine; never place-widens staff-sensitive narratives.';
CREATE INDEX safety_reviews_queue ON public.safety_reviews(organization_id, status, location_id);
CREATE INDEX dynamic_risk_assessments_shift ON public.dynamic_risk_assessments(shift_id, signed_at);
ALTER TABLE public.dynamic_risk_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.dynamic_risk_assessments, public.safety_reviews FROM anon, authenticated;
GRANT SELECT ON public.dynamic_risk_assessments, public.safety_reviews TO authenticated;
GRANT ALL ON public.dynamic_risk_assessments, public.safety_reviews TO service_role;
CREATE POLICY dynamic_risk_assessments_read ON public.dynamic_risk_assessments FOR SELECT TO authenticated
  USING (officer_id = auth.uid() OR public.is_admin_for_org(organization_id));
CREATE POLICY safety_reviews_read ON public.safety_reviews FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));

CREATE FUNCTION public.check_place_hazard_control_levels()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF jsonb_typeof(NEW.control_levels) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Control hierarchy must be an object keyed by the exact control text';
  END IF;
  -- Removed controls lose their classifications; unchanged controls retain theirs.
  IF TG_OP = 'UPDATE' AND NEW.controls IS DISTINCT FROM OLD.controls
    AND NEW.control_levels = OLD.control_levels THEN
    SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) INTO NEW.control_levels
    FROM jsonb_each(NEW.control_levels) WHERE key = ANY(NEW.controls);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(NEW.control_levels) c
    WHERE NOT (c.key = ANY(NEW.controls))
      OR c.value IS NULL OR c.value NOT IN ('elimination', 'substitution', 'isolation', 'engineering', 'administrative', 'ppe')) THEN
    RAISE EXCEPTION 'Classify only existing controls using a recognised hierarchy level';
  END IF;
  IF NEW.risk_owner_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.user_profiles WHERE id = NEW.risk_owner_id
      AND organization_id = NEW.organization_id AND deactivated_at IS NULL
  ) THEN RAISE EXCEPTION 'Risk owner must be an active member of the keeping organisation'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER place_hazards_control_levels BEFORE INSERT OR UPDATE ON public.place_hazards
  FOR EACH ROW EXECUTE FUNCTION public.check_place_hazard_control_levels();

CREATE FUNCTION public.review_place_hazard(
  p_hazard_id uuid, p_expected_version integer, p_owner_id uuid,
  p_control_levels jsonb, p_review_due date, p_notes text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_h public.place_hazards%rowtype;
BEGIN
  SELECT * INTO v_h FROM public.place_hazards WHERE id = p_hazard_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.can_manage_place_hazards(v_h.organization_id, v_h.location_id) THEN
    RAISE EXCEPTION 'Place hazard review access denied';
  END IF;
  IF v_h.status = 'retired' OR v_h.version IS DISTINCT FROM p_expected_version THEN
    RAISE EXCEPTION 'This hazard changed. Reload it before recording the review';
  END IF;
  IF length(btrim(coalesce(p_notes, ''))) NOT BETWEEN 10 AND 4000
    OR p_review_due IS NULL OR p_review_due <= current_date THEN
    RAISE EXCEPTION 'Record review findings and a future next-review date';
  END IF;
  UPDATE public.place_hazards SET risk_owner_id = p_owner_id,
    control_levels = coalesce(p_control_levels, '{}'::jsonb), review_due = p_review_due,
    status = 'active', reviewed_by = auth.uid(), reviewed_at = clock_timestamp(), version = version + 1
  WHERE id = v_h.id;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_h.organization_id, auth.uid(), 'place_hazard_reviewed', 'place_hazards', v_h.id,
    jsonb_build_object('previous_version', v_h.version, 'owner_id', p_owner_id, 'next_review', p_review_due, 'findings', btrim(p_notes)));
  RETURN v_h.id;
END;
$$;

CREATE FUNCTION public.notify_safety_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user record;
BEGIN
  FOR v_user IN SELECT id FROM public.user_profiles
    WHERE organization_id = NEW.organization_id AND deactivated_at IS NULL AND role IN ('admin', 'master', 'grand_master')
  LOOP
    PERFORM public.enqueue_notification(
      p_organization_id => NEW.organization_id, p_category => 'system',
      p_title => NEW.title,
      p_body => 'Review the source evidence and record corrective action in Field reports / Safety reviews.',
      p_severity => 'warning', p_recipient_user_id => v_user.id, p_link_page => 'safety-reviews',
      p_link_payload => jsonb_build_object('review_id', NEW.id, 'location_id', NEW.location_id),
      p_dedup_key => 'safety_review:' || NEW.id::text || ':' || v_user.id::text
    );
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER safety_reviews_notify AFTER INSERT ON public.safety_reviews
  FOR EACH ROW EXECUTE FUNCTION public.notify_safety_review();

CREATE FUNCTION public.open_safety_review_from_evidence()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_location uuid;
BEGIN
  IF TG_TABLE_NAME = 'officer_field_reports' THEN
    IF NEW.report_type <> 'health_safety' THEN RETURN NEW; END IF;
    SELECT coalesce(
      (SELECT location_id FROM public.client_sites WHERE id = NEW.site_id),
      (SELECT location_id FROM public.location_zones WHERE id = NEW.zone_id)
    ) INTO v_location;
    INSERT INTO public.safety_reviews(organization_id, location_id, field_report_id, title)
    VALUES (NEW.organization_id, v_location, NEW.id, 'H&S field report review') ON CONFLICT (field_report_id) DO NOTHING;
  ELSE
    INSERT INTO public.safety_reviews(organization_id, location_id, assessment_id, title)
    VALUES (NEW.organization_id, NEW.location_id, NEW.id,
      CASE NEW.decision WHEN 'stop_work' THEN 'STOP WORK - dynamic assessment' ELSE 'Dynamic task assessment review' END)
    ON CONFLICT (assessment_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER officer_field_reports_safety_review AFTER INSERT ON public.officer_field_reports
  FOR EACH ROW EXECUTE FUNCTION public.open_safety_review_from_evidence();
CREATE TRIGGER dynamic_risk_assessments_review AFTER INSERT ON public.dynamic_risk_assessments
  FOR EACH ROW EXECUTE FUNCTION public.open_safety_review_from_evidence();

INSERT INTO public.safety_reviews(organization_id, location_id, field_report_id, title, created_by, created_at)
SELECT r.organization_id, coalesce(s.location_id, z.location_id), r.id, 'H&S field report review', r.officer_id, r.reported_at
FROM public.officer_field_reports r
LEFT JOIN public.client_sites s ON s.id = r.site_id
LEFT JOIN public.location_zones z ON z.id = r.zone_id
WHERE r.report_type = 'health_safety' AND r.status = 'submitted'
ON CONFLICT (field_report_id) DO NOTHING;

CREATE FUNCTION public.submit_dynamic_risk_assessment(
  p_shift_id uuid, p_place_kind text, p_place_id uuid, p_task text, p_hazards text,
  p_controls text[], p_likelihood smallint, p_consequence smallint, p_decision text,
  p_understood boolean, p_client_request_id uuid
) RETURNS public.dynamic_risk_assessments LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_shift public.shifts%rowtype; v_place record; v_item public.dynamic_risk_assessments%rowtype; v_controls text[];
BEGIN
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id FOR SHARE;
  IF auth.uid() IS NULL OR v_shift.officer_user_id IS DISTINCT FROM auth.uid() OR v_shift.status <> 'in_progress'
    OR NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND deactivated_at IS NULL) THEN
    RAISE EXCEPTION 'Only the active assigned officer can submit a task assessment';
  END IF;
  IF p_understood IS DISTINCT FROM true OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Confirm that you assessed these risks and understand the controls';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext(auth.uid()::text || ':' || p_client_request_id::text));
  IF cardinality(p_controls) NOT BETWEEN 1 AND 12 OR EXISTS (
    SELECT 1 FROM unnest(p_controls) c WHERE length(btrim(c)) NOT BETWEEN 1 AND 300 OR c IS NULL
  ) THEN RAISE EXCEPTION 'Record 1-12 controls, each 1-300 characters'; END IF;
  SELECT array_agg(btrim(c) ORDER BY ord) INTO v_controls FROM unnest(p_controls) WITH ORDINALITY x(c,ord);
  SELECT * INTO v_place FROM public.shift_safety_places(p_shift_id, NULL)
    WHERE place_kind = p_place_kind AND place_id = p_place_id LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assessment place must belong to the active shift'; END IF;
  SELECT * INTO v_item FROM public.dynamic_risk_assessments
    WHERE officer_id = auth.uid() AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_item.shift_id IS DISTINCT FROM p_shift_id OR v_item.site_id IS DISTINCT FROM
      (CASE WHEN p_place_kind = 'site' THEN p_place_id END) OR v_item.zone_id IS DISTINCT FROM
      (CASE WHEN p_place_kind = 'zone' THEN p_place_id END) OR v_item.task IS DISTINCT FROM btrim(p_task)
      OR v_item.hazards IS DISTINCT FROM btrim(p_hazards) OR v_item.decision IS DISTINCT FROM p_decision
      OR v_item.likelihood IS DISTINCT FROM p_likelihood OR v_item.consequence IS DISTINCT FROM p_consequence
      OR v_item.controls IS DISTINCT FROM v_controls THEN
      RAISE EXCEPTION 'Request already records another assessment. Reload before submitting a new one';
    END IF;
    RETURN v_item;
  END IF;
  INSERT INTO public.dynamic_risk_assessments(
    organization_id, shift_id, officer_id, location_id, site_id, zone_id,
    task, hazards, controls, likelihood, consequence, decision, briefing_snapshot, client_request_id
  ) VALUES (
    v_shift.organization_id, p_shift_id, auth.uid(), v_place.location_id,
    CASE WHEN p_place_kind = 'site' THEN p_place_id END, CASE WHEN p_place_kind = 'zone' THEN p_place_id END,
    btrim(p_task), btrim(p_hazards), v_controls, p_likelihood, p_consequence, p_decision,
    public.build_shift_safety_briefing(p_shift_id, NULL), p_client_request_id
  ) RETURNING * INTO v_item;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_shift.organization_id, auth.uid(), 'dynamic_risk_assessment_signed', 'dynamic_risk_assessments', v_item.id,
    jsonb_build_object('shift_id', p_shift_id, 'decision', p_decision, 'signed_at', v_item.signed_at));
  RETURN v_item;
END;
$$;

CREATE FUNCTION public.get_shift_risk_assessments(p_shift_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.shifts s WHERE s.id = p_shift_id AND
      (s.officer_user_id = auth.uid() OR public.is_admin_for_org(s.organization_id))
  ) THEN RAISE EXCEPTION 'Shift assessment access denied'; END IF;
  RETURN coalesce((SELECT jsonb_agg((to_jsonb(a) - 'briefing_snapshot') || jsonb_build_object(
      'review_status', r.status, 'review_outcome', r.outcome, 'reviewed_at', r.reviewed_at
    ) ORDER BY a.signed_at DESC)
    FROM public.dynamic_risk_assessments a LEFT JOIN public.safety_reviews r ON r.assessment_id = a.id
    WHERE a.shift_id = p_shift_id), '[]'::jsonb);
END;
$$;

CREATE FUNCTION public.open_incident_safety_review(p_incident_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_incident public.incidents%rowtype; v_id uuid;
BEGIN
  SELECT * INTO v_incident FROM public.incidents WHERE id = p_incident_id FOR SHARE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_admin_for_org(v_incident.organization_id) THEN
    RAISE EXCEPTION 'Incident safety review access denied';
  END IF;
  INSERT INTO public.safety_reviews(organization_id, location_id, incident_id, title)
  VALUES (v_incident.organization_id, coalesce(
    (SELECT location_id FROM public.client_sites WHERE id = v_incident.client_site_id),
    (SELECT location_id FROM public.location_zones WHERE id = v_incident.zone_id), v_incident.location_id
  ), v_incident.id, 'Supervisor-linked incident safety review')
  ON CONFLICT (incident_id) DO UPDATE SET incident_id = excluded.incident_id RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE FUNCTION public.complete_safety_review(
  p_review_id uuid, p_outcome text, p_hazard_id uuid DEFAULT NULL, p_investigation_id uuid DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item public.safety_reviews%rowtype;
BEGIN
  SELECT * INTO v_item FROM public.safety_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR NOT public.is_admin_for_org(v_item.organization_id) THEN
    RAISE EXCEPTION 'Safety review access denied';
  END IF;
  IF v_item.status <> 'open' THEN RAISE EXCEPTION 'Review already completed. Refresh to read its receipt'; END IF;
  IF length(btrim(coalesce(p_outcome, ''))) NOT BETWEEN 10 AND 4000 THEN
    RAISE EXCEPTION 'Record the findings, corrective action and reason for closing (10-4000 characters)';
  END IF;
  IF p_hazard_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.place_hazards h WHERE h.id = p_hazard_id
      AND h.organization_id = v_item.organization_id AND h.location_id = v_item.location_id
  ) THEN RAISE EXCEPTION 'Linked hazard must belong to the same organisation and place'; END IF;
  IF p_investigation_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.investigations WHERE id = p_investigation_id AND organization_id = v_item.organization_id) THEN
      RAISE EXCEPTION 'Linked investigation must belong to this organisation';
    END IF;
    IF v_item.field_report_id IS NOT NULL THEN
      PERFORM public.link_investigation_entity(p_investigation_id, 'field_report', v_item.field_report_id, 'primary', 'H&S review corrective action');
    ELSIF v_item.incident_id IS NOT NULL THEN
      PERFORM public.link_investigation_entity(p_investigation_id, 'incident', v_item.incident_id, 'primary', 'H&S review corrective action');
    END IF;
  END IF;
  UPDATE public.safety_reviews SET status = 'closed', outcome = btrim(p_outcome), hazard_id = p_hazard_id,
    investigation_id = p_investigation_id, reviewed_by = auth.uid(), reviewed_at = clock_timestamp() WHERE id = v_item.id;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_item.organization_id, auth.uid(), 'safety_review_completed', 'safety_reviews', v_item.id,
    jsonb_build_object('hazard_id', p_hazard_id, 'investigation_id', p_investigation_id));
  IF v_item.assessment_id IS NOT NULL THEN
    PERFORM public.enqueue_notification(
      p_organization_id => v_item.organization_id, p_category => 'system',
      p_title => 'Your task risk assessment has been reviewed',
      p_body => 'Read the supervisor findings in your shift safety assessments. An unsafe assessment stays on record; reassess before resuming that task.',
      p_recipient_user_id => (SELECT officer_id FROM public.dynamic_risk_assessments WHERE id = v_item.assessment_id),
      p_link_page => 'safety-assessments', p_link_payload => jsonb_build_object('assessment_id', v_item.assessment_id),
      p_dedup_key => 'assessment_reviewed:' || v_item.id::text
    );
  END IF;
  RETURN v_item.id;
END;
$$;

CREATE FUNCTION public.get_safety_review_workspace(p_organization_id uuid, p_location_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Safety review workspace access denied'; END IF;
  IF p_location_id IS NOT NULL AND NOT public.can_manage_place_hazards(p_organization_id, p_location_id) THEN
    RAISE EXCEPTION 'Place safety review access denied';
  END IF;
  RETURN jsonb_build_object(
    'owners', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', coalesce(display_name, 'Unnamed staff member')) ORDER BY display_name)
      FROM public.user_profiles WHERE organization_id = p_organization_id AND deactivated_at IS NULL), '[]'::jsonb),
    'hazards', coalesce((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'title', h.title, 'version', h.version,
      'controls', h.controls, 'control_levels', h.control_levels, 'risk_owner_id', h.risk_owner_id,
      'review_due', h.review_due, 'location_id', h.location_id) ORDER BY h.title)
      FROM public.place_hazards h WHERE h.organization_id = p_organization_id AND h.status <> 'retired'
        AND (p_location_id IS NULL OR h.location_id = p_location_id)
        AND public.can_manage_place_hazards(h.organization_id, h.location_id)), '[]'::jsonb),
    'reviews', coalesce((SELECT jsonb_agg(to_jsonb(r) || jsonb_build_object(
      'assessment', (SELECT to_jsonb(a) - 'briefing_snapshot' FROM public.dynamic_risk_assessments a WHERE a.id = r.assessment_id),
      'source_description', coalesce(
        (SELECT description FROM public.officer_field_reports WHERE id = r.field_report_id AND organization_id = r.organization_id),
        (SELECT description FROM public.incidents WHERE id = r.incident_id AND organization_id = r.organization_id)
      )
    ) ORDER BY r.created_at DESC) FROM public.safety_reviews r WHERE r.organization_id = p_organization_id
      AND (p_location_id IS NULL OR r.location_id = p_location_id)), '[]'::jsonb),
    'incidents', coalesce((SELECT jsonb_agg(jsonb_build_object('id', i.id, 'name', i.incident_type || ' - ' || i.occurred_at::date, 'summary', i.description))
      FROM public.incidents i WHERE i.organization_id = p_organization_id AND NOT EXISTS (
        SELECT 1 FROM public.safety_reviews r WHERE r.incident_id = i.id
      ) AND (p_location_id IS NULL OR i.location_id = p_location_id
        OR EXISTS (SELECT 1 FROM public.client_sites s WHERE s.id = i.client_site_id AND s.location_id = p_location_id)
        OR EXISTS (SELECT 1 FROM public.location_zones z WHERE z.id = i.zone_id AND z.location_id = p_location_id))), '[]'::jsonb),
    'investigations', coalesce((SELECT jsonb_agg(jsonb_build_object('id', id, 'name', investigation_reference || ' - ' || title))
      FROM public.investigations WHERE organization_id = p_organization_id), '[]'::jsonb)
  );
END;
$$;

CREATE FUNCTION public.sweep_place_hazard_reviews(p_organization_id uuid DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_h record; v_user record; v_count integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sweep_place_hazard_reviews'));
  FOR v_h IN SELECT * FROM public.place_hazards
    WHERE status <> 'retired' AND review_due <= (now() AT TIME ZONE 'Pacific/Auckland')::date
      AND (p_organization_id IS NULL OR organization_id = p_organization_id)
  LOOP
    FOR v_user IN SELECT id FROM public.user_profiles WHERE organization_id = v_h.organization_id
      AND deactivated_at IS NULL AND (id = v_h.risk_owner_id OR role IN ('admin', 'master', 'grand_master'))
    LOOP
      PERFORM public.enqueue_notification(
        p_organization_id => v_h.organization_id, p_category => 'place_hazard_review',
        p_title => 'Place hazard review is due', p_body => 'Review the hazard, controls and owner; record findings and the next review date.',
        p_severity => 'warning', p_recipient_user_id => v_user.id, p_link_page => 'sites',
        p_link_payload => jsonb_build_object('site_id', v_h.client_site_id, 'location_id', v_h.location_id, 'hazard_id', v_h.id),
        p_dedup_key => 'hazard_due:' || v_h.id::text || ':' || v_h.review_due::text || ':' || v_user.id::text
      );
      v_count := v_count + 1;
    END LOOP;
  END LOOP;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.check_place_hazard_control_levels() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.notify_safety_review() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.open_safety_review_from_evidence() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sweep_place_hazard_reviews(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_place_hazard_reviews(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.review_place_hazard(uuid,integer,uuid,jsonb,date,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.submit_dynamic_risk_assessment(uuid,text,uuid,text,text,text[],smallint,smallint,text,boolean,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_shift_risk_assessments(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.open_incident_safety_review(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_safety_review(uuid,text,uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_safety_review_workspace(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_place_hazard(uuid,integer,uuid,jsonb,date,text),
  public.submit_dynamic_risk_assessment(uuid,text,uuid,text,text,text[],smallint,smallint,text,boolean,uuid),
  public.get_shift_risk_assessments(uuid), public.open_incident_safety_review(uuid),
  public.complete_safety_review(uuid,text,uuid,uuid), public.get_safety_review_workspace(uuid,uuid) TO authenticated, service_role;

DO $$
BEGIN
  PERFORM cron.schedule_in_database('place-hazard-review-daily', '15 18 * * *',
    'select public.sweep_place_hazard_reviews();', 'postgres', NULL, TRUE);
END;
$$;
