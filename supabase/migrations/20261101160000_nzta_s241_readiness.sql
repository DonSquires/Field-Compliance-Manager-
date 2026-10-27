-- NZTA s241 readiness for Motor Vehicle Register (MVR) information.
--
-- Owner rulings (2026-10-28, recorded in docs/canon/ACCESS_MODEL.md):
-- * Person names are not restricted on their own. What is restricted is the
--   NZTA-sourced person<->vehicle link, in both directions.
-- * Only users authorised for vehicle-owner identity may see that link, and only
--   after stating a lawful purpose. Each reveal is logged.
-- * The organisation a trespass/warning notice was issued on behalf of, and the
--   user investigating it, may use the information for that notice.
-- * Anonymous callers must not read the platform person register.
-- * Retention is report-only until NZTA confirms the period; nothing is deleted.
--
-- Gazette 2025-au4644 purposes (R&M Security and Investigations):
--   trespass_unpermitted_vehicle   vehicle on a contracted property without a valid permit
--   cctv_patrol_signage_breach     entry or damage seen on CCTV/patrol against posted signage
-- notice_follow_up is an in-app reveal purpose only: following up a notice that
-- was already issued from one of those two purposes.

-- 1. Anonymous callers can no longer read the platform person register.
REVOKE SELECT ON public.canonical_person_public FROM anon;

-- 2. Motochek lookup register (T&C clauses 13-16).
CREATE TABLE public.nzta_register_lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  looked_up_at timestamptz NOT NULL,
  plate_number text,
  vin text,
  canonical_vehicle_id uuid REFERENCES public.canonical_vehicles(id) ON DELETE SET NULL,
  motochek_user text NOT NULL CHECK (length(btrim(motochek_user)) BETWEEN 2 AND 120),
  purpose text NOT NULL CHECK (purpose IN ('trespass_unpermitted_vehicle', 'cctv_patrol_signage_breach')),
  explanation text NOT NULL CHECK (length(btrim(explanation)) BETWEEN 10 AND 2000),
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  observation_id uuid REFERENCES public.observations(id) ON DELETE SET NULL,
  evidence_item_id uuid REFERENCES public.evidence_items(id) ON DELETE SET NULL,
  notice_id uuid REFERENCES public.notices(id) ON DELETE SET NULL,
  vehicle_identity_check_id uuid REFERENCES public.vehicle_identity_checks(id) ON DELETE SET NULL,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'trespass_notice', 'damage_letter', 'debt_collection', 'no_action')),
  outcome_notes text CHECK (outcome_notes IS NULL OR length(outcome_notes) <= 2000),
  outcome_recorded_at timestamptz,
  outcome_recorded_by uuid REFERENCES public.user_profiles(id),
  created_by uuid NOT NULL REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT nzta_register_lookups_vehicle_key CHECK (plate_number IS NOT NULL OR vin IS NOT NULL)
);
COMMENT ON TABLE public.nzta_register_lookups IS
  'One row per Motochek/MVR lookup: date, plate/VIN, individual Motochek user, Gazette purpose, explanation, supporting links and outcome (NZTA T&C 13-16). Written only through record_nzta_register_lookup.';
CREATE INDEX nzta_register_lookups_org_time_idx ON public.nzta_register_lookups (organization_id, looked_up_at DESC);
CREATE INDEX nzta_register_lookups_vehicle_idx ON public.nzta_register_lookups (canonical_vehicle_id);
CREATE INDEX nzta_register_lookups_location_idx ON public.nzta_register_lookups (location_id);
CREATE INDEX nzta_register_lookups_observation_idx ON public.nzta_register_lookups (observation_id);
CREATE INDEX nzta_register_lookups_evidence_idx ON public.nzta_register_lookups (evidence_item_id);
CREATE INDEX nzta_register_lookups_notice_idx ON public.nzta_register_lookups (notice_id);
-- One lookup per NZTA check, so a check is never counted as both explained and unexplained.
CREATE UNIQUE INDEX nzta_register_lookups_check_idx ON public.nzta_register_lookups (vehicle_identity_check_id)
  WHERE vehicle_identity_check_id IS NOT NULL;
CREATE INDEX nzta_register_lookups_created_by_idx ON public.nzta_register_lookups (created_by);
CREATE INDEX nzta_register_lookups_outcome_by_idx ON public.nzta_register_lookups (outcome_recorded_by);

-- 3. In-app reveal log: who saw an NZTA person<->vehicle link, when, and why.
CREATE TABLE public.nzta_register_access_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  actor_user_id uuid NOT NULL REFERENCES public.user_profiles(id),
  subject_type text NOT NULL CHECK (subject_type IN ('vehicle', 'person')),
  subject_id uuid NOT NULL,
  purpose text NOT NULL
    CHECK (purpose IN ('trespass_unpermitted_vehicle', 'cctv_patrol_signage_breach', 'notice_follow_up')),
  explanation text NOT NULL CHECK (length(btrim(explanation)) BETWEEN 10 AND 2000),
  lookup_id uuid REFERENCES public.nzta_register_lookups(id) ON DELETE SET NULL,
  notice_id uuid REFERENCES public.notices(id) ON DELETE SET NULL,
  observation_id uuid REFERENCES public.observations(id) ON DELETE SET NULL,
  training_current boolean NOT NULL,
  confidentiality_current boolean NOT NULL,
  revealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL
);
COMMENT ON TABLE public.nzta_register_access_log IS
  'Append-only log of purpose-stated reveals of NZTA person<->vehicle links. A reveal opens a short window for that user and subject only.';
CREATE INDEX nzta_register_access_log_window_idx
  ON public.nzta_register_access_log (actor_user_id, subject_type, subject_id, expires_at DESC);
CREATE INDEX nzta_register_access_log_org_time_idx ON public.nzta_register_access_log (organization_id, revealed_at DESC);
CREATE INDEX nzta_register_access_log_lookup_idx ON public.nzta_register_access_log (lookup_id);
CREATE INDEX nzta_register_access_log_notice_idx ON public.nzta_register_access_log (notice_id);
CREATE INDEX nzta_register_access_log_observation_idx ON public.nzta_register_access_log (observation_id);

-- 4. Training and confidentiality attestations (T&C clauses 11-12).
CREATE TABLE public.nzta_access_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id),
  attestation_type text NOT NULL CHECK (attestation_type IN ('training', 'confidentiality')),
  completed_on date NOT NULL,
  expires_on date NOT NULL,
  provider text CHECK (provider IS NULL OR length(provider) <= 200),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  recorded_by uuid NOT NULL REFERENCES public.user_profiles(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES public.user_profiles(id),
  withdrawn_reason text,
  CONSTRAINT nzta_access_attestations_window CHECK (
    expires_on > completed_on AND expires_on <= (completed_on + interval '12 months')::date)
);
COMMENT ON TABLE public.nzta_access_attestations IS
  'NZTA register training and confidentiality acceptance per user. Refresh at least every 12 months (T&C 11-12).';
CREATE INDEX nzta_access_attestations_user_idx
  ON public.nzta_access_attestations (user_id, attestation_type, expires_on DESC);
CREATE INDEX nzta_access_attestations_org_idx ON public.nzta_access_attestations (organization_id);
CREATE INDEX nzta_access_attestations_recorded_by_idx ON public.nzta_access_attestations (recorded_by);
CREATE INDEX nzta_access_attestations_withdrawn_by_idx ON public.nzta_access_attestations (withdrawn_by);

-- 5. Quarterly access reviews.
CREATE TABLE public.nzta_access_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  period_start date NOT NULL,
  period_end date NOT NULL,
  reviewed_by uuid NOT NULL REFERENCES public.user_profiles(id),
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  holders jsonb NOT NULL DEFAULT '[]'::jsonb,
  findings text NOT NULL CHECK (length(btrim(findings)) BETWEEN 10 AND 4000),
  actions text CHECK (actions IS NULL OR length(actions) <= 4000),
  CONSTRAINT nzta_access_reviews_period CHECK (period_end >= period_start)
);
COMMENT ON TABLE public.nzta_access_reviews IS
  'Quarterly review of who holds NZTA register access, with a snapshot of holders and their training status.';
CREATE INDEX nzta_access_reviews_org_idx ON public.nzta_access_reviews (organization_id, period_end DESC);
CREATE INDEX nzta_access_reviews_reviewed_by_idx ON public.nzta_access_reviews (reviewed_by);

ALTER TABLE public.nzta_register_lookups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nzta_register_access_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nzta_access_attestations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.nzta_access_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nzta_register_lookups, public.nzta_register_access_log,
  public.nzta_access_attestations, public.nzta_access_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.nzta_register_lookups, public.nzta_register_access_log,
  public.nzta_access_attestations, public.nzta_access_reviews TO authenticated;
GRANT ALL ON public.nzta_register_lookups, public.nzta_register_access_log,
  public.nzta_access_attestations, public.nzta_access_reviews TO service_role;

CREATE POLICY nzta_register_lookups_select ON public.nzta_register_lookups FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id) OR created_by = (SELECT auth.uid()));
CREATE POLICY nzta_register_access_log_select ON public.nzta_register_access_log FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id) OR actor_user_id = (SELECT auth.uid()));
CREATE POLICY nzta_access_attestations_select ON public.nzta_access_attestations FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id) OR user_id = (SELECT auth.uid()));
CREATE POLICY nzta_access_reviews_select ON public.nzta_access_reviews FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id));

-- 6. Helpers.
CREATE OR REPLACE FUNCTION public.nzta_reveal_active(p_organization_ids uuid[], p_subject_type text, p_subject_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.nzta_register_access_log log
    WHERE log.actor_user_id = auth.uid()
      AND log.subject_type = p_subject_type AND log.subject_id = p_subject_id
      AND log.organization_id = ANY (coalesce(p_organization_ids, ARRAY[]::uuid[]))
      AND log.expires_at > clock_timestamp()
  );
