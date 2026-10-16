-- Place hazard register and officer safety briefings.
--
-- A guard on a place for a shift must know the specific risks of that place
-- before work starts (HSWA 2015 s.36/s.58 duty to inform workers in an
-- understandable form). The organisation compliance register holds whole
-- documents (H&S plans, policies); this register holds the short, place-scoped
-- hazards distilled from them, each linked back to the exact source section:
--
--   place_hazards                      one hazard at a house (location), or at
--                                      one of its facets (client site / zone)
--   safety_briefing_acknowledgements   the officer's receipt that they read the
--                                      exact briefing (hash) for a shift/stop
--
-- Writers: Bob proposes (create_place_hazard action, human approval, applied by
-- apply_bob_place_hazard_proposal); administrators manage (manage_place_hazard);
-- officers report what they find during a shift (report_place_hazard), which is
-- visible to other officers immediately as 'reported - not yet reviewed' until
-- a supervisor confirms or retires it. Tables are read-only to clients.

CREATE TABLE IF NOT EXISTS public.place_hazards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  client_site_id uuid REFERENCES public.client_sites(id) ON DELETE CASCADE,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  hazard_class text NOT NULL CHECK (hazard_class IN (
    'violence_or_aggression', 'weapons', 'dangerous_dog', 'hazardous_substances',
    'biological_or_infection', 'sharps', 'slips_trips_falls', 'traffic_and_vehicles',
    'working_at_height', 'electrical', 'fire_or_explosion', 'confined_space',
    'lone_working', 'weather_or_environment', 'security_threat', 'manual_handling',
    'medical_or_welfare', 'unsafe_structure_or_ground', 'other'
  )),
  risk_level text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  likelihood smallint CHECK (likelihood BETWEEN 1 AND 5),
  consequence smallint CHECK (consequence BETWEEN 1 AND 5),
  controls text[] NOT NULL DEFAULT '{}'::text[] CHECK (cardinality(controls) <= 12),
  details text CHECK (details IS NULL OR length(details) <= 4000),
  source_document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  source_locator text CHECK (source_locator IS NULL OR length(source_locator) <= 200),
  source_name text CHECK (source_name IS NULL OR length(source_name) <= 500),
  source_as_of date,
  origin text NOT NULL CHECK (origin IN ('bob_extracted', 'officer_reported', 'manual')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('reported', 'active', 'retired')),
  reported_by uuid,
  reported_shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  reviewed_by uuid,
  reviewed_at timestamptz,
  review_due date,
  retired_by uuid,
  retired_at timestamptz,
  retired_reason text CHECK (retired_reason IS NULL OR length(retired_reason) <= 500),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  bob_action_id uuid REFERENCES public.bob_agentic_actions(id) ON DELETE SET NULL,
  client_request_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT place_hazards_single_facet CHECK (client_site_id IS NULL OR zone_id IS NULL),
  CONSTRAINT place_hazards_retired_consistent CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
  CONSTRAINT place_hazards_client_request_unique UNIQUE (organization_id, client_request_id)
);

COMMENT ON TABLE public.place_hazards IS 'Place hazard register: one specific risk at a house (location) or one of its facets (client site or zone), with residual risk level, controls and a link to the exact section of its source document. Feeds the officer safety briefing at shift start and patrol arrival. Writes only through report_place_hazard, manage_place_hazard and apply_bob_place_hazard_proposal.';
COMMENT ON COLUMN public.place_hazards.organization_id IS 'Organisation that keeps this register entry (custodian). Briefings show every organisation''s live hazards at the place.';
COMMENT ON COLUMN public.place_hazards.status IS 'reported = raised by an officer, shown to officers as not yet reviewed; active = reviewed or approved; retired = no longer applies.';
COMMENT ON COLUMN public.place_hazards.version IS 'Bumped whenever briefing-relevant content changes, so officers must re-acknowledge.';
COMMENT ON COLUMN public.place_hazards.source_locator IS 'Where in the source document the hazard comes from (section or page), shown beside the document link.';

CREATE INDEX IF NOT EXISTS place_hazards_location_live_idx ON public.place_hazards (location_id) WHERE status <> 'retired';
CREATE INDEX IF NOT EXISTS place_hazards_site_live_idx ON public.place_hazards (client_site_id) WHERE status <> 'retired' AND client_site_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS place_hazards_zone_live_idx ON public.place_hazards (zone_id) WHERE status <> 'retired' AND zone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS place_hazards_org_status_idx ON public.place_hazards (organization_id, status);
CREATE INDEX IF NOT EXISTS place_hazards_bob_action_idx ON public.place_hazards (bob_action_id) WHERE bob_action_id IS NOT NULL;

-- A facet must belong to the house the hazard is anchored to.
CREATE OR REPLACE FUNCTION public.place_hazards_check_facet()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.client_site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_sites s WHERE s.id = NEW.client_site_id AND s.location_id = NEW.location_id
  ) THEN
    RAISE EXCEPTION 'Site does not belong to this place';
  END IF;
  IF NEW.zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.location_zones z WHERE z.id = NEW.zone_id AND z.location_id = NEW.location_id
  ) THEN
    RAISE EXCEPTION 'Zone does not belong to this place';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS place_hazards_check_facet ON public.place_hazards;
