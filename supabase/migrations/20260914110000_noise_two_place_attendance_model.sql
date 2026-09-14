-- Noise control two-place attendance model.
-- Owner ruling 2026-09-14: the place of harm is the address the officer attends;
-- noise has two — the complainant (harmed party, protected) and the noise source
-- (subject, where the work, the assessment and the END/seizure are recorded) —
-- both linked on the job, both geofenced, each attendance verified, complainant
-- contact recorded, and the client report reflecting exactly what happened.
-- Design: docs/canon/NOISE_CONTROL_TWO_PLACE_MODEL.md. Statute: RMA 1991 ss 16,
-- 322-323, 326-328, 336, 338-339 (s327(3) END period = 8 days since 21 Aug 2025).
-- Additive only. No existing policy dropped; no writer changed except the noise
-- submit RPC, which keeps its signature.

-- ── 1. dispatch_jobs: the harmed-party place and the SLA delay reason ─────────
ALTER TABLE public.dispatch_jobs
  ADD COLUMN IF NOT EXISTS harmed_party_site_id uuid REFERENCES public.client_sites(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS harmed_party_address text,
  ADD COLUMN IF NOT EXISTS sla_delay_reason text;
COMMENT ON COLUMN public.dispatch_jobs.harmed_party_site_id IS
  'Place of harm (complainant / protected land) as a client_sites facet. client_site_id remains the work place (noise source). Ruling 2026-09-14.';
COMMENT ON COLUMN public.dispatch_jobs.harmed_party_address IS
  'Complainant / harmed-party address as received. Readable only where the harmed-party read applies; never on served documents.';
COMMENT ON COLUMN public.dispatch_jobs.sla_delay_reason IS
  'Mandatory explanation when arrival breached the SLA clock; the client report must state any material delay and its reasons.';
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_harmed_party_site ON public.dispatch_jobs (harmed_party_site_id) WHERE harmed_party_site_id IS NOT NULL;

-- ── 2. shift_stops: which place this attendance is, and geofence verification ─
ALTER TABLE public.shift_stops
  ADD COLUMN IF NOT EXISTS place_role text NOT NULL DEFAULT 'work_place',
  ADD COLUMN IF NOT EXISTS arrived_gps_accuracy double precision,
  ADD COLUMN IF NOT EXISTS arrival_verification text,
  ADD COLUMN IF NOT EXISTS arrival_distance_m numeric(10,1),
  ADD COLUMN IF NOT EXISTS departed_gps_lat double precision,
  ADD COLUMN IF NOT EXISTS departed_gps_lng double precision,
  ADD COLUMN IF NOT EXISTS bwc_reference text;
ALTER TABLE public.shift_stops DROP CONSTRAINT IF EXISTS shift_stops_place_role_check;
ALTER TABLE public.shift_stops ADD CONSTRAINT shift_stops_place_role_check
  CHECK (place_role IN ('work_place', 'harmed_party_place'));
ALTER TABLE public.shift_stops DROP CONSTRAINT IF EXISTS shift_stops_arrival_verification_check;
ALTER TABLE public.shift_stops ADD CONSTRAINT shift_stops_arrival_verification_check
  CHECK (arrival_verification IS NULL OR arrival_verification IN ('verified_on_site', 'near_site', 'off_site', 'unverified_boundary', 'no_geofence', 'no_gps'));
COMMENT ON COLUMN public.shift_stops.place_role IS
  'work_place = the place the job is done at (noise source); harmed_party_place = the complainant / protected place. One ad-hoc stop per place attended, per visit.';
COMMENT ON COLUMN public.shift_stops.arrival_verification IS
  'Server-computed geofence result at arrival. Loud, never blocking: verified_on_site | near_site | off_site | unverified_boundary | no_geofence | no_gps.';
COMMENT ON COLUMN public.shift_stops.bwc_reference IS 'Body-worn camera recording reference spoken/logged at arrival (job number, type, address).';
CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_stops_dispatch_place_visit
  ON public.shift_stops (dispatch_job_id, place_role, visit_number) WHERE dispatch_job_id IS NOT NULL AND is_adhoc;

-- ── 3. noise_module_config: END validity is council data under a statutory cap ─
ALTER TABLE public.noise_module_config ADD COLUMN IF NOT EXISTS end_validity_hours smallint NOT NULL DEFAULT 192;
ALTER TABLE public.noise_module_config DROP CONSTRAINT IF EXISTS noise_module_config_end_validity_hours_check;
ALTER TABLE public.noise_module_config ADD CONSTRAINT noise_module_config_end_validity_hours_check
  CHECK (end_validity_hours BETWEEN 1 AND 192);
COMMENT ON COLUMN public.noise_module_config.end_validity_hours IS
  'Period an excessive noise direction binds. RMA s327(3) (amended 21 Aug 2025): 8 days (192 h) or such shorter period as the officer specifies. Councils may configure shorter; never longer.';

-- ── 4. noise_assessments: stop links, measured position, END particulars ──────
-- shift_id: the live RPC (re-issued by 20260913131500) inserts it, but the column
-- was never created (20260905008200 had removed it from the INSERT for that
-- reason). Every officer submission has failed since; adding the column restores
-- the write and gives the assessment its shift link.
ALTER TABLE public.noise_assessments
  ADD COLUMN IF NOT EXISTS shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_stop_id uuid REFERENCES public.shift_stops(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS complainant_stop_id uuid REFERENCES public.shift_stops(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assessment_distance_to_complainant_m numeric(10,1),
  ADD COLUMN IF NOT EXISTS assessment_distance_to_source_m numeric(10,1),
  ADD COLUMN IF NOT EXISTS end_expires_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS end_given_orally boolean,
  ADD COLUMN IF NOT EXISTS end_recipient_role text,
  ADD COLUMN IF NOT EXISTS entry_notice_left boolean;
ALTER TABLE public.noise_assessments DROP CONSTRAINT IF EXISTS noise_assessments_end_recipient_role_check;
ALTER TABLE public.noise_assessments ADD CONSTRAINT noise_assessments_end_recipient_role_check
  CHECK (end_recipient_role IS NULL OR end_recipient_role IN ('occupier', 'responsible_person', 'unoccupied_notice_left'));
COMMENT ON COLUMN public.noise_assessments.assessment_distance_to_complainant_m IS
  'Server-computed distance from the assessment GPS to the complainant place. The report states the position without the address (s326: judged as it affects a person other than one at the emitting place).';
COMMENT ON COLUMN public.noise_assessments.end_expires_at IS 'assessed_at + noise_module_config.end_validity_hours when an END was given (s327(3)).';
COMMENT ON COLUMN public.noise_assessments.entry_notice_left IS 's328(5): copy of the written END and the entry notice left in a prominent position when the place was unoccupied.';

-- ── 5. Protected parties: complainant identity behind a guarded path ──────────
CREATE TABLE IF NOT EXISTS public.dispatch_job_protected_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dispatch_job_id uuid NOT NULL REFERENCES public.dispatch_jobs(id) ON DELETE CASCADE,
  party_role text NOT NULL CHECK (party_role IN ('complainant', 'occupant', 'witness', 'landowner')),
  display_name text,
  phone text,
  email text,
  notes text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (dispatch_job_id, party_role)
);
COMMENT ON TABLE public.dispatch_job_protected_parties IS
  'Sensitive party identity for a dispatch job (complainant etc.). No read policy: readable only through get_dispatch_job_protected_party, which applies the three-question test and logs the read (Privacy Act IPP 6). NOTICES_HARMED_PARTY_SENSITIVITY option (a).';
ALTER TABLE public.dispatch_job_protected_parties ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_job_protected_parties FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.dispatch_job_protected_parties TO service_role;

-- ── 6. Party interactions: "the officer spoke to the complainant" ─────────────
CREATE TABLE IF NOT EXISTS public.job_party_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dispatch_job_id uuid NOT NULL REFERENCES public.dispatch_jobs(id) ON DELETE CASCADE,
  noise_assessment_id uuid REFERENCES public.noise_assessments(id) ON DELETE SET NULL,
  shift_stop_id uuid REFERENCES public.shift_stops(id) ON DELETE SET NULL,
  party_role text NOT NULL CHECK (party_role IN ('complainant', 'occupant', 'witness', 'police', 'other')),
  mode text NOT NULL CHECK (mode IN ('in_person', 'phone', 'message', 'no_answer')),
  occurred_at timestamp with time zone NOT NULL,
  gps_lat double precision,
  gps_lng double precision,
  gps_accuracy double precision,
  summary text,
  protected boolean NOT NULL DEFAULT true,
  officer_user_id uuid NOT NULL,
  client_request_id uuid NOT NULL UNIQUE,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.job_party_interactions IS
  'Recorded contact with a party to a dispatch job (complainant, occupant, witness, Police). Linked to the job, the assessment and the stop so the client report reflects exactly what happened. Identity lives in dispatch_job_protected_parties, never here.';
CREATE INDEX IF NOT EXISTS idx_job_party_interactions_job ON public.job_party_interactions (dispatch_job_id, occurred_at);
ALTER TABLE public.job_party_interactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS job_party_interactions_custody_select ON public.job_party_interactions;
CREATE POLICY job_party_interactions_custody_select ON public.job_party_interactions
  FOR SELECT TO authenticated
  USING (
    officer_user_id = auth.uid()
    OR public.is_admin_for_org(organization_id)
    OR EXISTS (
      SELECT 1 FROM public.user_profiles p
      WHERE p.id = auth.uid() AND p.deactivated_at IS NULL
        AND p.organization_id = job_party_interactions.organization_id
        AND p.role = 'admin_officer'
    )
  );
REVOKE INSERT, UPDATE, DELETE ON TABLE public.job_party_interactions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.job_party_interactions TO authenticated;
GRANT ALL ON TABLE public.job_party_interactions TO service_role;

-- ── 7. Dispatcher records the harmed party (place + protected identity) ───────
CREATE OR REPLACE FUNCTION public.set_dispatch_job_harmed_party(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_harmed_party_site_id uuid DEFAULT NULL,
  p_harmed_party_address text DEFAULT NULL,
  p_party_role text DEFAULT 'complainant',
  p_display_name text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_notes text DEFAULT NULL
) RETURNS TABLE(out_dispatch_job_id uuid, out_harmed_party_site_id uuid, protected_party_recorded boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_job public.dispatch_jobs%rowtype;
  v_has_identity boolean;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT p.organization_id, p.role INTO v_org, v_role FROM public.user_profiles p WHERE p.id = v_user AND p.deactivated_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active profile required'; END IF;
  SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found'; END IF;
  IF NOT (public.is_admin_for_org(v_job.organization_id) OR (v_role = 'admin_officer' AND v_org = v_job.organization_id)) THEN
    RAISE EXCEPTION 'Dispatcher or administrator of the custodian organisation required';
  END IF;
  IF p_party_role NOT IN ('complainant', 'occupant', 'witness', 'landowner') THEN RAISE EXCEPTION 'Unsupported party role'; END IF;
  IF p_harmed_party_site_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.client_sites cs WHERE cs.id = p_harmed_party_site_id) THEN
    RAISE EXCEPTION 'Harmed-party site not found';
  END IF;

  UPDATE public.dispatch_jobs
  SET harmed_party_site_id = COALESCE(p_harmed_party_site_id, dispatch_jobs.harmed_party_site_id),
      harmed_party_address = COALESCE(nullif(trim(coalesce(p_harmed_party_address, '')), ''), dispatch_jobs.harmed_party_address)
  WHERE id = v_job.id;

  v_has_identity := nullif(trim(coalesce(p_display_name, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(p_phone, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(p_email, '')), '') IS NOT NULL
    OR nullif(trim(coalesce(p_notes, '')), '') IS NOT NULL;
  IF v_has_identity THEN
    INSERT INTO public.dispatch_job_protected_parties (organization_id, dispatch_job_id, party_role, display_name, phone, email, notes, created_by, updated_by)
    VALUES (v_job.organization_id, v_job.id, p_party_role, nullif(trim(coalesce(p_display_name, '')), ''), nullif(trim(coalesce(p_phone, '')), ''), nullif(trim(coalesce(p_email, '')), ''), nullif(trim(coalesce(p_notes, '')), ''), v_user, v_user)
    ON CONFLICT (dispatch_job_id, party_role) DO UPDATE
      SET display_name = COALESCE(EXCLUDED.display_name, dispatch_job_protected_parties.display_name),
          phone = COALESCE(EXCLUDED.phone, dispatch_job_protected_parties.phone),
          email = COALESCE(EXCLUDED.email, dispatch_job_protected_parties.email),
          notes = COALESCE(EXCLUDED.notes, dispatch_job_protected_parties.notes),
          updated_by = v_user, updated_at = now();
  END IF;

  -- Audit carries the fact of the record, never the identity values.
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, v_user, 'dispatch_job_harmed_party_set', 'dispatch_jobs', v_job.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'party_role', p_party_role,
      'harmed_party_site_id', p_harmed_party_site_id, 'identity_recorded', v_has_identity));

  RETURN QUERY SELECT v_job.id, COALESCE(p_harmed_party_site_id, v_job.harmed_party_site_id), v_has_identity;
END;
$$;
REVOKE ALL ON FUNCTION public.set_dispatch_job_harmed_party(uuid, uuid, uuid, text, text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_dispatch_job_harmed_party(uuid, uuid, uuid, text, text, text, text, text, text) TO authenticated, service_role;

-- ── 8. Guarded, audited read of a protected party (three-question test) ───────
CREATE OR REPLACE FUNCTION public.get_dispatch_job_protected_party(p_dispatch_job_id uuid, p_party_role text DEFAULT 'complainant')
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_role text;
  v_job public.dispatch_jobs%rowtype;
  v_party public.dispatch_job_protected_parties%rowtype;
  v_basis text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT p.organization_id, p.role INTO v_org, v_role FROM public.user_profiles p WHERE p.id = v_user AND p.deactivated_at IS NULL;
  SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id;
  -- Reject by non-appearance: a missing job and a job outside the caller's custody look identical.
  IF NOT FOUND OR v_org IS NULL OR v_org <> v_job.organization_id THEN
    RETURN jsonb_build_object('available', false, 'reason', 'no_basis');
  END IF;
  -- Authorised: custodian admin or dispatcher; the attending officer while the job is live.
  IF public.is_admin_for_org(v_job.organization_id) OR v_role = 'admin_officer' THEN
    v_basis := 'custodian_admin';
  ELSIF v_job.status NOT IN ('completed', 'cancelled') AND (
      v_job.assigned_officer_id = v_user
      OR EXISTS (SELECT 1 FROM public.dispatch_resources dr WHERE dr.id = v_job.dispatch_resource_id AND dr.assigned_officer_id = v_user)) THEN
    v_basis := 'attending_officer';
  ELSE
    RETURN jsonb_build_object('available', false, 'reason', 'no_basis');
  END IF;

  SELECT * INTO v_party FROM public.dispatch_job_protected_parties pp
  WHERE pp.dispatch_job_id = v_job.id AND pp.party_role = p_party_role;

  -- Every read of protected identity is logged (IPP 6), including empty ones.
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, v_user, 'protected_party_read', 'dispatch_job_protected_parties', v_party.id,
    jsonb_build_object('dispatch_job_id', v_job.id, 'party_role', p_party_role, 'basis', v_basis, 'found', v_party.id IS NOT NULL));

  IF v_party.id IS NULL THEN RETURN jsonb_build_object('available', false, 'reason', 'not_recorded', 'basis', v_basis); END IF;
  RETURN jsonb_build_object('available', true, 'basis', v_basis, 'party_role', v_party.party_role,
    'display_name', v_party.display_name, 'phone', v_party.phone, 'email', v_party.email, 'notes', v_party.notes,
    'harmed_party_address', v_job.harmed_party_address, 'harmed_party_site_id', v_job.harmed_party_site_id);
END;
$$;
REVOKE ALL ON FUNCTION public.get_dispatch_job_protected_party(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_dispatch_job_protected_party(uuid, text) TO authenticated, service_role;

-- ── 9. Arrival at a place of the job: find-or-create the ad-hoc stop, verify ──
CREATE OR REPLACE FUNCTION public.arrive_at_dispatch_place(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_place_role text DEFAULT 'work_place',
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_gps_accuracy double precision DEFAULT NULL,
  p_bwc_reference text DEFAULT NULL
) RETURNS TABLE(stop_id uuid, created boolean, arrived_at timestamp with time zone, arrival_verification text, arrival_distance_m numeric, visit_number integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_job public.dispatch_jobs%rowtype;
  v_site public.client_sites%rowtype;
  v_stop public.shift_stops%rowtype;
  v_receipt public.officer_command_requests%rowtype;
  v_site_id uuid;
  v_shift_id uuid;
  v_point geometry;
  v_distance numeric;
  v_verification text;
  v_onsite_m numeric;
  v_approach_m numeric;
  v_next_visit integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_place_role NOT IN ('work_place', 'harmed_party_place') THEN RAISE EXCEPTION 'place_role must be work_place or harmed_party_place'; END IF;
  SELECT p.organization_id INTO v_org FROM public.user_profiles p
  WHERE p.id = v_user AND p.deactivated_at IS NULL AND p.role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active officer profile required'; END IF;

  SELECT * INTO v_receipt FROM public.officer_command_requests r WHERE r.request_id = p_client_request_id::text;
  IF FOUND AND v_receipt.actor_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'client_request_id belongs to another actor'; END IF;
  IF FOUND AND v_receipt.command_status = 'completed' THEN
    RETURN QUERY SELECT (v_receipt.response->>'stop_id')::uuid, false, (v_receipt.response->>'arrived_at')::timestamptz,
      v_receipt.response->>'arrival_verification', (v_receipt.response->>'arrival_distance_m')::numeric, (v_receipt.response->>'visit_number')::integer;
    RETURN;
  END IF;

  SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id AND d.organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found in the officer organisation'; END IF;
  IF NOT (v_job.assigned_officer_id = v_user OR public.is_admin_for_org(v_org)
      OR EXISTS (SELECT 1 FROM public.dispatch_resources dr WHERE dr.id = v_job.dispatch_resource_id AND dr.assigned_officer_id = v_user)) THEN
    RAISE EXCEPTION 'Only the assigned officer may record attendance for this job';
  END IF;

  v_site_id := CASE p_place_role WHEN 'work_place' THEN v_job.client_site_id ELSE v_job.harmed_party_site_id END;
  IF p_place_role = 'harmed_party_place' AND v_site_id IS NULL AND v_job.harmed_party_address IS NULL THEN
    RAISE EXCEPTION 'This job has no harmed-party place recorded';
  END IF;

  v_shift_id := v_job.shift_id;
  IF v_shift_id IS NULL THEN
    SELECT s.id INTO v_shift_id FROM public.shifts s
    WHERE s.officer_user_id = v_user AND s.organization_id = v_org AND s.status = 'in_progress'
    ORDER BY s.actual_start DESC NULLS LAST LIMIT 1;
  END IF;
  IF v_shift_id IS NULL THEN RAISE EXCEPTION 'An in-progress shift is required to record attendance'; END IF;

  -- Geofence verification: loud, never blocking (GEOFENCE_PRINCIPLES P1/P2).
  IF p_gps_lat IS NULL OR p_gps_lng IS NULL THEN
    v_verification := 'no_gps';
  ELSE
    v_point := ST_SetSRID(ST_MakePoint(p_gps_lng, p_gps_lat), 4326);
    IF v_site_id IS NOT NULL THEN SELECT * INTO v_site FROM public.client_sites cs WHERE cs.id = v_site_id; END IF;
    IF v_site.id IS NULL OR (v_site.boundary IS NULL AND v_site.center_point IS NULL) THEN
      v_verification := 'no_geofence';
    ELSE
      v_distance := round((CASE WHEN v_site.boundary IS NOT NULL
        THEN ST_Distance(v_site.boundary::geography, v_point::geography)
        ELSE ST_Distance(v_site.center_point::geography, v_point::geography) END)::numeric, 1);
      v_onsite_m := COALESCE(v_site.onsite_radius_meters, 10);
      SELECT c.config_value::numeric INTO v_approach_m FROM public.org_geofence_config c
      WHERE c.organization_id = v_org AND c.config_key = 'approach_radius_m' AND c.zone_type IS NULL LIMIT 1;
      v_approach_m := COALESCE(v_approach_m, v_site.prompt_radius_meters, 50);
      IF v_site.boundary_verification IS DISTINCT FROM 'verified' THEN v_verification := 'unverified_boundary';
      ELSIF v_distance <= v_onsite_m THEN v_verification := 'verified_on_site';
      ELSIF v_distance <= v_approach_m THEN v_verification := 'near_site';
      ELSE v_verification := 'off_site';
      END IF;
    END IF;
  END IF;

  SELECT * INTO v_stop FROM public.shift_stops st
  WHERE st.dispatch_job_id = v_job.id AND st.place_role = p_place_role AND st.status NOT IN ('completed', 'cancelled', 'skipped')
  ORDER BY st.visit_number DESC LIMIT 1;
  IF NOT FOUND THEN
    SELECT COALESCE(max(st.visit_number), 0) + 1 INTO v_next_visit FROM public.shift_stops st WHERE st.dispatch_job_id = v_job.id AND st.place_role = p_place_role;
    INSERT INTO public.shift_stops (organization_id, shift_id, site_id, module_key, stop_order, visit_number, is_adhoc, dispatch_job_id,
      sla_arrive_by, required_dwell_minutes, status, place_role)
    VALUES (v_org, v_shift_id, v_site_id, COALESCE(v_job.module_key, 'noise_control'),
      (SELECT COALESCE(max(so.stop_order), 0) + 1 FROM public.shift_stops so WHERE so.shift_id = v_shift_id),
      v_next_visit, true, v_job.id, COALESCE(v_job.sla_respond_by, now()), COALESCE(v_job.expected_dwell_minutes, 15), 'on_scene', p_place_role)
    RETURNING * INTO v_stop;
  END IF;

  UPDATE public.shift_stops
  SET actual_arrived_at = COALESCE(shift_stops.actual_arrived_at, now()),
      arrived_gps_lat = COALESCE(p_gps_lat, shift_stops.arrived_gps_lat),
      arrived_gps_lng = COALESCE(p_gps_lng, shift_stops.arrived_gps_lng),
      arrived_gps_accuracy = COALESCE(p_gps_accuracy, shift_stops.arrived_gps_accuracy),
      arrival_verification = v_verification,
      arrival_distance_m = v_distance,
      bwc_reference = COALESCE(nullif(trim(coalesce(p_bwc_reference, '')), ''), shift_stops.bwc_reference),
      status = 'on_scene',
      sla_status = CASE WHEN COALESCE(shift_stops.actual_arrived_at, now()) > shift_stops.sla_arrive_by THEN 'breached' ELSE shift_stops.sla_status END,
      updated_at = now()
  WHERE id = v_stop.id
  RETURNING * INTO v_stop;

  IF p_place_role = 'work_place' THEN
    UPDATE public.dispatch_jobs
    SET on_scene_at = COALESCE(dispatch_jobs.on_scene_at, v_stop.actual_arrived_at),
        status = CASE WHEN dispatch_jobs.status IN ('dispatched', 'acknowledged', 'en_route') THEN 'on_scene' ELSE dispatch_jobs.status END,
        sla_breached = CASE WHEN dispatch_jobs.sla_respond_by IS NOT NULL AND v_stop.actual_arrived_at > dispatch_jobs.sla_respond_by THEN true ELSE dispatch_jobs.sla_breached END
    WHERE id = v_job.id;
  END IF;

  INSERT INTO public.officer_command_requests (request_id, organization_id, actor_user_id, shift_id, site_id, command_type, command_status, response)
  VALUES (p_client_request_id::text, v_org, v_user, v_shift_id, v_site_id, 'arrive_at_dispatch_place', 'completed',
    jsonb_build_object('stop_id', v_stop.id, 'arrived_at', v_stop.actual_arrived_at, 'arrival_verification', v_verification,
      'arrival_distance_m', v_distance, 'visit_number', v_stop.visit_number, 'place_role', p_place_role))
  ON CONFLICT (request_id) DO UPDATE SET command_status = 'completed', response = EXCLUDED.response;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_user, 'dispatch_place_arrival_recorded', 'shift_stops', v_stop.id,
    jsonb_build_object('dispatch_job_id', v_job.id, 'place_role', p_place_role, 'arrival_verification', v_verification,
      'arrival_distance_m', v_distance, 'visit_number', v_stop.visit_number, 'bwc_reference_recorded', v_stop.bwc_reference IS NOT NULL));

  RETURN QUERY SELECT v_stop.id, true, v_stop.actual_arrived_at, v_verification, v_distance, v_stop.visit_number;
END;
$$;
REVOKE ALL ON FUNCTION public.arrive_at_dispatch_place(uuid, uuid, text, double precision, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.arrive_at_dispatch_place(uuid, uuid, text, double precision, double precision, double precision, text) TO authenticated, service_role;

-- ── 10. Departure from a place of the job ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.depart_dispatch_place(
  p_client_request_id uuid,
  p_stop_id uuid,
  p_officer_notes text DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_sla_delay_reason text DEFAULT NULL
) RETURNS TABLE(stop_id uuid, departed_at timestamp with time zone, sla_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_stop public.shift_stops%rowtype;
  v_job public.dispatch_jobs%rowtype;
  v_receipt public.officer_command_requests%rowtype;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  SELECT p.organization_id INTO v_org FROM public.user_profiles p WHERE p.id = v_user AND p.deactivated_at IS NULL;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active profile required'; END IF;

  SELECT * INTO v_receipt FROM public.officer_command_requests r WHERE r.request_id = p_client_request_id::text;
  IF FOUND AND v_receipt.actor_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'client_request_id belongs to another actor'; END IF;
  IF FOUND AND v_receipt.command_status = 'completed' THEN
    RETURN QUERY SELECT (v_receipt.response->>'stop_id')::uuid, (v_receipt.response->>'departed_at')::timestamptz, v_receipt.response->>'sla_status';
    RETURN;
  END IF;

  SELECT * INTO v_stop FROM public.shift_stops st WHERE st.id = p_stop_id AND st.organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stop not found in the officer organisation'; END IF;
  IF v_stop.dispatch_job_id IS NOT NULL THEN SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = v_stop.dispatch_job_id; END IF;
  IF NOT (public.is_admin_for_org(v_org)
      OR EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = v_stop.shift_id AND s.officer_user_id = v_user)
      OR (v_job.id IS NOT NULL AND (v_job.assigned_officer_id = v_user
          OR EXISTS (SELECT 1 FROM public.dispatch_resources dr WHERE dr.id = v_job.dispatch_resource_id AND dr.assigned_officer_id = v_user)))) THEN
    RAISE EXCEPTION 'Only the attending officer may record departure for this stop';
  END IF;
  IF v_stop.actual_arrived_at IS NULL THEN RAISE EXCEPTION 'Arrival must be recorded before departure'; END IF;

  -- The contract requires every material delay to be explained in the report.
  IF v_stop.place_role = 'work_place' AND v_job.id IS NOT NULL AND v_job.sla_respond_by IS NOT NULL
     AND v_stop.actual_arrived_at > v_job.sla_respond_by
     AND nullif(trim(coalesce(p_sla_delay_reason, v_job.sla_delay_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Arrival breached the response SLA; a delay reason is required before departure';
  END IF;

  UPDATE public.shift_stops
  SET status = 'completed',
      actual_departed_at = COALESCE(shift_stops.actual_departed_at, now()),
      departed_gps_lat = COALESCE(p_gps_lat, shift_stops.departed_gps_lat),
      departed_gps_lng = COALESCE(p_gps_lng, shift_stops.departed_gps_lng),
      officer_notes = COALESCE(nullif(trim(coalesce(p_officer_notes, '')), ''), shift_stops.officer_notes),
      sla_status = CASE WHEN shift_stops.actual_arrived_at > shift_stops.sla_arrive_by THEN 'breached' ELSE 'completed' END,
      updated_at = now()
  WHERE id = v_stop.id
  RETURNING * INTO v_stop;

  IF v_job.id IS NOT NULL AND nullif(trim(coalesce(p_sla_delay_reason, '')), '') IS NOT NULL THEN
    UPDATE public.dispatch_jobs SET sla_delay_reason = trim(p_sla_delay_reason) WHERE id = v_job.id;
  END IF;

  INSERT INTO public.officer_command_requests (request_id, organization_id, actor_user_id, shift_id, site_id, command_type, command_status, response)
  VALUES (p_client_request_id::text, v_org, v_user, v_stop.shift_id, v_stop.site_id, 'depart_dispatch_place', 'completed',
    jsonb_build_object('stop_id', v_stop.id, 'departed_at', v_stop.actual_departed_at, 'sla_status', v_stop.sla_status))
  ON CONFLICT (request_id) DO UPDATE SET command_status = 'completed', response = EXCLUDED.response;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_user, 'dispatch_place_departure_recorded', 'shift_stops', v_stop.id,
    jsonb_build_object('dispatch_job_id', v_stop.dispatch_job_id, 'place_role', v_stop.place_role, 'sla_status', v_stop.sla_status,
      'delay_reason_recorded', nullif(trim(coalesce(p_sla_delay_reason, '')), '') IS NOT NULL));

  RETURN QUERY SELECT v_stop.id, v_stop.actual_departed_at, v_stop.sla_status;
END;
$$;
REVOKE ALL ON FUNCTION public.depart_dispatch_place(uuid, uuid, text, double precision, double precision, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.depart_dispatch_place(uuid, uuid, text, double precision, double precision, text) TO authenticated, service_role;

-- ── 11. Recording contact with a party (complainant, occupant, witness, Police) ─
CREATE OR REPLACE FUNCTION public.record_job_party_interaction(
  p_client_request_id uuid,
  p_dispatch_job_id uuid,
  p_party_role text,
  p_mode text,
  p_occurred_at timestamp with time zone DEFAULT now(),
  p_summary text DEFAULT NULL,
  p_noise_assessment_id uuid DEFAULT NULL,
  p_shift_stop_id uuid DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_gps_accuracy double precision DEFAULT NULL
) RETURNS TABLE(id uuid, created boolean, occurred_at timestamp with time zone)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_org uuid;
  v_job public.dispatch_jobs%rowtype;
  v_existing public.job_party_interactions%rowtype;
  v_row public.job_party_interactions%rowtype;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_party_role NOT IN ('complainant', 'occupant', 'witness', 'police', 'other') THEN RAISE EXCEPTION 'Unsupported party role'; END IF;
  IF p_mode NOT IN ('in_person', 'phone', 'message', 'no_answer') THEN RAISE EXCEPTION 'Unsupported interaction mode'; END IF;
  IF p_occurred_at IS NULL OR p_occurred_at > now() + interval '5 minutes' OR p_occurred_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'occurred_at is outside the accepted capture window';
  END IF;
  SELECT p.organization_id INTO v_org FROM public.user_profiles p
  WHERE p.id = v_user AND p.deactivated_at IS NULL AND p.role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active officer profile required'; END IF;

  SELECT * INTO v_existing FROM public.job_party_interactions i WHERE i.client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.officer_user_id <> v_user THEN RAISE EXCEPTION 'client_request_id belongs to another actor'; END IF;
    RETURN QUERY SELECT v_existing.id, false, v_existing.occurred_at; RETURN;
  END IF;

  SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id AND d.organization_id = v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job not found in the officer organisation'; END IF;
  IF NOT (v_job.assigned_officer_id = v_user OR public.is_admin_for_org(v_org)
      OR EXISTS (SELECT 1 FROM public.dispatch_resources dr WHERE dr.id = v_job.dispatch_resource_id AND dr.assigned_officer_id = v_user)) THEN
    RAISE EXCEPTION 'Only the assigned officer may record interactions for this job';
  END IF;
  IF p_noise_assessment_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.noise_assessments na WHERE na.id = p_noise_assessment_id AND na.organization_id = v_org) THEN
    RAISE EXCEPTION 'Noise assessment not found in the officer organisation';
  END IF;
  IF p_shift_stop_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shift_stops st WHERE st.id = p_shift_stop_id AND st.dispatch_job_id = v_job.id) THEN
    RAISE EXCEPTION 'Stop does not belong to this job';
  END IF;

  INSERT INTO public.job_party_interactions (organization_id, dispatch_job_id, noise_assessment_id, shift_stop_id, party_role, mode, occurred_at,
    gps_lat, gps_lng, gps_accuracy, summary, protected, officer_user_id, client_request_id)
  VALUES (v_org, v_job.id, p_noise_assessment_id, p_shift_stop_id, p_party_role, p_mode, p_occurred_at,
    p_gps_lat, p_gps_lng, p_gps_accuracy, nullif(trim(coalesce(p_summary, '')), ''), p_party_role IN ('complainant', 'witness'), v_user, p_client_request_id)
  RETURNING * INTO v_row;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org, v_user, 'job_party_interaction_recorded', 'job_party_interactions', v_row.id,
    jsonb_build_object('dispatch_job_id', v_job.id, 'party_role', p_party_role, 'mode', p_mode, 'noise_assessment_id', p_noise_assessment_id, 'shift_stop_id', p_shift_stop_id));

  RETURN QUERY SELECT v_row.id, true, v_row.occurred_at;
END;
$$;
REVOKE ALL ON FUNCTION public.record_job_party_interaction(uuid, uuid, text, text, timestamp with time zone, text, uuid, uuid, double precision, double precision, double precision) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_job_party_interaction(uuid, uuid, text, text, timestamp with time zone, text, uuid, uuid, double precision, double precision, double precision) TO authenticated, service_role;

-- ── 12. The governed assessment submit: derive both places from the job ───────
-- Same signature as live (no overload). Adds: derivation of source/complainant
-- from the dispatch job, stop links, measured distances, END expiry and the
-- statutory preconditions (END needs a complaint; seizure needs Police).
CREATE OR REPLACE FUNCTION "public"."submit_officer_noise_assessment"(p_client_request_id uuid, p_assessed_at timestamp with time zone, p_noise_source text, p_noise_source_address text, p_action_taken text DEFAULT 'no_action'::text, p_volume_score smallint DEFAULT 0, p_time_score smallint DEFAULT 1, p_tone_score smallint DEFAULT 0, p_complaint_address text DEFAULT NULL::text, p_complainant_site_id uuid DEFAULT NULL::uuid, p_notice_number text DEFAULT NULL::text, p_end_number text DEFAULT NULL::text, p_occupant_name text DEFAULT NULL::text, p_occupant_dob date DEFAULT NULL::date, p_is_large_event_or_commercial boolean DEFAULT false, p_police_requested boolean DEFAULT false, p_police_present boolean DEFAULT false, p_scene_description text DEFAULT NULL::text, p_incident_report_text text DEFAULT NULL::text, p_follow_up_required boolean DEFAULT false, p_shift_id uuid DEFAULT NULL::uuid, p_dispatch_job_id uuid DEFAULT NULL::uuid, p_gps_lat double precision DEFAULT NULL::double precision, p_gps_lng double precision DEFAULT NULL::double precision)
 RETURNS TABLE(id uuid, created boolean, received_at timestamp with time zone, review_status text, matrix_total smallint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid := auth.uid();
  v_org_id uuid;
  v_existing public.noise_assessments%rowtype;
  v_assessment public.noise_assessments%rowtype;
  v_job public.dispatch_jobs%rowtype;
  v_matrix_total smallint;
  v_threshold smallint := 5;
  v_end_validity_hours smallint := 192;
  v_excessive boolean;
  v_site_id uuid;
  v_complainant_site_id uuid := p_complainant_site_id;
  v_complaint_address text := nullif(trim(coalesce(p_complaint_address, '')), '');
  v_source_stop_id uuid;
  v_complainant_stop_id uuid;
  v_point geometry;
  v_dist_complainant numeric;
  v_dist_source numeric;
  v_end_expires_at timestamptz;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT p.organization_id INTO v_org_id FROM public.user_profiles p
  WHERE p.id = v_user_id AND p.deactivated_at IS NULL
    AND p.role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'Active officer profile required'; END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'client_request_id is required'; END IF;
  IF p_assessed_at IS NULL OR p_assessed_at > now() + interval '5 minutes' OR p_assessed_at < now() - interval '24 hours' THEN RAISE EXCEPTION 'assessed_at is outside the accepted capture window'; END IF;
  IF nullif(trim(coalesce(p_noise_source_address, '')), '') IS NULL THEN RAISE EXCEPTION 'Noise source address is required'; END IF;
  IF nullif(trim(coalesce(p_noise_source, '')), '') IS NULL THEN RAISE EXCEPTION 'Noise source type is required'; END IF;
  IF p_volume_score NOT BETWEEN 0 AND 4 THEN RAISE EXCEPTION 'Volume score must be between 0 and 4'; END IF;
  IF p_time_score NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'Time score must be between 1 and 4'; END IF;
  IF p_tone_score NOT BETWEEN 0 AND 2 THEN RAISE EXCEPTION 'Tone score must be between 0 and 2'; END IF;

  v_matrix_total := coalesce(p_volume_score, 0) + coalesce(p_time_score, 1) + coalesce(p_tone_score, 0);
  SELECT n.excessive_threshold, n.end_validity_hours INTO v_threshold, v_end_validity_hours
  FROM public.noise_module_config n
  WHERE n.organization_id = v_org_id AND n.is_current
    AND n.effective_from <= current_date
    AND (n.effective_to IS NULL OR n.effective_to >= current_date)
  ORDER BY n.effective_from DESC, n.version DESC
  LIMIT 1;
  IF v_threshold IS NULL THEN v_threshold := 5; END IF;
  IF v_end_validity_hours IS NULL THEN v_end_validity_hours := 192; END IF;
  v_excessive := (v_matrix_total >= v_threshold);

  IF p_action_taken IN ('abatement_notice', 'direction_notice', 'enforcement_notice', 'equipment_seized')
    AND nullif(trim(coalesce(p_notice_number, coalesce(p_end_number, ''))), '') IS NULL THEN
    RAISE EXCEPTION 'Notice or END number is required for statutory noise enforcement actions';
  END IF;
  -- RMA s327(1)(a): an excessive noise direction follows a received complaint.
  IF p_action_taken = 'direction_notice' AND p_dispatch_job_id IS NULL THEN
    RAISE EXCEPTION 'An excessive noise direction requires a linked complaint (dispatch job); use the abatement path for officer-initiated noise';
  END IF;
  -- RMA s328(3) / s323(2): seizure is exercised accompanied by a constable.
  IF p_action_taken = 'equipment_seized' AND NOT coalesce(p_police_present, false) THEN
    RAISE EXCEPTION 'Equipment seizure requires Police present (RMA s328(3))';
  END IF;
  IF p_shift_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = p_shift_id AND s.organization_id = v_org_id) THEN RAISE EXCEPTION 'Shift does not belong to the officer organisation'; END IF;
  IF p_dispatch_job_id IS NOT NULL THEN
    SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id AND d.organization_id = v_org_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Dispatch job does not belong to the officer organisation'; END IF;
  END IF;

  SELECT n.* INTO v_existing FROM public.noise_assessments n
  WHERE n.organization_id = v_org_id AND n.officer_user_id = v_user_id AND n.client_request_id = p_client_request_id;
  IF FOUND THEN RETURN QUERY SELECT v_existing.id, false, v_existing.created_at, v_existing.review_status, v_existing.matrix_total; RETURN; END IF;

  -- Both places come from the job when the officer did not supply them (rule #157: site_id = source).
  IF v_job.id IS NOT NULL THEN
    v_site_id := v_job.client_site_id;
    v_complainant_site_id := COALESCE(v_complainant_site_id, v_job.harmed_party_site_id);
    v_complaint_address := COALESCE(v_complaint_address, v_job.harmed_party_address);
    SELECT st.id INTO v_source_stop_id FROM public.shift_stops st
    WHERE st.dispatch_job_id = v_job.id AND st.place_role = 'work_place' AND st.actual_arrived_at IS NOT NULL ORDER BY st.visit_number DESC LIMIT 1;
    SELECT st.id INTO v_complainant_stop_id FROM public.shift_stops st
    WHERE st.dispatch_job_id = v_job.id AND st.place_role = 'harmed_party_place' AND st.actual_arrived_at IS NOT NULL ORDER BY st.visit_number DESC LIMIT 1;
  END IF;

  -- Measured position: how close the officer assessed to the complainant, and to the source.
  IF p_gps_lat IS NOT NULL AND p_gps_lng IS NOT NULL THEN
    v_point := ST_SetSRID(ST_MakePoint(p_gps_lng, p_gps_lat), 4326);
    SELECT round(ST_Distance(COALESCE(cs.boundary, cs.center_point)::geography, v_point::geography)::numeric, 1) INTO v_dist_complainant
    FROM public.client_sites cs WHERE cs.id = v_complainant_site_id AND (cs.boundary IS NOT NULL OR cs.center_point IS NOT NULL);
    SELECT round(ST_Distance(COALESCE(cs.boundary, cs.center_point)::geography, v_point::geography)::numeric, 1) INTO v_dist_source
    FROM public.client_sites cs WHERE cs.id = v_site_id AND (cs.boundary IS NOT NULL OR cs.center_point IS NOT NULL);
  END IF;

  IF p_action_taken = 'direction_notice' THEN
    v_end_expires_at := p_assessed_at + make_interval(hours => v_end_validity_hours);
  END IF;

  INSERT INTO public.noise_assessments (
    organization_id, officer_user_id, officer_id, client_request_id, assessed_at,
    noise_source, noise_source_address, assessment_location, action_taken, action,
    volume_score, time_score, tone_score, matrix_total, complaint_address,
    complainant_site_id, notice_number, end_number, occupant_name, occupant_dob,
    is_large_event_or_commercial, police_requested, police_present, scene_description,
    incident_report_text, follow_up_required, shift_id, dispatch_job_id, status,
    review_status, assessment_gps_lat, assessment_gps_lng,
    site_id, complainant_protected, source_stop_id, complainant_stop_id,
    assessment_distance_to_complainant_m, assessment_distance_to_source_m, end_expires_at
  ) VALUES (
    v_org_id, v_user_id, v_user_id, p_client_request_id, p_assessed_at,
    trim(p_noise_source), trim(p_noise_source_address), trim(p_noise_source_address),
    p_action_taken, p_action_taken, p_volume_score, p_time_score, p_tone_score,
    v_matrix_total, v_complaint_address,
    v_complainant_site_id, nullif(trim(coalesce(p_notice_number, '')), ''),
    nullif(trim(coalesce(p_end_number, '')), ''), nullif(trim(coalesce(p_occupant_name, '')), ''),
    p_occupant_dob, coalesce(p_is_large_event_or_commercial, false),
    coalesce(p_police_requested, false), coalesce(p_police_present, false),
    nullif(trim(coalesce(p_scene_description, '')), ''),
    nullif(trim(coalesce(p_incident_report_text, '')), ''),
    coalesce(p_follow_up_required, false), p_shift_id, p_dispatch_job_id, 'open', 'open',
    p_gps_lat, p_gps_lng,
    v_site_id, true, v_source_stop_id, v_complainant_stop_id,
    v_dist_complainant, v_dist_source, v_end_expires_at
  ) RETURNING * INTO v_assessment;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_org_id, v_user_id, 'noise_assessment_submitted', 'noise_assessments', v_assessment.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'noise_source', v_assessment.noise_source,
      'matrix_total', v_matrix_total, 'excessive', v_excessive, 'action_taken', v_assessment.action_taken,
      'notice_number', v_assessment.notice_number, 'dispatch_job_id', p_dispatch_job_id,
      'source_stop_id', v_source_stop_id, 'complainant_stop_id', v_complainant_stop_id,
      'assessment_distance_to_complainant_m', v_dist_complainant, 'assessment_distance_to_source_m', v_dist_source,
      'end_expires_at', v_end_expires_at));

  RETURN QUERY SELECT v_assessment.id, true, v_assessment.created_at, v_assessment.review_status, v_assessment.matrix_total;
END;
$function$;

-- ── 13. The client attendance report: exactly what happened, disclosed by basis ─
CREATE OR REPLACE FUNCTION public.get_noise_attendance_report(p_dispatch_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user uuid := auth.uid();
  v_role text;
  v_job public.dispatch_jobs%rowtype;
  v_custodian boolean;
  v_harmed_party_reader boolean;
  v_source_reader boolean;
  v_stops jsonb;
  v_assessments jsonb;
  v_interactions jsonb;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_job FROM public.dispatch_jobs d WHERE d.id = p_dispatch_job_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('available', false, 'reason', 'no_basis'); END IF;
  SELECT p.role INTO v_role FROM public.user_profiles p WHERE p.id = v_user AND p.deactivated_at IS NULL AND p.organization_id = v_job.organization_id;

  -- Bases are never NULL: a reader outside the custodian org has no role row, and NULL must redact, never disclose.
  v_custodian := COALESCE(public.is_admin_for_org(v_job.organization_id) OR v_role = 'admin_officer', false);
  v_harmed_party_reader := COALESCE(v_job.harmed_party_site_id IS NOT NULL AND public.has_location_access(v_job.harmed_party_site_id, NULL::uuid, 'client_reads_provider'), false);
  v_source_reader := COALESCE(v_job.client_site_id IS NOT NULL AND public.has_location_access(v_job.client_site_id, NULL::uuid, 'client_reads_provider'), false);
  IF NOT (v_custodian OR v_harmed_party_reader OR v_source_reader OR COALESCE(public.org_access_allowed(v_job.organization_id), false)) THEN
    RETURN jsonb_build_object('available', false, 'reason', 'no_basis');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'place_role', st.place_role, 'visit_number', st.visit_number,
      'site_id', CASE WHEN st.place_role <> 'harmed_party_place' OR v_custodian OR v_harmed_party_reader THEN st.site_id ELSE NULL END,
      'sla_arrive_by', st.sla_arrive_by, 'arrived_at', st.actual_arrived_at, 'departed_at', st.actual_departed_at,
      'sla_status', st.sla_status, 'arrival_verification', st.arrival_verification, 'arrival_distance_m', st.arrival_distance_m,
      'arrived_gps_accuracy', st.arrived_gps_accuracy, 'bwc_reference_recorded', st.bwc_reference IS NOT NULL,
      'officer_notes', CASE WHEN v_custodian THEN st.officer_notes ELSE NULL END
    ) ORDER BY st.actual_arrived_at NULLS LAST, st.visit_number), '[]'::jsonb)
  INTO v_stops FROM public.shift_stops st WHERE st.dispatch_job_id = v_job.id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', na.id, 'assessed_at', na.assessed_at, 'noise_source', na.noise_source, 'noise_source_address', na.noise_source_address,
      'volume_score', na.volume_score, 'time_score', na.time_score, 'tone_score', na.tone_score, 'matrix_total', na.matrix_total,
      'assessment_distance_to_complainant_m', na.assessment_distance_to_complainant_m, 'assessment_distance_to_source_m', na.assessment_distance_to_source_m,
      'action_taken', na.action_taken, 'end_number', na.end_number, 'notice_number', na.notice_number, 'end_expires_at', na.end_expires_at,
      'end_given_orally', na.end_given_orally, 'end_recipient_role', na.end_recipient_role, 'entry_notice_left', na.entry_notice_left,
      'police_requested', na.police_requested, 'police_present', na.police_present,
      'hs_abort_reason', na.hs_abort_reason, 'follow_up_required', na.follow_up_required, 'review_status', na.review_status,
      'complaint_address', CASE WHEN v_custodian OR v_harmed_party_reader THEN na.complaint_address ELSE NULL END,
      'complainant_site_id', CASE WHEN v_custodian OR v_harmed_party_reader THEN na.complainant_site_id ELSE NULL END,
      'scene_description', CASE WHEN v_custodian THEN na.scene_description ELSE NULL END,
      'occupant_name', CASE WHEN v_custodian THEN na.occupant_name ELSE NULL END
    ) ORDER BY na.assessed_at), '[]'::jsonb)
  INTO v_assessments FROM public.noise_assessments na WHERE na.dispatch_job_id = v_job.id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'party_role', i.party_role, 'mode', i.mode, 'occurred_at', i.occurred_at, 'at_stop_id', i.shift_stop_id,
      'summary', CASE WHEN v_custodian THEN i.summary ELSE NULL END
    ) ORDER BY i.occurred_at), '[]'::jsonb)
  INTO v_interactions FROM public.job_party_interactions i WHERE i.dispatch_job_id = v_job.id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_job.organization_id, v_user, 'noise_attendance_report_read', 'dispatch_jobs', v_job.id,
    jsonb_build_object('custodian', v_custodian, 'harmed_party_reader', v_harmed_party_reader, 'source_reader', v_source_reader));

  RETURN jsonb_build_object(
    'available', true,
    'disclosure', jsonb_build_object('custodian', v_custodian, 'harmed_party_place', v_custodian OR v_harmed_party_reader, 'complainant_identity', false),
    'job', jsonb_build_object('id', v_job.id, 'module_key', v_job.module_key, 'job_type', v_job.job_type, 'priority', v_job.priority, 'status', v_job.status,
      'received_at', v_job.created_at, 'dispatched_at', v_job.dispatched_at, 'acknowledged_at', v_job.acknowledged_at, 'en_route_at', v_job.en_route_at,
      'on_scene_at', v_job.on_scene_at, 'completed_at', v_job.completed_at, 'sla_minutes', v_job.sla_minutes, 'sla_respond_by', v_job.sla_respond_by,
      'sla_breached', v_job.sla_breached, 'sla_delay_reason', v_job.sla_delay_reason, 'outcome_notes', v_job.outcome_notes,
      'work_place_site_id', v_job.client_site_id,
      'harmed_party_site_id', CASE WHEN v_custodian OR v_harmed_party_reader THEN v_job.harmed_party_site_id ELSE NULL END,
      'harmed_party_address', CASE WHEN v_custodian OR v_harmed_party_reader THEN v_job.harmed_party_address ELSE NULL END),
    'attendances', v_stops,
    'assessments', v_assessments,
    'interactions', v_interactions
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_noise_attendance_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_noise_attendance_report(uuid) TO authenticated, service_role;