$function$;
REVOKE ALL ON FUNCTION public.nzta_reveal_active(uuid[], text, uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.nzta_reveal_active(uuid[], text, uuid) IS
  'True when the caller has an open, purpose-stated reveal window for this subject in one of the organisations.';

CREATE OR REPLACE FUNCTION public.nzta_access_readiness(p_user_id uuid, p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH latest AS (
    SELECT DISTINCT ON (a.attestation_type) a.attestation_type, a.completed_on, a.expires_on
    FROM public.nzta_access_attestations a
    -- Training and confidentiality are personal: they are recorded against the
    -- user's home organisation and count wherever that user holds access.
    WHERE a.user_id = p_user_id AND a.withdrawn_at IS NULL
      AND a.organization_id = coalesce(
        (SELECT profile.organization_id FROM public.user_profiles profile WHERE profile.id = p_user_id),
        p_organization_id)
    ORDER BY a.attestation_type, a.expires_on DESC, a.created_at DESC
  )
  SELECT jsonb_build_object(
    'training_completed_on', (SELECT completed_on FROM latest WHERE attestation_type = 'training'),
    'training_expires_on', (SELECT expires_on FROM latest WHERE attestation_type = 'training'),
    'training_current', coalesce((SELECT expires_on >= current_date FROM latest WHERE attestation_type = 'training'), false),
    'confidentiality_completed_on', (SELECT completed_on FROM latest WHERE attestation_type = 'confidentiality'),
    'confidentiality_expires_on', (SELECT expires_on FROM latest WHERE attestation_type = 'confidentiality'),
    'confidentiality_current', coalesce((SELECT expires_on >= current_date FROM latest WHERE attestation_type = 'confidentiality'), false)
  );
$function$;
REVOKE ALL ON FUNCTION public.nzta_access_readiness(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Seconds left on the caller's open reveal for a subject, measured on the server
-- clock so screens can remask at the deadline without trusting the device clock.
-- Each organisation keeps its latest window; the earliest of those is returned.
CREATE OR REPLACE FUNCTION public.get_nzta_reveal_seconds_remaining(
  p_subject_type text, p_subject_id uuid, p_organization_id uuid DEFAULT NULL)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT ceil(extract(epoch FROM min(org_window.expires_at) - clock_timestamp()))::integer
  FROM (
    SELECT log.organization_id, max(log.expires_at) AS expires_at
    FROM public.nzta_register_access_log log
    WHERE auth.uid() IS NOT NULL AND log.actor_user_id = auth.uid()
      AND log.subject_type = p_subject_type AND log.subject_id = p_subject_id
      AND (p_organization_id IS NULL OR log.organization_id = p_organization_id)
      AND log.expires_at > clock_timestamp()
      AND public.can_access_vehicle_owner_identity(log.organization_id)
    GROUP BY log.organization_id
  ) org_window;
$function$;

-- NZTA source documents (images/PDFs of Motochek results) are as sensitive as
-- the person<->vehicle link itself. Once a document is linked to an NZTA check,
-- it, its attachment, its evidence row and its Storage object are readable only
-- while the caller holds an open reveal for that check's vehicle or person.
CREATE OR REPLACE FUNCTION public.nzta_document_restricted(p_document_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.vehicle_identity_checks c
    JOIN public.person_identity_documents d ON d.id = c.identity_document_id
    WHERE c.identity_document_id = p_document_id
      AND d.document_kind = 'nzta_mvr_record'
      AND NOT coalesce(
        public.can_access_vehicle_owner_identity(c.organization_id)
        AND (public.nzta_reveal_active(ARRAY[c.organization_id], 'vehicle', c.canonical_vehicle_id)
             OR (c.canonical_person_id IS NOT NULL
                 AND public.nzta_reveal_active(ARRAY[c.organization_id], 'person', c.canonical_person_id))),
        false)
  );
$function$;

CREATE OR REPLACE FUNCTION public.nzta_attachment_restricted(p_attachment_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.person_identity_documents d
    WHERE d.attachment_id = p_attachment_id AND d.document_kind = 'nzta_mvr_record'
      AND public.nzta_document_restricted(d.id)
  );
$function$;

CREATE OR REPLACE FUNCTION public.nzta_storage_object_restricted(p_bucket text, p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.bob_attachments a
    WHERE a.storage_bucket = p_bucket AND a.storage_path = p_name
      AND public.nzta_attachment_restricted(a.id)
  );
$function$;

CREATE OR REPLACE FUNCTION public.nzta_evidence_restricted(p_evidence_item_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.vehicle_identity_checks c
    WHERE c.evidence_item_id = p_evidence_item_id AND public.nzta_document_restricted(c.identity_document_id)
  ) OR EXISTS (
    SELECT 1 FROM public.person_identity_documents d
    WHERE d.evidence_item_id = p_evidence_item_id AND d.document_kind = 'nzta_mvr_record'
      AND public.nzta_document_restricted(d.id)
  );
$function$;

CREATE INDEX IF NOT EXISTS person_identity_documents_evidence_item_idx
  ON public.person_identity_documents (evidence_item_id) WHERE evidence_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS vehicle_identity_checks_evidence_item_idx
  ON public.vehicle_identity_checks (evidence_item_id) WHERE evidence_item_id IS NOT NULL;

-- A notice can justify a follow-up reveal only for the subject it was issued about.
CREATE OR REPLACE FUNCTION public.nzta_notice_matches_subject(p_notice_id uuid, p_subject_type text, p_subject_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.notices notice
    WHERE notice.id = p_notice_id
      AND notice.status = 'issued' AND notice.notice_type IN ('trespass', 'warning')
      AND CASE p_subject_type
        WHEN 'person' THEN notice.person_id = p_subject_id
        WHEN 'vehicle' THEN (
          EXISTS (
            SELECT 1 FROM public.vehicles notice_vehicle
            JOIN public.canonical_vehicles subject_vehicle ON subject_vehicle.id = p_subject_id
            WHERE notice_vehicle.id = notice.vehicle_id
              AND upper(regexp_replace(notice_vehicle.plate, '[^A-Za-z0-9]', '', 'g'))
                = upper(regexp_replace(subject_vehicle.plate_number, '[^A-Za-z0-9]', '', 'g')))
          OR (notice.person_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.entity_links link
            WHERE link.organization_id = notice.organization_id
              AND link.from_type = 'person' AND link.from_id = notice.person_id
              AND link.to_type = 'vehicle' AND link.to_id = p_subject_id)))
        ELSE false END
  );
$function$;
REVOKE ALL ON FUNCTION public.nzta_notice_matches_subject(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;

-- Every path that grants vehicle_owner_identity (direct grant, preset
-- assignment, or adding the area to a preset) requires current training and
-- confidentiality for each person who would gain it. Existing active grants
-- are not revoked; they are reported as not ready instead.
CREATE OR REPLACE FUNCTION public.enforce_nzta_grant_readiness()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ready jsonb;
  v_unready integer;
BEGIN
  IF TG_TABLE_NAME = 'staff_area_grants' THEN
    IF NEW.area <> 'vehicle_owner_identity' OR NEW.status <> 'active' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.area = NEW.area
       AND OLD.user_id = NEW.user_id AND OLD.scope_org_id = NEW.scope_org_id THEN
      RETURN NEW;
    END IF;
    v_ready := public.nzta_access_readiness(NEW.user_id, NEW.scope_org_id);
  ELSIF TG_TABLE_NAME = 'preset_assignments' THEN
    IF NEW.status <> 'active' THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'active' AND OLD.preset_id = NEW.preset_id
       AND OLD.user_id = NEW.user_id AND OLD.scope_org_id = NEW.scope_org_id THEN
      RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.access_presets preset
                   WHERE preset.id = NEW.preset_id AND preset.grants ? 'vehicle_owner_identity') THEN
      RETURN NEW;
    END IF;
    v_ready := public.nzta_access_readiness(NEW.user_id, NEW.scope_org_id);
  ELSE
    IF TG_OP <> 'UPDATE' OR NOT (NEW.grants ? 'vehicle_owner_identity')
       OR (OLD.grants ? 'vehicle_owner_identity') THEN
      RETURN NEW;
    END IF;
    SELECT count(*) INTO v_unready
    FROM public.preset_assignments assignment
    CROSS JOIN LATERAL public.nzta_access_readiness(assignment.user_id, assignment.scope_org_id) readiness
    WHERE assignment.preset_id = NEW.id AND assignment.status = 'active'
      AND NOT ((readiness->>'training_current')::boolean AND (readiness->>'confidentiality_current')::boolean);
    IF v_unready > 0 THEN
      RAISE EXCEPTION '% people assigned this preset have no current NZTA register training and confidentiality acceptance. Record both before adding NZTA register access to the preset.', v_unready
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT ((v_ready->>'training_current')::boolean AND (v_ready->>'confidentiality_current')::boolean) THEN
    RAISE EXCEPTION 'Record current NZTA register training and confidentiality acceptance before granting access'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_nzta_grant_readiness() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_nzta_grant_readiness BEFORE INSERT OR UPDATE ON public.staff_area_grants
  FOR EACH ROW EXECUTE FUNCTION public.enforce_nzta_grant_readiness();
CREATE TRIGGER trg_nzta_grant_readiness BEFORE INSERT OR UPDATE ON public.preset_assignments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_nzta_grant_readiness();
CREATE TRIGGER trg_nzta_grant_readiness BEFORE UPDATE OF grants ON public.access_presets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_nzta_grant_readiness();

-- 7. Lookup register RPCs.
CREATE OR REPLACE FUNCTION public.record_nzta_register_lookup(
  p_organization_id uuid, p_looked_up_at timestamptz, p_plate_number text, p_vin text,
  p_motochek_user text, p_purpose text, p_explanation text,
  p_location_id uuid DEFAULT NULL, p_observation_id uuid DEFAULT NULL, p_notice_id uuid DEFAULT NULL,
  p_vehicle_identity_check_id uuid DEFAULT NULL, p_evidence_item_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_plate text := nullif(upper(regexp_replace(coalesce(p_plate_number, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_vin text := nullif(upper(regexp_replace(coalesce(p_vin, ''), '[^A-Za-z0-9]', '', 'g')), '');
  v_vehicle uuid;
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR p_organization_id IS NULL
     OR NOT public.can_access_vehicle_owner_identity(p_organization_id) THEN
    RAISE EXCEPTION 'NZTA register authorisation required' USING ERRCODE = '42501';
  END IF;
  IF v_plate IS NULL AND v_vin IS NULL THEN RAISE EXCEPTION 'Enter the plate or VIN that was looked up'; END IF;
  IF p_looked_up_at IS NULL OR p_looked_up_at > clock_timestamp() + interval '10 minutes' THEN
    RAISE EXCEPTION 'Enter when the lookup was made; it cannot be in the future';
  END IF;
  IF length(btrim(coalesce(p_motochek_user, ''))) < 2 THEN
    RAISE EXCEPTION 'Enter the individual Motochek login used for this lookup';
  END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('trespass_unpermitted_vehicle', 'cctv_patrol_signage_breach') THEN
    RAISE EXCEPTION 'Choose one of the authorised purposes';
  END IF;
  IF length(btrim(coalesce(p_explanation, ''))) < 10 THEN
    RAISE EXCEPTION 'Explain why the lookup was needed (at least 10 characters)';
  END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.locations WHERE id = p_location_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'That place is not in this organisation';
  END IF;
  IF p_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.observations WHERE id = p_observation_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'That sighting is not in this organisation';
  END IF;
  IF p_notice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.notices WHERE id = p_notice_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'That notice is not in this organisation';
  END IF;
  IF p_vehicle_identity_check_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.vehicle_identity_checks WHERE id = p_vehicle_identity_check_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'That NZTA check is not in this organisation';
  END IF;
  IF p_vehicle_identity_check_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.nzta_register_lookups WHERE vehicle_identity_check_id = p_vehicle_identity_check_id) THEN
    RAISE EXCEPTION 'That NZTA check is already linked to another lookup';
  END IF;
  IF p_evidence_item_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.evidence_items WHERE id = p_evidence_item_id AND organization_id = p_organization_id) THEN
    RAISE EXCEPTION 'That evidence item is not in this organisation';
  END IF;
  IF v_plate IS NOT NULL THEN
    SELECT id INTO v_vehicle FROM public.canonical_vehicles
    WHERE upper(regexp_replace(plate_number, '[^A-Za-z0-9]', '', 'g')) = v_plate
    ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  END IF;
  IF v_vehicle IS NULL AND v_vin IS NOT NULL THEN
    SELECT id INTO v_vehicle FROM public.canonical_vehicles WHERE upper(vin) = v_vin
    ORDER BY updated_at DESC NULLS LAST LIMIT 1;
  END IF;
  INSERT INTO public.nzta_register_lookups (organization_id, looked_up_at, plate_number, vin, canonical_vehicle_id,
    motochek_user, purpose, explanation, location_id, observation_id, evidence_item_id, notice_id,
    vehicle_identity_check_id, created_by)
  VALUES (p_organization_id, p_looked_up_at, v_plate, v_vin, v_vehicle, btrim(p_motochek_user), p_purpose,
    btrim(p_explanation), p_location_id, p_observation_id, p_evidence_item_id, p_notice_id,
    p_vehicle_identity_check_id, v_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'nzta_register_lookup_recorded', 'nzta_register_lookups', v_id,
    jsonb_build_object('purpose', p_purpose, 'has_plate', v_plate IS NOT NULL, 'has_vin', v_vin IS NOT NULL));
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_nzta_register_lookup_outcome(
  p_lookup_id uuid, p_outcome text, p_notes text DEFAULT NULL, p_notice_id uuid DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_row public.nzta_register_lookups%rowtype;
BEGIN
  SELECT * INTO v_row FROM public.nzta_register_lookups WHERE id = p_lookup_id FOR UPDATE;
  IF v_actor IS NULL OR v_row.id IS NULL OR NOT (
       public.is_admin_for_org(v_row.organization_id)
       OR (v_row.created_by = v_actor AND public.can_access_vehicle_owner_identity(v_row.organization_id))) THEN
    RAISE EXCEPTION 'NZTA register authorisation required' USING ERRCODE = '42501';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('pending', 'trespass_notice', 'damage_letter', 'debt_collection', 'no_action') THEN
    RAISE EXCEPTION 'Choose a recognised outcome';
  END IF;
  IF p_notice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.notices WHERE id = p_notice_id AND organization_id = v_row.organization_id) THEN
    RAISE EXCEPTION 'That notice is not in this organisation';
  END IF;
  UPDATE public.nzta_register_lookups SET outcome = p_outcome, outcome_notes = nullif(btrim(coalesce(p_notes, '')), ''),
    notice_id = coalesce(p_notice_id, notice_id), outcome_recorded_at = clock_timestamp(),
    outcome_recorded_by = v_actor, updated_at = clock_timestamp()
  WHERE id = p_lookup_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_row.organization_id, v_actor, 'nzta_register_lookup_outcome_set', 'nzta_register_lookups', p_lookup_id,
    jsonb_build_object('outcome', p_outcome, 'previous_outcome', v_row.outcome));
END;
$function$;

-- Associate an NZTA check with the lookup that explains it, including checks
-- approved after the lookup was recorded. Admin-only and audited.
CREATE OR REPLACE FUNCTION public.link_nzta_register_lookup_check(p_lookup_id uuid, p_check_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_lookup public.nzta_register_lookups%rowtype;
  v_check public.vehicle_identity_checks%rowtype;
  v_check_plate text;
  v_check_vin text;
BEGIN
  SELECT * INTO v_lookup FROM public.nzta_register_lookups WHERE id = p_lookup_id FOR UPDATE;
  IF v_actor IS NULL OR v_lookup.id IS NULL OR NOT public.is_admin_for_org(v_lookup.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_check FROM public.vehicle_identity_checks
  WHERE id = p_check_id AND organization_id = v_lookup.organization_id;
  IF v_check.id IS NULL THEN RAISE EXCEPTION 'That NZTA check is not in this organisation'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF v_lookup.vehicle_identity_check_id IS NOT NULL THEN
    RAISE EXCEPTION 'This lookup is already linked to an NZTA check';
  END IF;
  IF EXISTS (SELECT 1 FROM public.nzta_register_lookups WHERE vehicle_identity_check_id = p_check_id) THEN
    RAISE EXCEPTION 'That NZTA check is already linked to another lookup';
  END IF;
  SELECT upper(regexp_replace(coalesce(vehicle.plate_number, ''), '[^A-Za-z0-9]', '', 'g')), upper(vehicle.vin)
  INTO v_check_plate, v_check_vin
  FROM public.canonical_vehicles vehicle WHERE vehicle.id = v_check.canonical_vehicle_id;
  IF NOT (v_lookup.canonical_vehicle_id = v_check.canonical_vehicle_id
          OR (v_lookup.plate_number IS NOT NULL AND v_lookup.plate_number = v_check_plate)
          OR (v_lookup.vin IS NOT NULL AND v_lookup.vin = v_check_vin)) THEN
    RAISE EXCEPTION 'The lookup and the NZTA check are for different vehicles';
  END IF;
  UPDATE public.nzta_register_lookups
  SET vehicle_identity_check_id = p_check_id,
      canonical_vehicle_id = coalesce(canonical_vehicle_id, v_check.canonical_vehicle_id),
      updated_at = clock_timestamp()
  WHERE id = p_lookup_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_lookup.organization_id, v_actor, 'nzta_register_lookup_check_linked', 'nzta_register_lookups', p_lookup_id,
    jsonb_build_object('vehicle_identity_check_id', p_check_id, 'reason', btrim(p_reason)));
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_nzta_register_lookups(
  p_organization_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_limit integer DEFAULT 500)
 RETURNS TABLE(entry_kind text, entry_id uuid, looked_up_at timestamptz, plate_number text, vin text,
   motochek_user text, purpose text, explanation text, outcome text, outcome_notes text, place_name text,
   observation_id uuid, notice_number text, vehicle_identity_check_id uuid, recorded_by_name text,
   recorded_at timestamptz, can_edit boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_admin boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
BEGIN
  IF v_actor IS NULL OR p_organization_id IS NULL
     OR NOT public.can_access_vehicle_owner_identity(p_organization_id) THEN
    RAISE EXCEPTION 'NZTA register authorisation required' USING ERRCODE = '42501';
  END IF;
  v_admin := public.is_admin_for_org(p_organization_id);
  RETURN QUERY
  SELECT * FROM (
    SELECT 'lookup'::text, l.id, l.looked_up_at, l.plate_number, l.vin, l.motochek_user, l.purpose, l.explanation,
      l.outcome, l.outcome_notes, place.name, l.observation_id, notice.notice_number, l.vehicle_identity_check_id,
      author.display_name, l.created_at, (v_admin OR l.created_by = v_actor)
    FROM public.nzta_register_lookups l
    LEFT JOIN public.locations place ON place.id = l.location_id
    LEFT JOIN public.notices notice ON notice.id = l.notice_id
    LEFT JOIN public.user_profiles author ON author.id = l.created_by
    WHERE l.organization_id = p_organization_id AND (v_admin OR l.created_by = v_actor)
      AND (p_from IS NULL OR l.looked_up_at >= p_from) AND (p_to IS NULL OR l.looked_up_at < p_to)
    UNION ALL
    -- Checks recorded before the register existed. Their purpose was never
    -- captured, so it is reported as missing rather than inferred.
    SELECT 'historical_check'::text, c.id, c.checked_at, v.plate_number, v.vin, NULL::text, NULL::text, NULL::text,
      NULL::text, NULL::text, NULL::text, NULL::uuid, NULL::text, c.id, reviewer.display_name, c.created_at, false
    FROM public.vehicle_identity_checks c
    LEFT JOIN public.canonical_vehicles v ON v.id = c.canonical_vehicle_id
    LEFT JOIN public.user_profiles reviewer ON reviewer.id = c.reviewed_by
    WHERE v_admin AND c.organization_id = p_organization_id
      AND NOT EXISTS (SELECT 1 FROM public.nzta_register_lookups l WHERE l.vehicle_identity_check_id = c.id)
      AND (p_from IS NULL OR c.checked_at >= p_from) AND (p_to IS NULL OR c.checked_at < p_to)
  ) entries
  ORDER BY 3 DESC
  LIMIT v_limit;
END;
$function$;

-- 8. Purpose-gated reveal.
CREATE OR REPLACE FUNCTION public.reveal_nzta_registered_person(
  p_subject_type text, p_subject_id uuid, p_purpose text, p_explanation text,
  p_organization_id uuid DEFAULT NULL, p_lookup_id uuid DEFAULT NULL,
  p_notice_id uuid DEFAULT NULL, p_observation_id uuid DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_orgs uuid[];
  v_org uuid;
  v_notice_org uuid;
  v_notice uuid := CASE WHEN p_purpose = 'notice_follow_up' THEN p_notice_id END;
  v_ready jsonb;
  v_expires timestamptz := clock_timestamp() + interval '15 minutes';
  v_warnings text[] := ARRAY[]::text[];
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Sign in required' USING ERRCODE = '42501'; END IF;
  IF p_subject_type IS NULL OR p_subject_type NOT IN ('vehicle', 'person') OR p_subject_id IS NULL THEN
    RAISE EXCEPTION 'Choose the vehicle or person to reveal';
  END IF;
  IF p_purpose IS NULL OR p_purpose NOT IN ('trespass_unpermitted_vehicle', 'cctv_patrol_signage_breach', 'notice_follow_up') THEN
    RAISE EXCEPTION 'Choose one of the authorised purposes';
  END IF;
  IF length(btrim(coalesce(p_explanation, ''))) < 10 THEN
    RAISE EXCEPTION 'Explain why you need this information (at least 10 characters)';
  END IF;
  IF p_purpose = 'notice_follow_up' AND p_notice_id IS NULL THEN
    RAISE EXCEPTION 'Choose the notice you are following up';
  END IF;
  IF p_purpose = 'notice_follow_up' THEN
    -- The notice justifies a window only in the organisation it was issued by.
    SELECT notice.organization_id INTO v_notice_org FROM public.notices notice
    WHERE notice.id = p_notice_id AND public.nzta_notice_matches_subject(notice.id, p_subject_type, p_subject_id);
    IF v_notice_org IS NULL THEN
      RAISE EXCEPTION 'Choose an issued trespass or warning notice for this %', p_subject_type;
    END IF;
    IF p_organization_id IS NOT NULL AND p_organization_id <> v_notice_org THEN
      RAISE EXCEPTION 'That notice was issued by another organisation';
    END IF;
    v_orgs := ARRAY[v_notice_org];
  ELSIF p_organization_id IS NOT NULL THEN
    v_orgs := ARRAY[p_organization_id];
  ELSIF p_subject_type = 'person' THEN
    v_orgs := array(
      SELECT DISTINCT c.organization_id FROM public.vehicle_identity_checks c WHERE c.canonical_person_id = p_subject_id
      UNION
      SELECT DISTINCT link.organization_id FROM public.entity_links link
      WHERE link.from_type = 'person' AND link.from_id = p_subject_id AND link.to_type = 'vehicle'
        AND coalesce((link.evidence->>'nzta_restricted')::boolean, false));
  ELSE
    RAISE EXCEPTION 'Choose the organisation for this vehicle';
  END IF;
  IF cardinality(v_orgs) = 0 THEN
    RAISE EXCEPTION 'No NZTA register information is recorded for this person';
  END IF;
  v_orgs := array(SELECT org_id FROM unnest(v_orgs) org_id WHERE public.can_access_vehicle_owner_identity(org_id));
  IF cardinality(v_orgs) = 0 THEN
    RAISE EXCEPTION 'NZTA register authorisation required' USING ERRCODE = '42501';
  END IF;
  IF p_lookup_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.nzta_register_lookups WHERE id = p_lookup_id AND organization_id = ANY (v_orgs)) THEN
    RAISE EXCEPTION 'That lookup is not in your authorised organisations';
  END IF;
  IF v_notice IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.notices WHERE id = v_notice AND organization_id = ANY (v_orgs)) THEN
    RAISE EXCEPTION 'That notice is not in your authorised organisations';
  END IF;
  IF p_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.observations WHERE id = p_observation_id AND organization_id = ANY (v_orgs)) THEN
    RAISE EXCEPTION 'That sighting is not in your authorised organisations';
  END IF;
  FOREACH v_org IN ARRAY v_orgs LOOP
    v_ready := public.nzta_access_readiness(v_actor, v_org);
    IF NOT (v_ready->>'training_current')::boolean THEN v_warnings := array_append(v_warnings, 'training'); END IF;
    IF NOT (v_ready->>'confidentiality_current')::boolean THEN v_warnings := array_append(v_warnings, 'confidentiality'); END IF;
    INSERT INTO public.nzta_register_access_log (organization_id, actor_user_id, subject_type, subject_id, purpose,
      explanation, lookup_id, notice_id, observation_id, training_current, confidentiality_current, expires_at)
    VALUES (v_org, v_actor, p_subject_type, p_subject_id, p_purpose, btrim(p_explanation),
      CASE WHEN EXISTS (SELECT 1 FROM public.nzta_register_lookups WHERE id = p_lookup_id AND organization_id = v_org) THEN p_lookup_id END,
      CASE WHEN EXISTS (SELECT 1 FROM public.notices WHERE id = v_notice AND organization_id = v_org) THEN v_notice END,
      CASE WHEN EXISTS (SELECT 1 FROM public.observations WHERE id = p_observation_id AND organization_id = v_org) THEN p_observation_id END,
      (v_ready->>'training_current')::boolean, (v_ready->>'confidentiality_current')::boolean, v_expires);
  END LOOP;
  RETURN jsonb_build_object('revealed_until', v_expires, 'organization_count', cardinality(v_orgs),
    'warnings', to_jsonb(ARRAY(SELECT DISTINCT w FROM unnest(v_warnings) w ORDER BY w)));
END;
$function$;

-- Issued trespass/warning notices that can justify a follow-up reveal for this
-- subject, limited to organisations where the caller holds register access.
CREATE OR REPLACE FUNCTION public.list_nzta_follow_up_notices(
  p_subject_type text, p_subject_id uuid, p_organization_id uuid DEFAULT NULL)
 RETURNS TABLE(notice_id uuid, organization_id uuid, notice_number text, notice_type text, issued_at timestamptz)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT notice.id, notice.organization_id, notice.notice_number, notice.notice_type, notice.issued_at
  FROM public.notices notice
  WHERE auth.uid() IS NOT NULL
    AND p_subject_type IN ('person', 'vehicle') AND p_subject_id IS NOT NULL
    AND notice.status = 'issued' AND notice.notice_type IN ('trespass', 'warning')
    AND (p_organization_id IS NULL OR notice.organization_id = p_organization_id)
    AND public.can_access_vehicle_owner_identity(notice.organization_id)
    AND public.nzta_notice_matches_subject(notice.id, p_subject_type, p_subject_id)
  ORDER BY notice.issued_at DESC NULLS LAST
  LIMIT 50;
$function$;

CREATE OR REPLACE FUNCTION public.list_nzta_register_access_log(
  p_organization_id uuid, p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL, p_limit integer DEFAULT 500)
 RETURNS TABLE(log_id uuid, revealed_at timestamptz, expires_at timestamptz, actor_name text, subject_type text,
   subject_label text, purpose text, explanation text, notice_number text, lookup_id uuid,
   training_current boolean, confidentiality_current boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT log.id, log.revealed_at, log.expires_at, actor.display_name, log.subject_type,
    CASE WHEN log.subject_type = 'vehicle' THEN vehicle.plate_number ELSE person.display_name END,
    log.purpose, log.explanation, notice.notice_number, log.lookup_id, log.training_current, log.confidentiality_current
  FROM public.nzta_register_access_log log
  LEFT JOIN public.user_profiles actor ON actor.id = log.actor_user_id
  LEFT JOIN public.canonical_vehicles vehicle ON log.subject_type = 'vehicle' AND vehicle.id = log.subject_id
  LEFT JOIN public.canonical_people person ON log.subject_type = 'person' AND person.id = log.subject_id
  LEFT JOIN public.notices notice ON notice.id = log.notice_id
  WHERE log.organization_id = p_organization_id
    AND (p_from IS NULL OR log.revealed_at >= p_from) AND (p_to IS NULL OR log.revealed_at < p_to)
  ORDER BY log.revealed_at DESC
  LIMIT least(greatest(coalesce(p_limit, 500), 1), 5000);
END;
$function$;

-- 9. Training, confidentiality and quarterly review RPCs.
CREATE OR REPLACE FUNCTION public.record_nzta_access_attestation(
  p_user_id uuid, p_attestation_type text, p_completed_on date, p_expires_on date DEFAULT NULL,
  p_provider text DEFAULT NULL, p_notes text DEFAULT NULL, p_organization_id uuid DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_target public.user_profiles%rowtype;
  v_expires date;
  v_id uuid;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id AND deactivated_at IS NULL;
  IF v_actor IS NULL OR v_target.id IS NULL THEN RAISE EXCEPTION 'Active user required' USING ERRCODE = '42501'; END IF;
  IF p_attestation_type IS NULL OR p_attestation_type NOT IN ('training', 'confidentiality') THEN
    RAISE EXCEPTION 'Choose training or confidentiality';
  END IF;
  -- Administrators of an organisation where the person holds register access
  -- (provider staff, parent-organisation admins) can record it too; it is still
  -- stored against the person's home organisation because it is personal.
  IF NOT (public.is_admin_for_org(v_target.organization_id)
          OR (p_attestation_type = 'confidentiality' AND p_user_id = v_actor)
          OR (p_organization_id IS NOT NULL AND public.is_admin_for_org(p_organization_id)
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(public.get_nzta_access_holders(p_organization_id)) holder
                WHERE holder->>'user_id' = p_user_id::text))) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_completed_on IS NULL OR p_completed_on > current_date THEN
    RAISE EXCEPTION 'Enter the completion date; it cannot be in the future';
  END IF;
  v_expires := coalesce(p_expires_on, (p_completed_on + interval '12 months')::date);
  IF v_expires <= p_completed_on OR v_expires > (p_completed_on + interval '12 months')::date THEN
    RAISE EXCEPTION 'Refresh is required within 12 months of completion';
  END IF;
  INSERT INTO public.nzta_access_attestations (organization_id, user_id, attestation_type, completed_on, expires_on,
    provider, notes, recorded_by)
  VALUES (v_target.organization_id, p_user_id, p_attestation_type, p_completed_on, v_expires,
    nullif(btrim(coalesce(p_provider, '')), ''), nullif(btrim(coalesce(p_notes, '')), ''), v_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_target.organization_id, v_actor, 'nzta_access_attestation_recorded', 'nzta_access_attestations', v_id,
    jsonb_build_object('user_id', p_user_id, 'attestation_type', p_attestation_type, 'expires_on', v_expires,
      'recorded_via_organization_id', coalesce(p_organization_id, v_target.organization_id)));
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.withdraw_nzta_access_attestation(p_attestation_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_row public.nzta_access_attestations%rowtype;
BEGIN
  SELECT * INTO v_row FROM public.nzta_access_attestations WHERE id = p_attestation_id FOR UPDATE;
  IF auth.uid() IS NULL OR v_row.id IS NULL OR NOT public.is_admin_for_org(v_row.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  IF v_row.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'This record was already withdrawn'; END IF;
  IF length(btrim(coalesce(p_reason, ''))) < 5 THEN RAISE EXCEPTION 'A reason is required'; END IF;
  UPDATE public.nzta_access_attestations
  SET withdrawn_at = clock_timestamp(), withdrawn_by = auth.uid(), withdrawn_reason = btrim(p_reason)
  WHERE id = p_attestation_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_row.organization_id, auth.uid(), 'nzta_access_attestation_withdrawn', 'nzta_access_attestations',
    p_attestation_id, jsonb_build_object('user_id', v_row.user_id, 'reason', btrim(p_reason)));
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_nzta_access_holders(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(holder ORDER BY (holder->>'holds_access')::boolean DESC, holder->>'display_name')
    FROM (
      SELECT jsonb_build_object(
        'user_id', profile.id, 'display_name', profile.display_name, 'role', profile.role,
        'home_organization', profile.organization_id = p_organization_id,
        'via_role', reach.via_role,
        'direct', direct_grant.id IS NOT NULL, 'granted_at', direct_grant.updated_at,
        'via_preset', preset_grant.found,
        'holds_access', reach.via_role OR direct_grant.id IS NOT NULL OR preset_grant.found
      ) || public.nzta_access_readiness(profile.id, profile.organization_id) AS holder
      FROM public.user_profiles profile
      -- A direct grant at a parent organisation reaches its descendants, the
      -- same way can_access_vehicle_owner_identity resolves it.
      LEFT JOIN LATERAL (
        SELECT grant_row.id, grant_row.updated_at
        FROM public.staff_area_grants grant_row
        WHERE grant_row.user_id = profile.id
          AND grant_row.area = 'vehicle_owner_identity' AND grant_row.status = 'active'
          AND p_organization_id = ANY (public.get_descendant_organizations(grant_row.scope_org_id))
        ORDER BY (grant_row.scope_org_id = p_organization_id) DESC, grant_row.updated_at DESC
        LIMIT 1
      ) direct_grant ON true
      CROSS JOIN LATERAL (
        SELECT EXISTS (
          SELECT 1 FROM public.preset_assignments assignment
          JOIN public.access_presets preset ON preset.id = assignment.preset_id
          WHERE assignment.user_id = profile.id AND assignment.status = 'active'
            AND preset.grants ? 'vehicle_owner_identity'
            AND p_organization_id = ANY (public.get_descendant_organizations(assignment.scope_org_id))
        ) AS found
      ) preset_grant
      -- Mirrors is_admin_for_org for the listed user, so parent-organisation,
      -- provider and platform administrators who can see the register are listed.
      CROSS JOIN LATERAL (
        SELECT profile.role = 'grand_master'
          OR (profile.role IN ('admin', 'admin_officer', 'master') AND (
            p_organization_id = ANY (public.get_descendant_organizations(profile.organization_id))
            OR (profile.role = 'master' AND profile.employer_organization_id IS NOT NULL
                AND p_organization_id = ANY (public.get_descendant_organizations(profile.employer_organization_id)))
            OR EXISTS (
              SELECT 1 FROM public.service_agreements sa
              WHERE (sa.ends_on IS NULL OR sa.ends_on >= current_date)
                AND sa.agreement_type = 'operational'
                AND sa.client_organization_id = p_organization_id
                AND (profile.organization_id = sa.provider_organization_id
                     OR profile.employer_organization_id = sa.provider_organization_id)))) AS via_role
      ) reach
      -- Active staff of this organisation are listed even without access, so
      -- training and confidentiality can be recorded before access is granted.
      WHERE profile.deactivated_at IS NULL
        AND (profile.organization_id = p_organization_id OR reach.via_role
             OR direct_grant.id IS NOT NULL OR preset_grant.found)
    ) holders
  ), '[]'::jsonb);
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_nzta_access_review(
  p_organization_id uuid, p_period_start date, p_period_end date, p_findings text, p_actions text DEFAULT NULL)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_period_start IS NULL OR p_period_end IS NULL OR p_period_end < p_period_start THEN
    RAISE EXCEPTION 'Enter a valid review period';
  END IF;
  IF p_period_end > current_date THEN RAISE EXCEPTION 'The review period cannot end in the future'; END IF;
  IF length(btrim(coalesce(p_findings, ''))) < 10 THEN
    RAISE EXCEPTION 'Record what was reviewed and found (at least 10 characters)';
  END IF;
  INSERT INTO public.nzta_access_reviews (organization_id, period_start, period_end, reviewed_by, holders, findings, actions)
  VALUES (p_organization_id, p_period_start, p_period_end, auth.uid(),
    coalesce((SELECT jsonb_agg(h) FROM jsonb_array_elements(public.get_nzta_access_holders(p_organization_id)) h
              WHERE (h->>'holds_access')::boolean), '[]'::jsonb),
    btrim(p_findings), nullif(btrim(coalesce(p_actions, '')), ''))
  RETURNING id INTO v_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, auth.uid(), 'nzta_access_review_recorded', 'nzta_access_reviews', v_id,
    jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end));
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_nzta_access_reviews(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'review_id', review.id, 'period_start', review.period_start, 'period_end', review.period_end,
      'reviewed_at', review.reviewed_at, 'reviewed_by_name', reviewer.display_name,
      'holder_count', jsonb_array_length(review.holders), 'findings', review.findings, 'actions', review.actions
    ) ORDER BY review.period_end DESC, review.reviewed_at DESC)
    FROM public.nzta_access_reviews review
    LEFT JOIN public.user_profiles reviewer ON reviewer.id = review.reviewed_by
    WHERE review.organization_id = p_organization_id
  ), '[]'::jsonb);