CREATE TRIGGER place_hazards_check_facet
  BEFORE INSERT OR UPDATE ON public.place_hazards
  FOR EACH ROW EXECUTE FUNCTION public.place_hazards_check_facet();

CREATE TABLE IF NOT EXISTS public.safety_briefing_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shift_id uuid NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  shift_stop_id uuid REFERENCES public.shift_stops(id) ON DELETE CASCADE,
  officer_user_id uuid NOT NULL,
  briefing_hash text NOT NULL,
  hazard_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  item_count integer NOT NULL DEFAULT 0,
  gps_lat double precision,
  gps_lng double precision,
  client_request_id uuid NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT safety_briefing_ack_request_unique UNIQUE (officer_user_id, client_request_id)
);

COMMENT ON TABLE public.safety_briefing_acknowledgements IS 'Officer receipt that they read and understood the exact safety briefing (briefing_hash over hazard ids, versions and statuses plus active place warnings) for a shift, or for one patrol stop. hazard_snapshot preserves what was shown. Written only by acknowledge_safety_briefing.';

CREATE INDEX IF NOT EXISTS safety_briefing_ack_shift_idx ON public.safety_briefing_acknowledgements (shift_id, officer_user_id, acknowledged_at DESC);

-- ââ Access helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

CREATE OR REPLACE FUNCTION public.can_read_place_hazard(p_organization_id uuid, p_location_id uuid, p_site_id uuid, p_zone_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.org_access_allowed(p_organization_id)
    OR EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id AND public.org_access_allowed(l.organization_id))
    OR (p_site_id IS NOT NULL AND public.has_location_access(p_site_id, NULL))
    OR (p_zone_id IS NOT NULL AND public.has_location_access(NULL, p_zone_id))
    OR EXISTS (SELECT 1 FROM public.client_sites s WHERE s.location_id = p_location_id AND public.has_location_access(s.id, NULL))
    OR EXISTS (SELECT 1 FROM public.location_zones z WHERE z.location_id = p_location_id AND public.has_location_access(NULL, z.id));
$$;
COMMENT ON FUNCTION public.can_read_place_hazard(uuid, uuid, uuid, uuid) IS 'Caller may read a place hazard: the keeping organisation is in scope, or the caller''s organisation owns or works at the place (ownership, operational agreement or head contractor).';

CREATE OR REPLACE FUNCTION public.can_manage_place_hazards(p_organization_id uuid, p_location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin_for_org(p_organization_id)
    AND public.can_read_place_hazard(p_organization_id, p_location_id, NULL, NULL)
    AND EXISTS (SELECT 1 FROM public.locations l WHERE l.id = p_location_id);
$$;
COMMENT ON FUNCTION public.can_manage_place_hazards(uuid, uuid) IS 'Caller is an administrator of the keeping organisation and that organisation owns or works at the place.';

ALTER TABLE public.place_hazards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.safety_briefing_acknowledgements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS place_hazards_select ON public.place_hazards;
CREATE POLICY place_hazards_select ON public.place_hazards
  FOR SELECT TO authenticated
  USING (public.can_read_place_hazard(organization_id, location_id, client_site_id, zone_id));

DROP POLICY IF EXISTS safety_briefing_ack_select ON public.safety_briefing_acknowledgements;
CREATE POLICY safety_briefing_ack_select ON public.safety_briefing_acknowledgements
  FOR SELECT TO authenticated
  USING (officer_user_id = auth.uid() OR public.is_admin_for_org(organization_id));

REVOKE ALL ON public.place_hazards FROM anon, authenticated;
REVOKE ALL ON public.safety_briefing_acknowledgements FROM anon, authenticated;
GRANT SELECT ON public.place_hazards TO authenticated;
GRANT SELECT ON public.safety_briefing_acknowledgements TO authenticated;
GRANT ALL ON public.place_hazards TO service_role;
GRANT ALL ON public.safety_briefing_acknowledgements TO service_role;

-- ââ Briefing ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

-- Every place a shift (or one of its stops) is for, mirroring
-- evaluate_shift_start_position: stop sites and zones, the shift's own zone,
-- and the agreement location it was rostered against.
CREATE OR REPLACE FUNCTION public.shift_safety_places(p_shift_id uuid, p_stop_id uuid DEFAULT NULL)
RETURNS TABLE(place_kind text, place_id uuid, location_id uuid, place_name text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
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
  WHERE s.id = p_shift_id AND p_stop_id IS NULL;
$$;
COMMENT ON FUNCTION public.shift_safety_places(uuid, uuid) IS 'Internal: the sites and zones (with their house) a shift, or one of its stops, is for. Used by the safety briefing and officer hazard reports.';

-- The briefing content without caller checks; callers authorise first.
CREATE OR REPLACE FUNCTION public.build_shift_safety_briefing(p_shift_id uuid, p_stop_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_places jsonb;
  v_hazards jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_place_ids uuid[];
  v_hash_input text;
BEGIN
  SELECT coalesce(jsonb_agg(DISTINCT jsonb_build_object('kind', p.place_kind, 'id', p.place_id, 'location_id', p.location_id, 'name', p.place_name)), '[]'::jsonb)
  INTO v_places
  FROM public.shift_safety_places(p_shift_id, p_stop_id) p;

  WITH places AS (SELECT * FROM public.shift_safety_places(p_shift_id, p_stop_id)),
  scoped AS (
    SELECT h.*
    FROM public.place_hazards h
    WHERE h.status IN ('reported', 'active')
      AND (
        (h.client_site_id IS NULL AND h.zone_id IS NULL AND h.location_id IN (SELECT location_id FROM places))
        OR h.client_site_id IN (SELECT place_id FROM places WHERE place_kind = 'site')
        OR h.zone_id IN (SELECT place_id FROM places WHERE place_kind = 'zone')
      )
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', h.id,
      'title', h.title,
      'hazard_class', h.hazard_class,
      'risk_level', h.risk_level,
      'controls', to_jsonb(h.controls),
      'details', h.details,
      'status', h.status,
      'origin', h.origin,
      'version', h.version,
      'place_name', coalesce(cs.name, z.name, l.name),
      'place_kind', CASE WHEN h.client_site_id IS NOT NULL THEN 'site' WHEN h.zone_id IS NOT NULL THEN 'zone' ELSE 'location' END,
      'source_name', h.source_name,
      'source_locator', h.source_locator,
      'source_as_of', h.source_as_of,
      'has_source_document', h.source_document_id IS NOT NULL,
      'recorded_by', o.name,
      'updated_at', h.updated_at
    ) ORDER BY CASE h.risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, h.status DESC, h.title), '[]'::jsonb),
    string_agg('h:' || h.id::text || ':' || h.version::text || ':' || h.status, '|' ORDER BY h.id)
  INTO v_hazards, v_hash_input
  FROM scoped h
  JOIN public.locations l ON l.id = h.location_id
  JOIN public.organizations o ON o.id = h.organization_id
  LEFT JOIN public.client_sites cs ON cs.id = h.client_site_id
  LEFT JOIN public.location_zones z ON z.id = h.zone_id;

  SELECT array_agg(DISTINCT l.canonical_place_id) INTO v_place_ids
  FROM public.shift_safety_places(p_shift_id, p_stop_id) p
  JOIN public.locations l ON l.id = p.location_id;

  IF cardinality(v_place_ids) > 0 THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', w.id, 'hazard_class', w.hazard_class, 'alert_level', w.alert_level, 'raised_at', w.raised_at,
        'organization_name', w.organization_name, 'contact_phone', w.contact_phone, 'reason', w.reason
      )), '[]'::jsonb),
      coalesce(v_hash_input, '') || '|' || coalesce(string_agg('f:' || w.id::text || ':' || w.alert_level, '|' ORDER BY w.id), '')
    INTO v_warnings, v_hash_input
    FROM public.get_safety_warnings('place', v_place_ids) w;
  END IF;

  RETURN jsonb_build_object(
    'shift_id', p_shift_id,
    'stop_id', p_stop_id,
    'places', v_places,
    'hazards', v_hazards,
    'warnings', v_warnings,
    'item_count', jsonb_array_length(v_hazards) + jsonb_array_length(v_warnings),
    'briefing_hash', md5(coalesce(v_hash_input, ''))
  );
END;
$$;
COMMENT ON FUNCTION public.build_shift_safety_briefing(uuid, uuid) IS 'Internal: live hazards (reported and active) and active place safety warnings for a shift or stop, ordered critical first, with a hash over hazard ids, versions, statuses and warning levels. Callers must authorise.';

CREATE OR REPLACE FUNCTION public.get_shift_safety_briefing(p_shift_id uuid, p_stop_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_briefing jsonb;
  v_ack public.safety_briefing_acknowledgements%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift not found'; END IF;
  IF v_shift.officer_user_id IS DISTINCT FROM v_actor AND NOT public.is_admin_for_org(v_shift.organization_id) THEN
    RAISE EXCEPTION 'Only the assigned officer or an administrator can read this briefing';
  END IF;
  IF p_stop_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shift_stops WHERE id = p_stop_id AND shift_id = p_shift_id) THEN
    RAISE EXCEPTION 'Stop is not part of this shift';
  END IF;

  v_briefing := public.build_shift_safety_briefing(p_shift_id, p_stop_id);

  SELECT * INTO v_ack
  FROM public.safety_briefing_acknowledgements a
  WHERE a.shift_id = p_shift_id
    AND a.officer_user_id = v_shift.officer_user_id
    AND a.shift_stop_id IS NOT DISTINCT FROM p_stop_id
  ORDER BY a.acknowledged_at DESC
  LIMIT 1;

  RETURN v_briefing || jsonb_build_object(
    'shift_status', v_shift.status,
    'acknowledgement_required', (v_briefing->>'item_count')::int > 0,
    'acknowledged', v_ack.id IS NOT NULL AND v_ack.briefing_hash = v_briefing->>'briefing_hash',
    'acknowledged_at', CASE WHEN v_ack.briefing_hash = v_briefing->>'briefing_hash' THEN v_ack.acknowledged_at END,
    'changed_since_acknowledgement', v_ack.id IS NOT NULL AND v_ack.briefing_hash <> v_briefing->>'briefing_hash',
    'is_assigned_officer', v_shift.officer_user_id = v_actor
  );