END;
$function$;

-- 10. Annual report summary (T&C 19) with report-only retention.
CREATE OR REPLACE FUNCTION public.get_nzta_s241_summary(p_organization_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_from timestamptz;
  v_to timestamptz;
  v_holders jsonb;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Enter a valid reporting period'; END IF;
  v_from := p_from::timestamptz;
  v_to := (p_to + 1)::timestamptz;
  v_holders := coalesce((SELECT jsonb_agg(h) FROM jsonb_array_elements(public.get_nzta_access_holders(p_organization_id)) h
                         WHERE (h->>'holds_access')::boolean), '[]'::jsonb);
  RETURN jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'lookups', jsonb_build_object(
      'total', (SELECT count(*) FROM public.nzta_register_lookups l
                WHERE l.organization_id = p_organization_id AND l.looked_up_at >= v_from AND l.looked_up_at < v_to),
      'by_purpose', coalesce((SELECT jsonb_object_agg(purpose, n) FROM (
          SELECT l.purpose, count(*) n FROM public.nzta_register_lookups l
          WHERE l.organization_id = p_organization_id AND l.looked_up_at >= v_from AND l.looked_up_at < v_to
          GROUP BY l.purpose) x), '{}'::jsonb),
      'by_outcome', coalesce((SELECT jsonb_object_agg(outcome, n) FROM (
          SELECT l.outcome, count(*) n FROM public.nzta_register_lookups l
          WHERE l.organization_id = p_organization_id AND l.looked_up_at >= v_from AND l.looked_up_at < v_to
          GROUP BY l.outcome) x), '{}'::jsonb),
      'historical_checks_without_purpose', (SELECT count(*) FROM public.vehicle_identity_checks c
          WHERE c.organization_id = p_organization_id AND c.checked_at >= v_from AND c.checked_at < v_to
            AND NOT EXISTS (SELECT 1 FROM public.nzta_register_lookups l WHERE l.vehicle_identity_check_id = c.id))),
    'reveals', jsonb_build_object(
      'total', (SELECT count(*) FROM public.nzta_register_access_log a
                WHERE a.organization_id = p_organization_id AND a.revealed_at >= v_from AND a.revealed_at < v_to),
      'by_purpose', coalesce((SELECT jsonb_object_agg(purpose, n) FROM (
          SELECT a.purpose, count(*) n FROM public.nzta_register_access_log a
          WHERE a.organization_id = p_organization_id AND a.revealed_at >= v_from AND a.revealed_at < v_to
          GROUP BY a.purpose) x), '{}'::jsonb),
      'without_current_training', (SELECT count(*) FROM public.nzta_register_access_log a
          WHERE a.organization_id = p_organization_id AND a.revealed_at >= v_from AND a.revealed_at < v_to
            AND NOT a.training_current)),
    'holders', jsonb_build_object(
      'total', jsonb_array_length(v_holders),
      'training_current', (SELECT count(*) FROM jsonb_array_elements(v_holders) h WHERE (h->>'training_current')::boolean),
      'confidentiality_current', (SELECT count(*) FROM jsonb_array_elements(v_holders) h WHERE (h->>'confidentiality_current')::boolean)),
    'reviews', jsonb_build_object(
      'in_period', (SELECT count(*) FROM public.nzta_access_reviews r
          WHERE r.organization_id = p_organization_id AND r.period_end >= p_from AND r.period_start <= p_to),
      'last_reviewed_at', (SELECT max(r.reviewed_at) FROM public.nzta_access_reviews r WHERE r.organization_id = p_organization_id)),
    'signage', coalesce((SELECT jsonb_agg(jsonb_build_object(
        'zone_id', zone_row.id, 'zone_name', zone_row.name, 'evidence_count', zone_row.evidence_count,
        'sign_types', zone_row.sign_types, 'latest_captured_at', zone_row.latest_captured_at) ORDER BY zone_row.name)
      FROM (
        SELECT zone.id, zone.name, count(sign.id) AS evidence_count,
          coalesce(jsonb_agg(DISTINCT sign.sign_type) FILTER (WHERE sign.id IS NOT NULL), '[]'::jsonb) AS sign_types,
          max(sign.captured_at) AS latest_captured_at
        FROM public.location_zones zone
        LEFT JOIN public.zone_signage_evidence sign ON sign.zone_id = zone.id AND sign.organization_id = p_organization_id
        WHERE zone.organization_id = p_organization_id
        GROUP BY zone.id, zone.name
      ) zone_row), '[]'::jsonb),
    'retention', jsonb_build_object(
      'note', 'Report only. Nothing is deleted until NZTA confirms the retention period.',
      'checks_older_than_18_months', (SELECT count(*) FROM public.vehicle_identity_checks c
          WHERE c.organization_id = p_organization_id AND c.checked_at < clock_timestamp() - interval '18 months'),
      'checks_older_than_2_years', (SELECT count(*) FROM public.vehicle_identity_checks c
          WHERE c.organization_id = p_organization_id AND c.checked_at < clock_timestamp() - interval '2 years'),
      'checks_older_than_5_years', (SELECT count(*) FROM public.vehicle_identity_checks c
          WHERE c.organization_id = p_organization_id AND c.checked_at < clock_timestamp() - interval '5 years'),
      'lookups_older_than_18_months', (SELECT count(*) FROM public.nzta_register_lookups l
          WHERE l.organization_id = p_organization_id AND l.looked_up_at < clock_timestamp() - interval '18 months'),
      'lookups_older_than_2_years', (SELECT count(*) FROM public.nzta_register_lookups l
          WHERE l.organization_id = p_organization_id AND l.looked_up_at < clock_timestamp() - interval '2 years'),
      'lookups_older_than_5_years', (SELECT count(*) FROM public.nzta_register_lookups l
          WHERE l.organization_id = p_organization_id AND l.looked_up_at < clock_timestamp() - interval '5 years'),
      'reveals_older_than_18_months', (SELECT count(*) FROM public.nzta_register_access_log a
          WHERE a.organization_id = p_organization_id AND a.revealed_at < clock_timestamp() - interval '18 months'),
      'reveals_older_than_2_years', (SELECT count(*) FROM public.nzta_register_access_log a
          WHERE a.organization_id = p_organization_id AND a.revealed_at < clock_timestamp() - interval '2 years'),
      'reveals_older_than_5_years', (SELECT count(*) FROM public.nzta_register_access_log a
          WHERE a.organization_id = p_organization_id AND a.revealed_at < clock_timestamp() - interval '5 years'))
  );