END;
$$;
COMMENT ON FUNCTION public.get_shift_safety_briefing(uuid, uuid) IS 'Officer safety briefing for a shift (or one patrol stop): live place hazards critical first with controls and source reference, active place safety warnings, and whether the assigned officer has acknowledged this exact version. Readable by the assigned officer or an administrator of the shift''s organisation.';

CREATE OR REPLACE FUNCTION public.acknowledge_safety_briefing(
  p_shift_id uuid,
  p_briefing_hash text,
  p_client_request_id uuid,
  p_stop_id uuid DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
  SELECT * INTO v_existing FROM public.safety_briefing_acknowledgements WHERE officer_user_id = v_actor AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN jsonb_build_object('acknowledgement_id', v_existing.id, 'acknowledged_at', v_existing.acknowledged_at, 'briefing_hash', v_existing.briefing_hash, 'replayed', true);
  END IF;

  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;
  IF NOT FOUND OR v_shift.officer_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the assigned officer can acknowledge this briefing';
  END IF;
  IF v_shift.status NOT IN ('published', 'accepted', 'in_progress') THEN
    RAISE EXCEPTION 'This shift is not open for a safety briefing (status %)', v_shift.status;
  END IF;
  IF p_stop_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shift_stops WHERE id = p_stop_id AND shift_id = p_shift_id) THEN
    RAISE EXCEPTION 'Stop is not part of this shift';
  END IF;

  v_briefing := public.build_shift_safety_briefing(p_shift_id, p_stop_id);
  IF v_briefing->>'briefing_hash' IS DISTINCT FROM p_briefing_hash THEN
    RAISE EXCEPTION 'The safety briefing changed while you were reading it. Review the updated briefing and acknowledge again.'
      USING ERRCODE = 'P0001', HINT = 'briefing_changed';
  END IF;

  INSERT INTO public.safety_briefing_acknowledgements (
    organization_id, shift_id, shift_stop_id, officer_user_id, briefing_hash,
    hazard_snapshot, item_count, gps_lat, gps_lng, client_request_id
  ) VALUES (
    v_shift.organization_id, p_shift_id, p_stop_id, v_actor, v_briefing->>'briefing_hash',
    jsonb_build_object(
      'hazards', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', h->'id', 'title', h->'title', 'risk_level', h->'risk_level', 'status', h->'status', 'version', h->'version')), '[]'::jsonb) FROM jsonb_array_elements(v_briefing->'hazards') h),
      'warnings', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', w->'id', 'hazard_class', w->'hazard_class', 'alert_level', w->'alert_level')), '[]'::jsonb) FROM jsonb_array_elements(v_briefing->'warnings') w)
    ),
    (v_briefing->>'item_count')::int,
    CASE WHEN p_gps_lat BETWEEN -90 AND 90 THEN p_gps_lat END,
    CASE WHEN p_gps_lng BETWEEN -180 AND 180 THEN p_gps_lng END,
    p_client_request_id
  )
  RETURNING * INTO v_ack;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_shift.organization_id, v_actor, 'safety_briefing_acknowledged', 'safety_briefing_acknowledgements', v_ack.id,
    jsonb_build_object('shift_id', p_shift_id, 'stop_id', p_stop_id, 'item_count', v_ack.item_count, 'briefing_hash', v_ack.briefing_hash));

  RETURN jsonb_build_object('acknowledgement_id', v_ack.id, 'acknowledged_at', v_ack.acknowledged_at, 'briefing_hash', v_ack.briefing_hash, 'replayed', false);
END;
$$;
COMMENT ON FUNCTION public.acknowledge_safety_briefing(uuid, text, uuid, uuid, double precision, double precision) IS 'The assigned officer acknowledges the exact safety briefing they read. Rejected (hint briefing_changed) if the briefing changed since it was shown. Idempotent on client_request_id; audited.';

-- ââ Officer reports âââââââââââââââââââââââââââââââââââââââââââââââââââââââ

CREATE OR REPLACE FUNCTION public.report_place_hazard(
  p_shift_id uuid,
  p_place_kind text,
  p_place_id uuid,
  p_title text,
  p_hazard_class text,
  p_risk_level text,
  p_client_request_id uuid,
  p_details text DEFAULT NULL,
  p_controls text[] DEFAULT '{}'::text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_shift public.shifts%rowtype;
  v_place record;
  v_id uuid;
  v_controls text[];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT * INTO v_shift FROM public.shifts WHERE id = p_shift_id;
  IF NOT FOUND OR v_shift.officer_user_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the assigned officer can report a hazard on this shift';
  END IF;
  SELECT h.id INTO v_id FROM public.place_hazards h WHERE h.organization_id = v_shift.organization_id AND h.client_request_id = p_client_request_id;
  IF FOUND THEN RETURN v_id; END IF;
  IF v_shift.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Hazards can be reported during an in-progress shift';
  END IF;

  SELECT * INTO v_place FROM public.shift_safety_places(p_shift_id, NULL) p
  WHERE p.place_kind = p_place_kind AND p.place_id = p_place_id
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That place is not part of this shift';
  END IF;

  SELECT coalesce(array_agg(left(btrim(c), 300)) FILTER (WHERE btrim(c) <> ''), '{}'::text[])
  INTO v_controls FROM unnest(coalesce(p_controls, '{}'::text[])) c;

  INSERT INTO public.place_hazards (
    organization_id, location_id, client_site_id, zone_id, title, hazard_class, risk_level,
    controls, details, origin, status, reported_by, reported_shift_id, client_request_id, created_by
  ) VALUES (
    v_shift.organization_id, v_place.location_id,
    CASE WHEN p_place_kind = 'site' THEN p_place_id END,
    CASE WHEN p_place_kind = 'zone' THEN p_place_id END,
    btrim(coalesce(p_title, '')), p_hazard_class, p_risk_level,
    v_controls, nullif(btrim(coalesce(p_details, '')), ''),
    'officer_reported', 'reported', v_actor, p_shift_id, p_client_request_id, v_actor
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_shift.organization_id, v_actor, 'place_hazard_reported', 'place_hazards', v_id,
    jsonb_build_object('shift_id', p_shift_id, 'place_kind', p_place_kind, 'place_id', p_place_id, 'hazard_class', p_hazard_class, 'risk_level', p_risk_level));

  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.report_place_hazard(uuid, text, uuid, text, text, text, uuid, text, text[]) IS 'The assigned officer reports a new hazard at one of the places of their in-progress shift. Stored as reported (shown to other officers as not yet reviewed) until a supervisor confirms or retires it. Idempotent on client_request_id; audited.';

-- ââ Administration ââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

CREATE OR REPLACE FUNCTION public.manage_place_hazard(
  p_action text,
  p_hazard_id uuid,
  p_fields jsonb,
  p_client_request_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_fields jsonb := coalesce(p_fields, '{}'::jsonb);
  v_hazard public.place_hazards%rowtype;
  v_org uuid;
  v_location uuid;
  v_site uuid;
  v_zone uuid;
  v_doc uuid;
  v_controls text[];
  v_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_action NOT IN ('create', 'update', 'confirm', 'retire') THEN RAISE EXCEPTION 'Unsupported action %', p_action; END IF;

  IF v_fields ? 'controls' THEN
    SELECT coalesce(array_agg(left(btrim(c), 300)) FILTER (WHERE btrim(c) <> ''), '{}'::text[])
    INTO v_controls FROM jsonb_array_elements_text(coalesce(v_fields->'controls', '[]'::jsonb)) c;
  END IF;
  v_doc := nullif(v_fields->>'source_document_id', '')::uuid;
  IF v_doc IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.documents d WHERE d.id = v_doc AND (d.organization_id IS NULL OR public.org_access_allowed(d.organization_id))
  ) THEN
    RAISE EXCEPTION 'Source document is not available to you';
  END IF;

  IF p_action = 'create' THEN
    IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
    v_org := nullif(v_fields->>'organization_id', '')::uuid;
    v_site := nullif(v_fields->>'client_site_id', '')::uuid;
    v_zone := nullif(v_fields->>'zone_id', '')::uuid;
    v_location := coalesce(
      nullif(v_fields->>'location_id', '')::uuid,
      (SELECT location_id FROM public.client_sites WHERE id = v_site),
      (SELECT location_id FROM public.location_zones WHERE id = v_zone)
    );
    IF v_org IS NULL OR v_location IS NULL THEN RAISE EXCEPTION 'organization_id and a place are required'; END IF;
    IF NOT public.can_manage_place_hazards(v_org, v_location) THEN RAISE EXCEPTION 'Not authorised to manage hazards at this place'; END IF;
    SELECT id INTO v_id FROM public.place_hazards WHERE organization_id = v_org AND client_request_id = p_client_request_id;
    IF FOUND THEN RETURN v_id; END IF;
    INSERT INTO public.place_hazards (
      organization_id, location_id, client_site_id, zone_id, title, hazard_class, risk_level, likelihood, consequence,
      controls, details, source_document_id, source_locator, source_name, source_as_of, review_due,
      origin, status, reviewed_by, reviewed_at, client_request_id, created_by
    ) VALUES (
      v_org, v_location, v_site, v_zone, btrim(coalesce(v_fields->>'title', '')), v_fields->>'hazard_class', v_fields->>'risk_level',
      nullif(v_fields->>'likelihood', '')::smallint, nullif(v_fields->>'consequence', '')::smallint,
      coalesce(v_controls, '{}'::text[]), nullif(btrim(coalesce(v_fields->>'details', '')), ''), v_doc,
      nullif(btrim(coalesce(v_fields->>'source_locator', '')), ''), nullif(btrim(coalesce(v_fields->>'source_name', '')), ''),
      nullif(v_fields->>'source_as_of', '')::date, nullif(v_fields->>'review_due', '')::date,
      'manual', 'active', v_actor, clock_timestamp(), p_client_request_id, v_actor
    ) RETURNING id INTO v_id;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_org, v_actor, 'place_hazard_created', 'place_hazards', v_id, jsonb_build_object('location_id', v_location, 'risk_level', v_fields->>'risk_level'));
    RETURN v_id;
  END IF;

  SELECT * INTO v_hazard FROM public.place_hazards WHERE id = p_hazard_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hazard not found'; END IF;
  IF NOT public.can_manage_place_hazards(v_hazard.organization_id, v_hazard.location_id) THEN RAISE EXCEPTION 'Not authorised to manage this hazard'; END IF;
  IF v_hazard.status = 'retired' THEN RAISE EXCEPTION 'This hazard is retired'; END IF;

  IF p_action = 'update' THEN
    UPDATE public.place_hazards SET
      title = coalesce(nullif(btrim(v_fields->>'title'), ''), title),
      hazard_class = coalesce(nullif(v_fields->>'hazard_class', ''), hazard_class),
      risk_level = coalesce(nullif(v_fields->>'risk_level', ''), risk_level),
      likelihood = CASE WHEN v_fields ? 'likelihood' THEN nullif(v_fields->>'likelihood', '')::smallint ELSE likelihood END,
      consequence = CASE WHEN v_fields ? 'consequence' THEN nullif(v_fields->>'consequence', '')::smallint ELSE consequence END,
      controls = coalesce(v_controls, controls),
      details = CASE WHEN v_fields ? 'details' THEN nullif(btrim(coalesce(v_fields->>'details', '')), '') ELSE details END,
      source_document_id = CASE WHEN v_fields ? 'source_document_id' THEN v_doc ELSE source_document_id END,
      source_locator = CASE WHEN v_fields ? 'source_locator' THEN nullif(btrim(coalesce(v_fields->>'source_locator', '')), '') ELSE source_locator END,
      source_name = CASE WHEN v_fields ? 'source_name' THEN nullif(btrim(coalesce(v_fields->>'source_name', '')), '') ELSE source_name END,
      source_as_of = CASE WHEN v_fields ? 'source_as_of' THEN nullif(v_fields->>'source_as_of', '')::date ELSE source_as_of END,
      review_due = CASE WHEN v_fields ? 'review_due' THEN nullif(v_fields->>'review_due', '')::date ELSE review_due END,
      version = version + 1
    WHERE id = v_hazard.id;
  ELSIF p_action = 'confirm' THEN
    IF v_hazard.status <> 'reported' THEN RAISE EXCEPTION 'Only reported hazards need confirmation'; END IF;
    UPDATE public.place_hazards SET status = 'active', reviewed_by = v_actor, reviewed_at = clock_timestamp(), version = version + 1
    WHERE id = v_hazard.id;
  ELSE
    IF length(btrim(coalesce(v_fields->>'reason', ''))) < 3 THEN RAISE EXCEPTION 'Give a reason for retiring this hazard'; END IF;
    UPDATE public.place_hazards SET status = 'retired', retired_by = v_actor, retired_at = clock_timestamp(), retired_reason = left(btrim(v_fields->>'reason'), 500)
    WHERE id = v_hazard.id;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_hazard.organization_id, v_actor, 'place_hazard_' || CASE p_action WHEN 'update' THEN 'updated' WHEN 'confirm' THEN 'confirmed' ELSE 'retired' END,
    'place_hazards', v_hazard.id, jsonb_build_object('previous_status', v_hazard.status, 'previous_version', v_hazard.version, 'reason', v_fields->>'reason'));
  RETURN v_hazard.id;