END;
$function$;

-- 11. New grants require current training and confidentiality acceptance.
--     Existing holders are not revoked; they are shown as not ready instead.
CREATE OR REPLACE FUNCTION public.set_vehicle_owner_access(p_user_id uuid, p_enabled boolean, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_target public.user_profiles%rowtype;
  v_grant public.staff_area_grants%rowtype;
  v_ready jsonb;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id FOR UPDATE;
  IF v_target.id IS NULL OR v_actor IS NULL OR NOT public.is_admin_for_org(v_target.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required';
  END IF;
  IF v_target.role = 'grand_master' THEN RAISE EXCEPTION 'Grand master access is not configurable here'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the access audit trail'; END IF;
  IF p_enabled AND NOT EXISTS (
    SELECT 1 FROM public.staff_area_grants
    WHERE user_id = p_user_id AND scope_org_id = v_target.organization_id
      AND area = 'vehicle_owner_identity' AND status = 'active') THEN
    v_ready := public.nzta_access_readiness(p_user_id, v_target.organization_id);
    IF NOT (v_ready->>'training_current')::boolean OR NOT (v_ready->>'confidentiality_current')::boolean THEN
      RAISE EXCEPTION 'Record current NZTA register training and confidentiality acceptance before granting access';
    END IF;
  END IF;
  IF p_enabled THEN
    INSERT INTO public.staff_area_grants (user_id, scope_org_id, area, level, status, granted_by)
    VALUES (p_user_id, v_target.organization_id, 'vehicle_owner_identity', 'manage', 'active', v_actor)
    ON CONFLICT (user_id, scope_org_id, area)
    DO UPDATE SET level = 'manage', status = 'active', granted_by = v_actor, updated_at = clock_timestamp()
    RETURNING * INTO v_grant;
  ELSE
    UPDATE public.staff_area_grants SET status = 'ended', updated_at = clock_timestamp()
    WHERE user_id = p_user_id AND scope_org_id = v_target.organization_id
      AND area = 'vehicle_owner_identity' AND status = 'active'
    RETURNING * INTO v_grant;
  END IF;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_target.organization_id, v_actor,
    CASE WHEN p_enabled THEN 'vehicle_owner_access_granted' ELSE 'vehicle_owner_access_ended' END,
    'staff_area_grants', v_grant.id,
    jsonb_build_object('user_id', p_user_id, 'area', 'vehicle_owner_identity', 'reason', trim(p_reason)));
  RETURN public.get_vehicle_owner_access(p_user_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_vehicle_owner_access(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target public.user_profiles%rowtype;
  v_direct public.staff_area_grants%rowtype;
  v_preset_level text;
BEGIN
  SELECT * INTO v_target FROM public.user_profiles WHERE id = p_user_id;
  IF v_target.id IS NULL OR auth.uid() IS NULL
     OR NOT public.is_admin_for_org(v_target.organization_id) THEN
    RAISE EXCEPTION 'Organisation administrator required';
  END IF;
  SELECT * INTO v_direct FROM public.staff_area_grants
  WHERE user_id = p_user_id AND scope_org_id = v_target.organization_id
    AND area = 'vehicle_owner_identity' AND status = 'active';
  SELECT max(grant_row.level) INTO v_preset_level
  FROM public.preset_assignments assignment
  JOIN public.access_presets preset ON preset.id = assignment.preset_id
  CROSS JOIN LATERAL jsonb_each_text(preset.grants) AS grant_row(area, level)
  WHERE assignment.user_id = p_user_id AND assignment.status = 'active'
    AND grant_row.area = 'vehicle_owner_identity'
    AND v_target.organization_id = ANY (public.get_descendant_organizations(assignment.scope_org_id));
  RETURN jsonb_build_object(
    'direct', v_direct.id IS NOT NULL,
    'direct_level', v_direct.level,
    'granted_at', v_direct.updated_at,
    'via_preset', v_preset_level IS NOT NULL,
    'via_role', v_target.role IN ('admin', 'admin_officer', 'master', 'grand_master'),
    'organization_id', v_target.organization_id
  ) || public.nzta_access_readiness(p_user_id, v_target.organization_id);
END;
$function$;

-- 12. Readers mask NZTA person<->vehicle links unless the caller has an open reveal.
CREATE OR REPLACE FUNCTION public.get_vehicle_owner_links(p_organization_id uuid, p_canonical_vehicle_id uuid)
 RETURNS TABLE(link_id uuid, relationship text, active boolean, source text, basis text, nzta_restricted boolean, person_record_id uuid, canonical_person_id uuid, display_name text, phone text, email text, address text, locality text, observation_ids uuid[], details_visible boolean, recorded_at timestamp with time zone, recorded_by_name text, ended_at timestamp with time zone, source_checked_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_full boolean;
  v_contacts boolean;
  v_revealed boolean;
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Organization access required' USING ERRCODE = '42501';
  END IF;
  v_full := public.can_access_vehicle_owner_identity(p_organization_id);
  v_contacts := v_full AND public.can_access_person_contacts(p_organization_id);
  v_revealed := v_full AND public.nzta_reveal_active(ARRAY[p_organization_id], 'vehicle', p_canonical_vehicle_id);
  RETURN QUERY
  SELECT link.id, link.relationship, link.active, link.evidence->>'source',
    CASE WHEN v_contacts AND row_access.visible THEN link.evidence->>'basis' END,
    row_access.restricted,
    CASE WHEN row_access.visible THEN person_record.id END,
    CASE WHEN row_access.visible THEN link.from_id END,
    CASE WHEN row_access.visible THEN coalesce(person_record.display_name, canonical_person.display_name) END,
    CASE WHEN v_contacts AND row_access.visible THEN person_record.metadata->'profile_details'->>'phone' END,
    CASE WHEN v_contacts AND row_access.visible THEN person_record.metadata->'profile_details'->>'email' END,
    CASE WHEN v_contacts AND row_access.visible THEN person_record.metadata->'profile_details'->>'address' END,
    CASE WHEN v_contacts AND row_access.visible THEN public.vehicle_owner_locality(person_record.metadata->'profile_details') END,
    coalesce(ARRAY(
      SELECT (item #>> '{}')::uuid
      FROM jsonb_array_elements(coalesce(link.evidence->'observation_ids', '[]'::jsonb)) item
    ), ARRAY[]::uuid[]),
    row_access.visible, link.created_at, user_profile.display_name,
    CASE WHEN row_access.visible OR NOT (link.evidence ? 'nzta_owner_history_first_check_id') THEN link.ends_at END,
    CASE WHEN row_access.visible THEN nullif(link.evidence->>'source_checked_at', '')::timestamptz END
  FROM public.entity_links link
  CROSS JOIN LATERAL (
    SELECT coalesce((link.evidence->>'nzta_restricted')::boolean, false) AS restricted,
      v_full AND (NOT coalesce((link.evidence->>'nzta_restricted')::boolean, false) OR v_revealed) AS visible
  ) row_access
  LEFT JOIN public.person_records person_record
    ON person_record.id = (link.evidence->>'person_record_id')::uuid AND person_record.organization_id = link.organization_id
  LEFT JOIN public.canonical_people canonical_person ON canonical_person.id = link.from_id
  LEFT JOIN public.user_profiles user_profile ON user_profile.id = link.created_by
  WHERE link.organization_id = p_organization_id AND link.to_type = 'vehicle'
    AND link.to_id = p_canonical_vehicle_id AND link.from_type = 'person'
    AND link.relationship IN ('owner', 'registered_owner', 'driver', 'associated_person')
    AND NOT coalesce(link.evidence->>'superseded_by_reconciliation', 'false')::boolean
  ORDER BY link.active DESC, (link.relationship IN ('owner', 'registered_owner')) DESC, link.created_at DESC
  LIMIT 50;
END;
$function$;

DROP FUNCTION public.get_vehicle_identity_checks(uuid, uuid);
CREATE FUNCTION public.get_vehicle_identity_checks(p_organization_id uuid, p_canonical_vehicle_id uuid)
 RETURNS TABLE(check_id uuid, checked_at timestamp with time zone, relationship text, person_record_id uuid, canonical_person_id uuid, display_name text, identity_document_id uuid, evidence_item_id uuid, source_authority text, vehicle_snapshot jsonb, storage_bucket text, storage_path text, file_name text, reviewed_at timestamp with time zone, revealed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_revealed boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;
  v_revealed := public.can_access_vehicle_owner_identity(p_organization_id)
    AND public.nzta_reveal_active(ARRAY[p_organization_id], 'vehicle', p_canonical_vehicle_id);
  RETURN QUERY
  SELECT
    checks.id,
    checks.checked_at,
    checks.relationship,
    CASE WHEN v_revealed THEN checks.person_record_id END,
    CASE WHEN v_revealed THEN checks.canonical_person_id END,
    CASE WHEN v_revealed THEN person.display_name END,
    CASE WHEN v_revealed THEN checks.identity_document_id END,
    CASE WHEN v_revealed THEN checks.evidence_item_id END,
    checks.source_authority,
    CASE WHEN v_revealed THEN checks.vehicle_snapshot
      ELSE (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
            FROM jsonb_each(checks.vehicle_snapshot)
            WHERE key IN ('plate_number', 'vin', 'chassis_number', 'vehicle_make', 'vehicle_model',
              'vehicle_year', 'vehicle_colour', 'fuel_type', 'wof_expiry', 'rego_expiry',
              'query_completed_at', 'owner_only_review', 'vehicle_facts_review_state')) END,
    CASE WHEN v_revealed THEN attachment.storage_bucket END,
    CASE WHEN v_revealed THEN attachment.storage_path END,
    CASE WHEN v_revealed THEN attachment.file_name END,
    checks.reviewed_at,
    v_revealed
  FROM public.vehicle_identity_checks checks
  JOIN public.person_records person
    ON person.id = checks.person_record_id
   AND person.organization_id = checks.organization_id
  JOIN public.person_identity_documents document
    ON document.id = checks.identity_document_id
  LEFT JOIN public.bob_attachments attachment
    ON attachment.id = document.attachment_id
  WHERE checks.organization_id = p_organization_id
    AND checks.canonical_vehicle_id = p_canonical_vehicle_id
  ORDER BY checks.checked_at DESC, checks.reviewed_at DESC
  LIMIT 25;
END;
$function$;

-- search_people: the NZTA block and NZTA-sourced vehicle links need an open reveal for that person.
CREATE OR REPLACE FUNCTION "public"."search_people"(p_query text, p_limit integer DEFAULT 25)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_query text := regexp_replace(lower(trim(coalesce(p_query, ''))), '\s+', ' ', 'g');
  v_norm text;
  v_tokens text[];
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_orgs uuid[];
  v_identity_orgs uuid[];
  v_contact_orgs uuid[];
  v_result jsonb;
BEGIN
  IF NOT public.can_search_people() THEN
    RAISE EXCEPTION 'Person-search authorization required' USING ERRCODE = '42501';
  END IF;
  v_norm := regexp_replace(v_query, '[^a-z0-9]+', '', 'g');
  IF length(v_norm) < 2 THEN RAISE EXCEPTION 'Enter at least two letters or numbers'; END IF;
  v_tokens := array(
    SELECT token FROM unnest(regexp_split_to_array(regexp_replace(v_query, '[^a-z0-9 ]+', '', 'g'), ' ')) token
    WHERE token <> ''
  );
  v_orgs := array(SELECT o.id FROM public.organizations o WHERE public.can_search_people(o.id));
  v_identity_orgs := array(SELECT org_id FROM unnest(v_orgs) org_id WHERE public.can_access_vehicle_owner_identity(org_id));
  v_contact_orgs := array(SELECT org_id FROM unnest(v_orgs) org_id WHERE public.can_access_person_contacts(org_id));

  WITH matched AS (
    SELECT p.id FROM public.canonical_people p
    WHERE p.status = 'active'
      AND (p.normalized_name LIKE '%' || v_norm || '%'
        OR (cardinality(v_tokens) > 1 AND NOT EXISTS (
          SELECT 1 FROM unnest(v_tokens) token WHERE position(token IN lower(coalesce(p.display_name, ''))) = 0)))
    UNION
    SELECT link.canonical_person_id
    FROM public.person_record_aliases alias
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = alias.person_record_id
    WHERE alias.active AND alias.organization_id = ANY(v_orgs) AND alias.alias_norm LIKE '%' || v_norm || '%'
    UNION
    SELECT link.canonical_person_id
    FROM public.person_records record
    JOIN public.canonical_person_links link ON link.source_table = 'person_records' AND link.source_id = record.id
    WHERE record.organization_id = ANY(v_orgs)
      AND regexp_replace(lower(coalesce(record.display_name, '')), '[^a-z0-9]+', '', 'g') LIKE '%' || v_norm || '%'
    UNION
    SELECT permit.canonical_person_id FROM public.person_permits permit
    WHERE permit.organization_id = ANY(v_orgs)
      AND regexp_replace(lower(permit.permit_number), '[^a-z0-9]+', '', 'g') = v_norm
  ), visible AS (
    SELECT p.* FROM public.canonical_people p
    WHERE p.id IN (SELECT id FROM matched) AND p.status = 'active'
      AND (EXISTS (SELECT 1 FROM public.canonical_person_links link
                   WHERE link.canonical_person_id = p.id AND link.organization_id = ANY(v_orgs))
        OR EXISTS (SELECT 1 FROM public.notices notice
                   WHERE notice.person_id = p.id AND notice.organization_id = ANY(v_orgs))
        OR EXISTS (SELECT 1 FROM public.person_permits permit
                   WHERE permit.canonical_person_id = p.id AND permit.organization_id = ANY(v_orgs)))
  ), ranked AS (
    SELECT v.*,
      (v.normalized_name = v_norm OR EXISTS (
        SELECT 1 FROM public.person_permits permit
        WHERE permit.canonical_person_id = v.id AND permit.organization_id = ANY(v_orgs)
          AND regexp_replace(lower(permit.permit_number), '[^a-z0-9]+', '', 'g') = v_norm)) AS exact_match,
      EXISTS (SELECT 1 FROM public.notices notice
              WHERE notice.person_id = v.id AND notice.organization_id = ANY(v_orgs)
                AND notice.status = 'issued' AND notice.notice_type IN ('trespass', 'warning')
                AND (notice.expires_at IS NULL OR notice.expires_at > clock_timestamp())) AS has_notice_in_force
    FROM visible v
    ORDER BY exact_match DESC, has_notice_in_force DESC, v.display_name
    LIMIT v_limit
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'canonical_person_id', r.id,
    'display_name', r.display_name,
    'review_state', r.review_state,
    'homeless_status', r.homeless_status,
    'has_notice_in_force', r.has_notice_in_force,
    'contact_details_authorised', cardinality(v_contact_orgs) > 0,
    'aliases', coalesce((
      SELECT jsonb_agg(DISTINCT alias.alias)
      FROM public.canonical_person_links link
      JOIN public.person_record_aliases alias ON alias.person_record_id = link.source_id AND alias.active
      WHERE link.canonical_person_id = r.id AND link.source_table = 'person_records' AND alias.organization_id = ANY(v_orgs)
    ), '[]'::jsonb),
    'organizations', coalesce((
      SELECT jsonb_agg(DISTINCT org.name) FROM public.organizations org
      WHERE org.id = ANY(v_orgs)
        AND (EXISTS (SELECT 1 FROM public.canonical_person_links link WHERE link.canonical_person_id = r.id AND link.organization_id = org.id)
          OR EXISTS (SELECT 1 FROM public.notices notice WHERE notice.person_id = r.id AND notice.organization_id = org.id)
          OR EXISTS (SELECT 1 FROM public.person_permits permit WHERE permit.canonical_person_id = r.id AND permit.organization_id = org.id))
    ), '[]'::jsonb),
    'notices', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'notice_id', notice.id, 'organization_id', notice.organization_id, 'organization_name', org.name,
        'notice_type', notice.notice_type, 'notice_number', notice.notice_number, 'status', notice.status,
        'issued_at', notice.issued_at, 'expires_at', notice.expires_at,
        'expiry_state', public.notice_expiry_state(notice.status, notice.expires_at), 'location_name', place.name
      ) ORDER BY notice.issued_at DESC NULLS LAST)
      FROM public.notices notice JOIN public.organizations org ON org.id = notice.organization_id
      LEFT JOIN public.observations observation ON observation.id = notice.observation_id
      LEFT JOIN public.locations place ON place.id = coalesce(notice.location_id, observation.location_id)
      WHERE notice.person_id = r.id AND notice.organization_id = ANY(v_orgs)
    ), '[]'::jsonb),
    'permits', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'permit_id', permit.id, 'organization_name', org.name, 'client_organization_name', client.name,
        'permit_number', permit.permit_number, 'permit_type', permit.permit_type,
        'applicant_type', permit.applicant_type, 'company_name', permit.company_name, 'status', permit.status,
        'validity_state', public.person_permit_validity(permit.status, permit.date_from, permit.date_to),
        'date_from', permit.date_from, 'date_to', permit.date_to,
        'forest_areas', coalesce(to_jsonb(permit.forest_areas), '[]'::jsonb),
        'activities', coalesce(to_jsonb(permit.activities), '[]'::jsonb),
        'hunting_season', permit.hunting_season, 'firearm_licence_valid', permit.firearm_licence_valid,
        'chainsaw_safety_equipment', permit.chainsaw_safety_equipment, 'keys_issued', permit.keys_issued,
        'conditions', permit.conditions,
        'contact_email', CASE WHEN permit.organization_id = ANY(v_contact_orgs) THEN permit.contact_email END,
        'contact_phone', CASE WHEN permit.organization_id = ANY(v_contact_orgs) THEN permit.contact_phone END,
        'address_text', CASE WHEN permit.organization_id = ANY(v_contact_orgs) THEN permit.address_text END,
        'compliance_checked_at', permit.compliance_checked_at, 'source_document', permit.source_document,
        'vehicles', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'canonical_vehicle_id', vehicle.id, 'plate_number', vehicle.plate_number,
            'make', vehicle.make, 'model', vehicle.model, 'colour', vehicle.colour
          ) ORDER BY vehicle.plate_number)
          FROM public.person_permit_vehicles permit_vehicle
          JOIN public.canonical_vehicles vehicle ON vehicle.id = permit_vehicle.canonical_vehicle_id
          WHERE permit_vehicle.permit_id = permit.id
        ), '[]'::jsonb)
      ) ORDER BY permit.date_to DESC NULLS LAST, permit.created_at DESC)
      FROM public.person_permits permit JOIN public.organizations org ON org.id = permit.organization_id
      LEFT JOIN public.organizations client ON client.id = permit.client_organization_id
      WHERE permit.canonical_person_id = r.id AND permit.organization_id = ANY(v_orgs)
    ), '[]'::jsonb),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'canonical_vehicle_id', vehicle.id, 'plate_number', vehicle.plate_number,
        'make', vehicle.make, 'model', vehicle.model, 'colour', vehicle.colour,
        'relationship', link.relationship, 'since', link.starts_at,
        'source', CASE WHEN link.organization_id = ANY(v_identity_orgs) THEN link.evidence->>'source' END,
        'source_checked_at', CASE WHEN link.organization_id = ANY(v_identity_orgs) THEN link.evidence->>'source_checked_at' END
      ) ORDER BY link.starts_at DESC NULLS LAST)
      FROM public.entity_links link JOIN public.canonical_vehicles vehicle ON vehicle.id = link.to_id
      WHERE link.from_type = 'person' AND link.from_id = r.id AND link.to_type = 'vehicle'
        AND link.active AND link.organization_id = ANY(v_orgs)
        AND (link.relationship NOT IN ('owner', 'registered_owner', 'driver', 'associated_person')
          OR link.organization_id = ANY(v_identity_orgs))
        AND (NOT coalesce((link.evidence->>'nzta_restricted')::boolean, false) OR link.organization_id = ANY(rv.orgs))
    ), '[]'::jsonb),
    'nzta_authorised', cardinality(v_identity_orgs) > 0,
    -- A reveal opens NZTA data only for the organisations it was logged in;
    -- anything recorded by another authorised organisation still needs a reveal.
    'nzta_reveal_required', cardinality(v_identity_orgs) > 0 AND (
      EXISTS (SELECT 1 FROM public.vehicle_identity_checks pending_check
              WHERE pending_check.canonical_person_id = r.id AND pending_check.organization_id = ANY(v_identity_orgs)
                AND pending_check.organization_id <> ALL(rv.orgs))
      OR EXISTS (SELECT 1 FROM public.entity_links pending_link
                 WHERE pending_link.from_type = 'person' AND pending_link.from_id = r.id AND pending_link.to_type = 'vehicle'
                   AND pending_link.active AND pending_link.organization_id = ANY(v_identity_orgs)
                   AND pending_link.organization_id <> ALL(rv.orgs)
                   AND coalesce((pending_link.evidence->>'nzta_restricted')::boolean, false))),
    'nzta', CASE WHEN cardinality(rv.orgs) = 0 THEN NULL ELSE (
      SELECT jsonb_build_object(
        'address', CASE WHEN check_row.organization_id = ANY(v_contact_orgs) THEN
          coalesce(doc.extracted_fields->'approved'->>'address',
                   doc.extracted_fields->'proposed'->>'physical_address',
                   doc.extracted_fields->'proposed'->>'address') END,
        'last_checked_at', check_row.checked_at,
        'checks', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'plate_number', checked_vehicle.plate_number, 'checked_at', history.checked_at
          ) ORDER BY history.checked_at DESC), '[]'::jsonb)
          FROM public.vehicle_identity_checks history
          JOIN public.canonical_vehicles checked_vehicle ON checked_vehicle.id = history.canonical_vehicle_id
          WHERE history.canonical_person_id = r.id AND history.organization_id = ANY(rv.orgs)
        )
      )
      FROM public.vehicle_identity_checks check_row
      JOIN public.person_identity_documents doc ON doc.id = check_row.identity_document_id
      WHERE check_row.canonical_person_id = r.id AND check_row.organization_id = ANY(rv.orgs)
      ORDER BY check_row.checked_at DESC LIMIT 1
    ) END
  ) ORDER BY r.exact_match DESC, r.has_notice_in_force DESC, r.display_name), '[]'::jsonb)
  INTO v_result FROM ranked r
  CROSS JOIN LATERAL (
    SELECT array(SELECT org_id FROM unnest(v_identity_orgs) org_id
                 WHERE public.nzta_reveal_active(ARRAY[org_id], 'person', r.id)) AS orgs
  ) rv;
  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.search_people(text, integer) IS 'Authorized operational person search by name, alias or exact permit number. Organization-scoped notices, permits and linked vehicles. NZTA-sourced person-vehicle links and the NZTA block need vehicle-owner authorisation plus an open purpose-stated reveal (reveal_nzta_registered_person). Private contact/address values require active Admin, Admin officer, Master or Grand Master access. No firearm licence numbers.';