END;
$$;
COMMENT ON FUNCTION public.manage_place_hazard(text, uuid, jsonb, uuid) IS 'Administrator create, update (bumps version so officers re-acknowledge), confirm (reported -> active) or retire (reason required) a place hazard. Audited.';

CREATE OR REPLACE FUNCTION public.get_place_hazard_register(p_location_id uuid, p_include_retired boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', h.id, 'organization_id', h.organization_id, 'organization_name', o.name,
      'location_id', h.location_id, 'client_site_id', h.client_site_id, 'zone_id', h.zone_id,
      'place_name', coalesce(cs.name, z.name, l.name),
      'title', h.title, 'hazard_class', h.hazard_class, 'risk_level', h.risk_level,
      'likelihood', h.likelihood, 'consequence', h.consequence, 'controls', to_jsonb(h.controls), 'details', h.details,
      'source_document_id', h.source_document_id, 'source_document_name', d.original_filename,
      'source_name', h.source_name, 'source_locator', h.source_locator, 'source_as_of', h.source_as_of,
      'origin', h.origin, 'status', h.status, 'version', h.version, 'review_due', h.review_due,
      'reported_by_name', rp.display_name, 'reported_shift_id', h.reported_shift_id,
      'reviewed_at', h.reviewed_at, 'retired_at', h.retired_at, 'retired_reason', h.retired_reason,
      'created_at', h.created_at, 'updated_at', h.updated_at,
      'can_manage', public.can_manage_place_hazards(h.organization_id, h.location_id)
    ) ORDER BY CASE h.status WHEN 'reported' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,
               CASE h.risk_level WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, h.title)
    FROM public.place_hazards h
    JOIN public.locations l ON l.id = h.location_id
    JOIN public.organizations o ON o.id = h.organization_id
    LEFT JOIN public.client_sites cs ON cs.id = h.client_site_id
    LEFT JOIN public.location_zones z ON z.id = h.zone_id
    LEFT JOIN public.documents d ON d.id = h.source_document_id
    LEFT JOIN public.user_profiles rp ON rp.id = h.reported_by
    WHERE h.location_id = p_location_id
      AND (p_include_retired OR h.status <> 'retired')
      AND public.can_read_place_hazard(h.organization_id, h.location_id, h.client_site_id, h.zone_id)
  ), '[]'::jsonb);