COMMENT ON FUNCTION public.get_vehicle_owner_links(uuid, uuid) IS 'Scoped vehicle-person links. NZTA-restricted links show identity only to vehicle-owner-authorised users with an open purpose-stated reveal for the vehicle. Private contact/address/locality and free-text basis also require operations administrator roles. Owner history remains source-time observations, never legal transfer dates.';
COMMENT ON FUNCTION public.get_vehicle_identity_checks(uuid, uuid) IS 'Administrator-only vehicle view of human-approved NZTA source-time checks. Person and private evidence paths are returned only with vehicle-owner authorisation and an open purpose-stated reveal.';
COMMENT ON FUNCTION public.set_vehicle_owner_access(uuid, boolean, text) IS 'Audited administrator switch for a user''s vehicle_owner_identity access area. New grants require current NZTA register training and confidentiality acceptance; existing grants are not revoked.';

-- Identity registry: NZTA source documents follow the reveal rule.
CREATE OR REPLACE FUNCTION "public"."get_identity_registry"(p_organization_id uuid, p_search text DEFAULT NULL::text, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_search text := lower(trim(coalesce(p_search, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 250));
  v_visible_organizations uuid[];
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;

  SELECT array_agg(DISTINCT scope.id)
    INTO v_visible_organizations
    FROM (
      SELECT p_organization_id AS id
      UNION
      SELECT unnest(public.get_descendant_organizations(p_organization_id))
      UNION
      SELECT agreement.client_organization_id
      FROM public.service_agreements AS agreement
      WHERE agreement.provider_organization_id = p_organization_id
        AND agreement.agreement_type = 'operational'
        AND agreement.invitation_status = 'accepted'
    ) AS scope;

  RETURN jsonb_build_object(
    'people', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'person_record_id', person.id,
        'canonical_person_id', link.canonical_person_id,
        'display_name', person.display_name,
        'review_state', person.review_state,
        'profile_details', coalesce(person.metadata->'profile_details', '{}'::jsonb),
        'date_of_birth', coalesce(person.metadata->'profile_details'->>'date_of_birth', canonical.date_of_birth::text),
        'canonical_review_state', canonical.review_state,
        'face_candidate_ready', EXISTS (
          SELECT 1 FROM public.person_face_templates face
          WHERE face.person_record_id = person.id
            AND face.organization_id = person.organization_id
        ),
        'document_count', (
          SELECT count(*)
          FROM public.person_identity_documents document
          WHERE document.person_record_id = person.id
        )
      ) ORDER BY lower(coalesce(person.display_name, '')), person.created_at)
      FROM (
        SELECT *
        FROM public.person_records
        WHERE organization_id = p_organization_id
          AND (
            v_search = ''
            OR lower(coalesce(display_name, '') || ' ' || coalesce(metadata::text, ''))
              LIKE '%' || v_search || '%'
          )
        ORDER BY created_at DESC
        LIMIT v_limit
      ) AS person
      LEFT JOIN public.canonical_person_links AS link
        ON link.source_table = 'person_records'
       AND link.source_id = person.id
      LEFT JOIN public.canonical_people AS canonical
        ON canonical.id = link.canonical_person_id
    ), '[]'::jsonb),
    'vehicle_total', (
      SELECT count(*)
      FROM public.canonical_vehicles AS vehicle
      WHERE (
        vehicle.org_notes ? p_organization_id::text
        OR EXISTS (
          SELECT 1
          FROM public.canonical_vehicle_links AS link
          WHERE link.canonical_vehicle_id = vehicle.id
            AND nullif(link.metadata->>'organization_id', '')::uuid = ANY(v_visible_organizations)
        )
        OR EXISTS (
          SELECT 1
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        )
        OR EXISTS (
          SELECT 1
          FROM public.cctv_entity_observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        )
      )
      AND (
        v_search = ''
        OR lower(concat_ws(
          ' ',
          vehicle.plate_number,
          vehicle.make,
          vehicle.model,
          vehicle.colour,
          vehicle.body_type
        )) LIKE '%' || v_search || '%'
      )
    ),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', vehicle.id,
        'plate_number', vehicle.plate_number,
        'make', vehicle.make,
        'model', vehicle.model,
        'year', vehicle.year,
        'colour', vehicle.colour,
        'body_type', vehicle.body_type,
        'rego_status', vehicle.rego_status,
        'rego_expiry', vehicle.rego_expiry,
        'wof_status', vehicle.wof_status,
        'wof_expiry', vehicle.wof_expiry,
        'cof_status', vehicle.cof_status,
        'cof_expiry', vehicle.cof_expiry,
        'notes', vehicle.org_notes->p_organization_id::text->>'text',
        'compliance_source', vehicle.compliance_source,
        'compliance_checked_at', vehicle.compliance_checked_at,
        'observation_count', (
          SELECT count(*)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'evidence_count', (
          SELECT count(*)
          FROM public.observations AS observation
          JOIN public.evidence_items AS evidence
            ON evidence.organization_id = observation.organization_id
           AND evidence.metadata->>'observation_id' = observation.id::text
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'first_seen_at', (
          SELECT min(observation.observed_at)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'last_seen_at', (
          SELECT max(observation.observed_at)
          FROM public.observations AS observation
          WHERE observation.organization_id = ANY(v_visible_organizations)
            AND observation.canonical_vehicle_id = vehicle.id
        ),
        'source_kinds', coalesce((
          SELECT jsonb_agg(source.kind ORDER BY source.kind)
          FROM (
            SELECT DISTINCT CASE
              WHEN observation.module_key = 'cctv_review' THEN 'CCTV review'
              WHEN observation.plate_source = 'historical_import' THEN 'Approved patrol record'
              ELSE 'Field observation'
            END AS kind
            FROM public.observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = vehicle.id
          ) AS source
        ), '[]'::jsonb)
      ) ORDER BY coalesce(vehicle.last_seen_at, vehicle.updated_at) DESC, vehicle.plate_number)
      FROM (
        SELECT *
        FROM public.canonical_vehicles AS candidate
        WHERE (
          candidate.org_notes ? p_organization_id::text
          OR EXISTS (
            SELECT 1
            FROM public.canonical_vehicle_links AS link
            WHERE link.canonical_vehicle_id = candidate.id
              AND nullif(link.metadata->>'organization_id', '')::uuid = ANY(v_visible_organizations)
          )
          OR EXISTS (
            SELECT 1
            FROM public.observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = candidate.id
          )
          OR EXISTS (
            SELECT 1
            FROM public.cctv_entity_observations AS observation
            WHERE observation.organization_id = ANY(v_visible_organizations)
              AND observation.canonical_vehicle_id = candidate.id
          )
        )
        AND (
          v_search = ''
          OR lower(concat_ws(
            ' ',
            candidate.plate_number,
            candidate.make,
            candidate.model,
            candidate.colour,
            candidate.body_type
          )) LIKE '%' || v_search || '%'
        )
        ORDER BY coalesce(candidate.last_seen_at, candidate.updated_at) DESC, candidate.plate_number
        LIMIT v_limit
      ) AS vehicle
    ), '[]'::jsonb),
    'documents', coalesce((
      -- NZTA Motor Vehicle Register records linked to a check stay masked until
      -- the caller opens a purpose-stated reveal for that vehicle or person.
      SELECT jsonb_agg(CASE WHEN restriction.restricted THEN jsonb_build_object(
        'id', document.id,
        'document_kind', document.document_kind,
        'review_state', document.review_state,
        'created_at', document.created_at,
        'reviewed_at', document.reviewed_at,
        'nzta_restricted', true,
        'canonical_vehicle_id', nzta_check.canonical_vehicle_id,
        'plate_number', nzta_vehicle.plate_number
      ) ELSE jsonb_build_object(
        'id', document.id,
        'person_record_id', document.person_record_id,
        'evidence_item_id', document.evidence_item_id,
        'attachment_id', document.attachment_id,
        'document_kind', document.document_kind,
        'extracted_fields', document.extracted_fields,
        'review_state', document.review_state,
        'review_notes', document.review_notes,
        'created_at', document.created_at,
        'reviewed_at', document.reviewed_at,
        'file_name', attachment.file_name,
        'file_type', attachment.file_type,
        'storage_bucket', attachment.storage_bucket,
        'storage_path', attachment.storage_path,
        'nzta_restricted', false,
        'canonical_vehicle_id', nzta_check.canonical_vehicle_id,
        'plate_number', nzta_vehicle.plate_number
      ) END ORDER BY document.created_at DESC)
      FROM public.person_identity_documents AS document
      LEFT JOIN public.bob_attachments AS attachment
        ON attachment.id = document.attachment_id
      LEFT JOIN public.vehicle_identity_checks AS nzta_check
        ON nzta_check.identity_document_id = document.id
      LEFT JOIN public.canonical_vehicles AS nzta_vehicle
        ON nzta_vehicle.id = nzta_check.canonical_vehicle_id
      CROSS JOIN LATERAL (
        SELECT document.document_kind = 'nzta_mvr_record' AND nzta_check.id IS NOT NULL
          AND public.nzta_document_restricted(document.id) AS restricted
      ) AS restriction
      WHERE document.organization_id = p_organization_id
    ), '[]'::jsonb)
  );