END;
$$;
COMMENT ON FUNCTION public.get_place_hazard_register(uuid, boolean) IS 'Place hazard register for one house: officer reports awaiting review first, then live hazards critical first, with source and whether the caller may manage each.';

-- Where to open a hazard's source document. Readable by anyone who may read
-- the hazard, or by an officer whose open shift is at that place.
CREATE OR REPLACE FUNCTION public.get_place_hazard_source(p_hazard_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_hazard public.place_hazards%rowtype;
  v_doc public.documents%rowtype;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_hazard FROM public.place_hazards WHERE id = p_hazard_id AND status <> 'retired';
  IF NOT FOUND THEN RAISE EXCEPTION 'Hazard not found'; END IF;
  IF NOT public.can_read_place_hazard(v_hazard.organization_id, v_hazard.location_id, v_hazard.client_site_id, v_hazard.zone_id)
    AND NOT EXISTS (
      SELECT 1 FROM public.shifts s
      CROSS JOIN LATERAL public.shift_safety_places(s.id, NULL) p
      WHERE s.officer_user_id = v_actor
        AND s.status IN ('published', 'accepted', 'in_progress')
        AND p.location_id = v_hazard.location_id
    ) THEN
    RAISE EXCEPTION 'Not authorised to open this source';
  END IF;
  IF v_hazard.source_document_id IS NULL THEN
    RETURN jsonb_build_object('has_document', false, 'source_name', v_hazard.source_name, 'source_locator', v_hazard.source_locator);
  END IF;
  SELECT * INTO v_doc FROM public.documents WHERE id = v_hazard.source_document_id;
  RETURN jsonb_build_object(
    'has_document', v_doc.id IS NOT NULL AND v_doc.storage_object_ref IS NOT NULL,
    'storage_bucket', v_doc.storage_bucket,
    'storage_object_ref', v_doc.storage_object_ref,
    'original_filename', v_doc.original_filename,
    'mime_type', v_doc.mime_type,
    'source_name', v_hazard.source_name,
    'source_locator', v_hazard.source_locator
  );
END;
$$;
COMMENT ON FUNCTION public.get_place_hazard_source(uuid) IS 'Storage location of a hazard''s source document for the place-hazard-source edge function to sign. Allowed for hazard readers and for officers with an open shift at the place.';

-- ââ Bob proposals âââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

-- Bob PROPOSES place hazards distilled from documents he has read (producer:
-- bob-propose-place-hazards). A human approves; this service-only executor
-- applies the approved payload. A live hazard with the same title at the same
-- place and facet is replaced in place (version bumped, so officers
-- re-acknowledge) rather than duplicated.
CREATE OR REPLACE FUNCTION public.apply_bob_place_hazard_proposal(p_action_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action public.bob_agentic_actions%rowtype;
  v_payload jsonb;
  v_org uuid;
  v_location uuid;
  v_site uuid;
  v_zone uuid;
  v_doc uuid;
  v_attachment uuid;
  v_controls text[];
  v_existing public.place_hazards%rowtype;
  v_id uuid;
BEGIN
  SELECT * INTO v_action FROM public.bob_agentic_actions WHERE id = p_action_id FOR UPDATE;
  IF NOT FOUND OR v_action.action_type <> 'create_place_hazard' OR v_action.status <> 'approved' THEN
    RAISE EXCEPTION 'Only approved create_place_hazard actions can be executed';
  END IF;
  IF v_action.result_record_id IS NOT NULL THEN RETURN v_action.result_record_id; END IF;
  SELECT id INTO v_id FROM public.place_hazards WHERE bob_action_id = v_action.id LIMIT 1;
  IF FOUND THEN RETURN v_id; END IF;

  v_payload := coalesce(v_action.amended_payload, v_action.proposed_payload);
  v_org := nullif(v_payload->>'organization_id', '')::uuid;
  v_site := nullif(v_payload->>'client_site_id', '')::uuid;
  v_zone := nullif(v_payload->>'zone_id', '')::uuid;
  v_location := coalesce(
    nullif(v_payload->>'location_id', '')::uuid,
    (SELECT location_id FROM public.client_sites WHERE id = v_site),
    (SELECT location_id FROM public.location_zones WHERE id = v_zone)
  );
  IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_org) THEN RAISE EXCEPTION 'Target organization does not exist'; END IF;
  IF v_location IS NULL OR NOT EXISTS (SELECT 1 FROM public.locations WHERE id = v_location) THEN RAISE EXCEPTION 'Target place does not exist'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = v_action.approved_by AND deactivated_at IS NULL)
    OR NOT public.can_approve_action(v_action.approved_by, v_org) THEN
    RAISE EXCEPTION 'Active organization approver is required';
  END IF;

  SELECT coalesce(array_agg(left(btrim(c), 300)) FILTER (WHERE btrim(c) <> ''), '{}'::text[])
  INTO v_controls FROM jsonb_array_elements_text(coalesce(v_payload->'controls', '[]'::jsonb)) c;

  v_doc := nullif(v_payload->>'source_document_id', '')::uuid;
  v_attachment := nullif(v_payload->>'source_attachment_id', '')::uuid;
  IF v_doc IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.id = v_doc AND (d.organization_id IS NULL OR d.organization_id IN (v_org, v_action.organization_id))) THEN
      RAISE EXCEPTION 'Source document is not available to this organization';
    END IF;
  ELSIF v_attachment IS NOT NULL THEN
    SELECT d.id INTO v_doc FROM public.documents d
    WHERE d.attachment_id = v_attachment AND d.organization_id IN (v_org, v_action.organization_id)
    ORDER BY d.created_at DESC LIMIT 1;
  END IF;

  SELECT * INTO v_existing FROM public.place_hazards h
  WHERE h.organization_id = v_org AND h.location_id = v_location
    AND h.client_site_id IS NOT DISTINCT FROM v_site AND h.zone_id IS NOT DISTINCT FROM v_zone
    AND h.status <> 'retired' AND lower(btrim(h.title)) = lower(btrim(v_payload->>'title'))
  ORDER BY h.updated_at DESC LIMIT 1
  FOR UPDATE;

  IF v_existing.id IS NOT NULL THEN
    UPDATE public.place_hazards SET
      hazard_class = v_payload->>'hazard_class',
      risk_level = v_payload->>'risk_level',
      likelihood = nullif(v_payload->>'likelihood', '')::smallint,
      consequence = nullif(v_payload->>'consequence', '')::smallint,
      controls = v_controls,
      details = nullif(btrim(coalesce(v_payload->>'details', '')), ''),
      source_document_id = coalesce(v_doc, source_document_id),
      source_locator = nullif(btrim(coalesce(v_payload->>'source_locator', '')), ''),
      source_name = nullif(btrim(coalesce(v_payload->>'source_name', '')), ''),
      source_as_of = nullif(v_payload->>'source_as_of', '')::date,
      review_due = coalesce(nullif(v_payload->>'review_due', '')::date, review_due),
      status = 'active',
      reviewed_by = v_action.approved_by,
      reviewed_at = clock_timestamp(),
      bob_action_id = v_action.id,
      version = version + 1
    WHERE id = v_existing.id
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO public.place_hazards (
      organization_id, location_id, client_site_id, zone_id, title, hazard_class, risk_level, likelihood, consequence,
      controls, details, source_document_id, source_locator, source_name, source_as_of, review_due,
      origin, status, reviewed_by, reviewed_at, bob_action_id, client_request_id, created_by
    ) VALUES (
      v_org, v_location, v_site, v_zone, btrim(coalesce(v_payload->>'title', '')), v_payload->>'hazard_class', v_payload->>'risk_level',
      nullif(v_payload->>'likelihood', '')::smallint, nullif(v_payload->>'consequence', '')::smallint,
      v_controls, nullif(btrim(coalesce(v_payload->>'details', '')), ''), v_doc,
      nullif(btrim(coalesce(v_payload->>'source_locator', '')), ''), nullif(btrim(coalesce(v_payload->>'source_name', '')), ''),
      nullif(v_payload->>'source_as_of', '')::date, nullif(v_payload->>'review_due', '')::date,
      'bob_extracted', 'active', v_action.approved_by, clock_timestamp(), v_action.id, v_action.id, v_action.approved_by
    ) RETURNING id INTO v_id;
  END IF;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_action.approved_by, 'bob_place_hazard_proposal_applied', 'place_hazards', v_id,
    jsonb_build_object('action_id', v_action.id, 'replaced_hazard_id', v_existing.id, 'source_document_id', v_doc, 'source_attachment_id', v_attachment));

  RETURN v_id;