END;
$function$;
COMMENT ON FUNCTION public.get_identity_registry(uuid, text, integer) IS 'Administrator-only tenant registry of people and all canonical vehicles evidenced by the organization or its accepted operational clients. Vehicle results include source, sighting, and evidence summaries. NZTA Motor Vehicle Register documents linked to a check return only id, kind, state, vehicle and nzta_restricted=true until the caller opens a purpose-stated reveal for the vehicle or person.';
REVOKE ALL ON FUNCTION public.get_identity_registry(uuid, text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_identity_registry(uuid, text, integer) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_vehicle_identity_checks(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_identity_checks(uuid, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_nzta_register_lookup(uuid, timestamptz, text, text, text, text, text, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_nzta_register_lookup(uuid, timestamptz, text, text, text, text, text, uuid, uuid, uuid, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.set_nzta_register_lookup_outcome(uuid, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_nzta_register_lookup_outcome(uuid, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.list_nzta_register_lookups(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_nzta_register_lookups(uuid, timestamptz, timestamptz, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.reveal_nzta_registered_person(text, uuid, text, text, uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reveal_nzta_registered_person(text, uuid, text, text, uuid, uuid, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.list_nzta_register_access_log(uuid, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_nzta_register_access_log(uuid, timestamptz, timestamptz, integer) TO authenticated;
REVOKE ALL ON FUNCTION public.record_nzta_access_attestation(uuid, text, date, date, text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_nzta_access_attestation(uuid, text, date, date, text, text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.link_nzta_register_lookup_check(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_nzta_register_lookup_check(uuid, uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.list_nzta_follow_up_notices(text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_nzta_follow_up_notices(text, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_nzta_reveal_seconds_remaining(text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_nzta_reveal_seconds_remaining(text, uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.withdraw_nzta_access_attestation(uuid, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.withdraw_nzta_access_attestation(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.get_nzta_access_holders(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_nzta_access_holders(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.record_nzta_access_review(uuid, date, date, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_nzta_access_review(uuid, date, date, text, text) TO authenticated;
REVOKE ALL ON FUNCTION public.list_nzta_access_reviews(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_nzta_access_reviews(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_nzta_s241_summary(uuid, date, date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_nzta_s241_summary(uuid, date, date) TO authenticated;

-- 13. Direct table reads cannot bypass the reveal. Every application reader is a
--     definer RPC above; these policies close the PostgREST table path.
--     RLS expressions run as the caller, so the reveal check is granted to
--     signed-in users. It only reports the caller's own open reveal window.
GRANT EXECUTE ON FUNCTION public.nzta_reveal_active(uuid[], text, uuid) TO authenticated;

ALTER POLICY entity_links_select ON public.entity_links
  USING (
    public.org_access_allowed(organization_id)
    AND (
      relationship <> ALL (ARRAY['owner', 'registered_owner', 'driver', 'associated_person'])
      OR (
        public.can_access_vehicle_owner_identity(organization_id)
        AND public.can_access_person_contacts(organization_id)
        AND (
          NOT coalesce((evidence->>'nzta_restricted')::boolean, false)
          OR (to_type = 'vehicle' AND public.nzta_reveal_active(ARRAY[organization_id], 'vehicle', to_id))
          OR (from_type = 'person' AND public.nzta_reveal_active(ARRAY[organization_id], 'person', from_id))
        )
      )
    )
  );

-- NZTA Motor Vehicle Register source documents are read only through the
-- reveal-gated identity-check RPC, never directly.
ALTER POLICY person_identity_documents_select ON public.person_identity_documents
  USING (
    organization_id IS NOT NULL
    AND public.is_admin_for_org(organization_id)
    AND document_kind IS DISTINCT FROM 'nzta_mvr_record'
  );

-- The files behind an NZTA check (attachment row, evidence row, Storage
-- object) follow the same reveal rule as the check itself. The helpers run in
-- policies for every role and fail closed when no caller is signed in.
REVOKE ALL ON FUNCTION public.nzta_document_restricted(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nzta_attachment_restricted(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nzta_storage_object_restricted(text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.nzta_evidence_restricted(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nzta_document_restricted(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nzta_attachment_restricted(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nzta_storage_object_restricted(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nzta_evidence_restricted(uuid) TO anon, authenticated, service_role;

ALTER POLICY bob_attachments_select ON public.bob_attachments
  USING (
    public.org_access_allowed(organization_id)
    AND (purpose <> 'identity_document'
         OR (public.is_admin_for_org(organization_id) AND NOT public.nzta_attachment_restricted(id)))
  );

ALTER POLICY evidence_items_select ON public.evidence_items
  USING (
    public.org_access_allowed(organization_id)
    AND (module_key IS DISTINCT FROM 'identity_registry' OR NOT public.nzta_evidence_restricted(id))
  );

DROP POLICY IF EXISTS identity_evidence_select ON storage.objects;
CREATE POLICY identity_evidence_select ON storage.objects FOR SELECT USING (
  bucket_id = 'identity-evidence'
  AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F-]{36}$'
  AND (
    public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
    OR ((storage.foldername(name))[3] = 'identity' AND (storage.foldername(name))[4] = (auth.uid())::text
        AND (storage.foldername(name))[5] ~ '^incident-[0-9a-fA-F-]{36}$'
        AND public.can_record_incident_person((substring((storage.foldername(name))[5] FROM 10))::uuid, auth.uid()))
    OR ((storage.foldername(name))[3] = 'identity' AND (storage.foldername(name))[4] = (auth.uid())::text
        AND (storage.foldername(name))[5] ~ '^submission-[0-9a-fA-F-]{36}$'
        AND public.org_access_allowed(((storage.foldername(name))[2])::uuid))
  )
  AND NOT public.nzta_storage_object_restricted(bucket_id, name)
);