END;
$$;
COMMENT ON FUNCTION public.apply_bob_place_hazard_proposal(uuid) IS 'Service-only executor for approved create_place_hazard actions. Idempotent on the action id; replaces a live hazard with the same title at the same place and facet (version bump forces officer re-acknowledgement); audited.';

-- ââ Grants ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

REVOKE ALL ON FUNCTION public.place_hazards_check_facet() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_read_place_hazard(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_read_place_hazard(uuid, uuid, uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_manage_place_hazards(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_place_hazards(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.shift_safety_places(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shift_safety_places(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.build_shift_safety_briefing(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.build_shift_safety_briefing(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.get_shift_safety_briefing(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_shift_safety_briefing(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.acknowledge_safety_briefing(uuid, text, uuid, uuid, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.acknowledge_safety_briefing(uuid, text, uuid, uuid, double precision, double precision) TO authenticated;
REVOKE ALL ON FUNCTION public.report_place_hazard(uuid, text, uuid, text, text, text, uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_place_hazard(uuid, text, uuid, text, text, text, uuid, text, text[]) TO authenticated;
REVOKE ALL ON FUNCTION public.manage_place_hazard(text, uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.manage_place_hazard(text, uuid, jsonb, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_place_hazard_register(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_place_hazard_register(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_place_hazard_source(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_place_hazard_source(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.apply_bob_place_hazard_proposal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_bob_place_hazard_proposal(uuid) TO service_role;
