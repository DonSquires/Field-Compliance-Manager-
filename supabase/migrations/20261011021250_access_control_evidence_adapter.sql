-- Access control is a field-operations module, not the staff-permission admin
-- page. Recognition may discover and rank possible people and vehicles before
-- the officer acts. The officer records what they did at the place; candidate
-- discovery never grants entry or becomes confirmed identity by itself.

CREATE TABLE public.access_control_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  location_event_id uuid REFERENCES public.location_events(id) ON DELETE RESTRICT,
  site_id uuid REFERENCES public.client_sites(id) ON DELETE RESTRICT,
  zone_id uuid REFERENCES public.location_zones(id) ON DELETE RESTRICT,
  shift_id uuid REFERENCES public.shifts(id) ON DELETE SET NULL,
  officer_user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'entry_request', 'exit', 'credential_check', 'visitor_arrival', 'door_security_check'
  )),
  subject_kind text NOT NULL CHECK (subject_kind IN ('person', 'vehicle', 'mixed', 'unknown')),
  officer_decision text NOT NULL CHECK (officer_decision IN (
    'admitted', 'refused', 'escorted', 'departed', 'record_only'
  )),
  decision_basis text NOT NULL CHECK (decision_basis IN (
    'credential_present', 'known_person', 'visitor_authorization',
    'supervisor_authorization', 'safety_refusal', 'policy_refusal',
    'no_decision', 'other'
  )),
  claimed_identity text CHECK (claimed_identity IS NULL OR char_length(claimed_identity) BETWEEN 1 AND 200),
  credential_reference text CHECK (credential_reference IS NULL OR char_length(credential_reference) BETWEEN 1 AND 160),
  notes text CHECK (notes IS NULL OR char_length(notes) <= 4000),
  gps_lat double precision CHECK (gps_lat IS NULL OR gps_lat BETWEEN -90 AND 90),
  gps_lng double precision CHECK (gps_lng IS NULL OR gps_lng BETWEEN -180 AND 180),
  geofence_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(geofence_context) = 'object'),
  evidence_state text NOT NULL DEFAULT 'not_provided'
    CHECK (evidence_state IN ('not_provided', 'received', 'court_ready')),
  recognition_summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(recognition_summary) = 'object'),
  recognition_review_state text NOT NULL DEFAULT 'not_requested'
    CHECK (recognition_review_state IN ('not_requested', 'unavailable', 'requires_supervisor_review', 'reviewed')),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, client_request_id),
  CHECK (num_nonnulls(site_id, zone_id) > 0),
  CHECK (
    officer_decision <> 'admitted'
    OR decision_basis IN (
      'credential_present', 'known_person', 'visitor_authorization',
      'supervisor_authorization', 'other'
    )
  )
);

COMMENT ON TABLE public.access_control_events IS
  'Human-authored field record of an access encounter at a place. recognition_summary may contain ranked person/vehicle discovery candidates, but can never grant entry, confirm identity, or replace the officer decision.';
COMMENT ON COLUMN public.access_control_events.officer_decision IS
  'The attributable action recorded by the officer. It is independent of and authoritative over any machine recognition candidate.';
COMMENT ON COLUMN public.access_control_events.recognition_summary IS
  'Sanitized recognition probes and ranked possible person/vehicle matches. Embeddings are excluded; human confirmation and access authorization remain separate.';
COMMENT ON COLUMN public.access_control_events.geofence_context IS
  'Exact resolve_context-style receipt supplied by the governed edge function. Unresolved states remain visible and are never converted to a successful place verification.';

CREATE INDEX access_control_events_org_time_idx
  ON public.access_control_events (organization_id, observed_at DESC);
CREATE INDEX access_control_events_officer_time_idx
  ON public.access_control_events (officer_user_id, observed_at DESC);
CREATE INDEX access_control_events_site_time_idx
  ON public.access_control_events (site_id, observed_at DESC)
  WHERE site_id IS NOT NULL;
CREATE INDEX access_control_events_zone_time_idx
  ON public.access_control_events (zone_id, observed_at DESC)
  WHERE zone_id IS NOT NULL;
CREATE INDEX access_control_events_review_queue_idx
  ON public.access_control_events (organization_id, observed_at DESC)
  WHERE recognition_review_state = 'requires_supervisor_review';
CREATE INDEX access_control_events_location_event_idx
  ON public.access_control_events (location_event_id)
  WHERE location_event_id IS NOT NULL;
CREATE INDEX access_control_events_shift_idx
  ON public.access_control_events (shift_id)
  WHERE shift_id IS NOT NULL;

CREATE TABLE public.access_control_event_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  access_control_event_id uuid NOT NULL REFERENCES public.access_control_events(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE RESTRICT,
  purpose text NOT NULL DEFAULT 'primary_evidence'
    CHECK (purpose IN ('primary_evidence', 'supporting_evidence')),
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (access_control_event_id, evidence_item_id),
  UNIQUE (access_control_event_id, ordinal)
);

COMMENT ON TABLE public.access_control_event_evidence IS
  'Chain-of-custody links between a typed access-control event and the shared evidence spine.';

CREATE INDEX access_control_event_evidence_org_idx
  ON public.access_control_event_evidence (organization_id, access_control_event_id);
CREATE INDEX access_control_event_evidence_item_idx
  ON public.access_control_event_evidence (evidence_item_id);

ALTER TABLE public.access_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.access_control_event_evidence ENABLE ROW LEVEL SECURITY;

CREATE POLICY access_control_events_select
  ON public.access_control_events
  FOR SELECT TO authenticated
  USING (
    officer_user_id = (SELECT auth.uid())
    OR public.is_admin_for_org(organization_id)
  );

CREATE POLICY access_control_event_evidence_select
  ON public.access_control_event_evidence
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.access_control_events event
      WHERE event.id = access_control_event_id
        AND (
          event.officer_user_id = (SELECT auth.uid())
          OR public.is_admin_for_org(event.organization_id)
        )
    )
  );

REVOKE ALL ON TABLE public.access_control_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.access_control_event_evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.access_control_events TO authenticated;
GRANT SELECT ON TABLE public.access_control_event_evidence TO authenticated;
GRANT ALL ON TABLE public.access_control_events TO service_role;
GRANT ALL ON TABLE public.access_control_event_evidence TO service_role;

CREATE OR REPLACE FUNCTION public.submit_access_control_event_receipt(
  p_actor_user_id uuid,
  p_client_request_id uuid,
  p_observed_at timestamptz,
  p_site_id uuid,
  p_zone_id uuid,
  p_shift_id uuid,
  p_event_kind text,
  p_subject_kind text,
  p_officer_decision text,
  p_decision_basis text,
  p_claimed_identity text,
  p_credential_reference text,
  p_notes text,
  p_gps_lat double precision,
  p_gps_lng double precision,
  p_geofence_context jsonb,
  p_evidence_items jsonb,
  p_recognition jsonb
)
RETURNS TABLE (
  id uuid,
  created boolean,
  received_at timestamptz,
  evidence_state text,
  recognition_review_state text,
  geofence_status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_shift public.shifts%ROWTYPE;
  v_existing public.access_control_events%ROWTYPE;
  v_event public.access_control_events%ROWTYPE;
  v_location_event_id uuid;
  v_evidence jsonb;
  v_evidence_id uuid;
  v_ordinal integer := 0;
  v_has_module boolean := false;
  v_has_place_access boolean := false;
  v_recognition jsonb := '{}'::jsonb;
  v_recognition_state text := 'not_requested';
  v_evidence_state text := 'not_provided';
  v_source_hash text;
  v_site_location_id uuid;
  v_zone_location_id uuid;
BEGIN
  IF coalesce(auth.jwt()->>'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_actor_user_id IS NULL OR p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'Actor and client request id are required';
  END IF;
  IF p_observed_at IS NULL OR p_observed_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'A valid observation time is required';
  END IF;
  IF num_nonnulls(p_site_id, p_zone_id) = 0 THEN
    RAISE EXCEPTION 'A site or zone place anchor is required';
  END IF;
  IF p_event_kind NOT IN (
    'entry_request', 'exit', 'credential_check', 'visitor_arrival', 'door_security_check'
  ) THEN
    RAISE EXCEPTION 'Unsupported access-control event kind';
  END IF;
  IF p_subject_kind NOT IN ('person', 'vehicle', 'mixed', 'unknown') THEN
    RAISE EXCEPTION 'Unsupported access-control subject kind';
  END IF;
  IF p_officer_decision NOT IN ('admitted', 'refused', 'escorted', 'departed', 'record_only') THEN
    RAISE EXCEPTION 'Unsupported officer decision';
  END IF;
  IF p_decision_basis NOT IN (
    'credential_present', 'known_person', 'visitor_authorization',
    'supervisor_authorization', 'safety_refusal', 'policy_refusal',
    'no_decision', 'other'
  ) THEN
    RAISE EXCEPTION 'Unsupported decision basis';
  END IF;
  IF p_officer_decision = 'admitted'
     AND p_decision_basis NOT IN (
       'credential_present', 'known_person', 'visitor_authorization',
       'supervisor_authorization', 'other'
     ) THEN
    RAISE EXCEPTION 'An admitted entry requires an attributable human decision basis';
  END IF;
  IF p_gps_lat IS NOT NULL AND (p_gps_lat < -90 OR p_gps_lat > 90) THEN
    RAISE EXCEPTION 'Latitude is invalid';
  END IF;
  IF p_gps_lng IS NOT NULL AND (p_gps_lng < -180 OR p_gps_lng > 180) THEN
    RAISE EXCEPTION 'Longitude is invalid';
  END IF;
  IF jsonb_typeof(coalesce(p_geofence_context, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Geofence context must be an object';
  END IF;
  IF jsonb_typeof(coalesce(p_evidence_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Evidence items must be an array';
  END IF;
  IF jsonb_array_length(coalesce(p_evidence_items, '[]'::jsonb)) > 5 THEN
    RAISE EXCEPTION 'No more than five evidence items may be submitted';
  END IF;

  SELECT profile.* INTO v_profile
  FROM public.user_profiles profile
  WHERE profile.id = p_actor_user_id
    AND profile.deactivated_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active officer profile required'; END IF;

  IF p_shift_id IS NOT NULL THEN
    SELECT shift_row.* INTO v_shift
    FROM public.shifts shift_row
    WHERE shift_row.id = p_shift_id
      AND shift_row.organization_id = v_profile.organization_id
      AND shift_row.officer_user_id = p_actor_user_id
      AND shift_row.status IN ('scheduled', 'active', 'in_progress');
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Access-control shift is not active for this officer';
    END IF;
  END IF;

  v_has_module :=
    v_profile.role IN ('grand_master', 'master', 'admin', 'admin_officer')
    OR 'access_control' = ANY(v_profile.module_access)
    OR (
      p_shift_id IS NOT NULL
      AND (
        v_shift.module_key = 'access_control'
        OR v_shift.service_type = 'access_control'
      )
    );
  IF NOT v_has_module THEN
    RAISE EXCEPTION 'Access-control standing authority or an active access-control shift is required';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organization_modules
    WHERE organization_id = v_profile.organization_id
  ) AND NOT EXISTS (
    SELECT 1 FROM public.organization_modules
    WHERE organization_id = v_profile.organization_id
      AND module_key = 'access_control'
      AND enabled
  ) THEN
    RAISE EXCEPTION 'Access Control is not enabled for this organization';
  END IF;

  IF p_site_id IS NOT NULL THEN
    SELECT site.location_id INTO v_site_location_id
    FROM public.client_sites site
    WHERE site.id = p_site_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Access-control site is missing'; END IF;

    v_has_place_access := EXISTS (
      SELECT 1
      FROM public.client_sites site
      WHERE site.id = p_site_id
        AND (
          site.client_organization_id = v_profile.organization_id
          OR EXISTS (
            SELECT 1
            FROM public.service_agreement_locations location
            JOIN public.service_agreements agreement
              ON agreement.id = location.service_agreement_id
            WHERE location.site_id = site.id
              AND location.status = 'active'
              AND agreement.agreement_type = 'operational'
              AND agreement.invitation_status = 'accepted'
              AND (
                agreement.provider_organization_id = v_profile.organization_id
                OR location.head_contractor_org_id = v_profile.organization_id
              )
          )
        )
    );
  END IF;

  IF p_zone_id IS NOT NULL THEN
    SELECT zone.location_id INTO v_zone_location_id
    FROM public.location_zones zone
    WHERE zone.id = p_zone_id
      AND zone.module_key = 'access_control';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Access-control zone is missing or belongs to another module';
    END IF;

    v_has_place_access := v_has_place_access OR EXISTS (
      SELECT 1
      FROM public.location_zones zone
      WHERE zone.id = p_zone_id
        AND (
          zone.organization_id = v_profile.organization_id
          OR EXISTS (
            SELECT 1
            FROM public.service_agreement_locations location
            JOIN public.service_agreements agreement
              ON agreement.id = location.service_agreement_id
            WHERE location.zone_id = zone.id
              AND location.status = 'active'
              AND agreement.agreement_type = 'operational'
              AND agreement.invitation_status = 'accepted'
              AND (
                agreement.provider_organization_id = v_profile.organization_id
                OR location.head_contractor_org_id = v_profile.organization_id
              )
          )
        )
    );
  END IF;

  IF p_site_id IS NOT NULL AND p_zone_id IS NOT NULL
     AND v_site_location_id IS DISTINCT FROM v_zone_location_id THEN
    RAISE EXCEPTION 'Selected site and zone do not describe the same canonical place';
  END IF;
  IF NOT v_has_place_access THEN
    RAISE EXCEPTION 'Officer organization has no active authority at this place';
  END IF;

  SELECT * INTO v_existing
  FROM public.access_control_events
  WHERE organization_id = v_profile.organization_id
    AND client_request_id = p_client_request_id;
  IF FOUND THEN
    RETURN QUERY SELECT
      v_existing.id, false, v_existing.received_at, v_existing.evidence_state,
      v_existing.recognition_review_state,
      coalesce(v_existing.geofence_context->>'resolution_status', 'not_evaluated');
    RETURN;
  END IF;

  IF jsonb_typeof(coalesce(p_recognition, '{}'::jsonb)) = 'object'
     AND coalesce(p_recognition->>'status', 'unavailable') = 'available' THEN
    v_recognition := jsonb_strip_nulls(jsonb_build_object(
      'status', 'available',
      'classification', nullif(trim(p_recognition->>'classification'), ''),
      'confidence', CASE
        WHEN p_recognition->>'confidence' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (p_recognition->>'confidence')::real
      END,
      'details', jsonb_strip_nulls(jsonb_build_object(
        'subject_kind', p_recognition#>>'{details,subject_kind}',
        'person_present', p_recognition#>'{details,person_present}',
        'face_visible', p_recognition#>'{details,face_visible}',
        'credential_visible', p_recognition#>'{details,credential_visible}',
        'vehicle_present', p_recognition#>'{details,vehicle_present}'
      )),
      'probes', CASE
        WHEN jsonb_typeof(p_recognition->'probes') = 'array'
          THEN p_recognition->'probes'
        ELSE '[]'::jsonb
      END,
      'reasoning', nullif(trim(p_recognition->>'reasoning'), ''),
      'classifier', nullif(trim(p_recognition->>'classifier'), ''),
      'provider', nullif(trim(p_recognition->>'provider'), ''),
      'model', nullif(trim(p_recognition->>'model'), ''),
      'prompt_version', nullif(trim(p_recognition->>'prompt_version'), ''),
      'machine_candidate_discovery_permitted', true,
      'machine_identity_confirmation_permitted', false,
      'machine_access_decision_permitted', false
    ));
    v_recognition_state := 'requires_supervisor_review';
  ELSIF jsonb_typeof(coalesce(p_recognition, '{}'::jsonb)) = 'object'
        AND coalesce(p_recognition->>'status', 'not_requested') <> 'not_requested' THEN
    v_recognition := jsonb_build_object(
      'status', 'unavailable',
      'failure_reason', nullif(trim(p_recognition->>'failure_reason'), ''),
      'machine_candidate_discovery_permitted', true,
      'machine_identity_confirmation_permitted', false,
      'machine_access_decision_permitted', false
    );
    v_recognition_state := 'unavailable';
  END IF;

  IF jsonb_array_length(coalesce(p_evidence_items, '[]'::jsonb)) > 0 THEN
    v_evidence_state := 'received';
  END IF;

  INSERT INTO public.access_control_events (
    organization_id, client_request_id, site_id, zone_id, shift_id,
    officer_user_id, observed_at, event_kind, subject_kind,
    officer_decision, decision_basis, claimed_identity, credential_reference,
    notes, gps_lat, gps_lng, geofence_context, evidence_state,
    recognition_summary, recognition_review_state
  ) VALUES (
    v_profile.organization_id, p_client_request_id, p_site_id, p_zone_id, p_shift_id,
    p_actor_user_id, p_observed_at, p_event_kind, p_subject_kind,
    p_officer_decision, p_decision_basis,
    nullif(trim(coalesce(p_claimed_identity, '')), ''),
    nullif(trim(coalesce(p_credential_reference, '')), ''),
    nullif(trim(coalesce(p_notes, '')), ''),
    p_gps_lat, p_gps_lng, coalesce(p_geofence_context, '{}'::jsonb),
    v_evidence_state, v_recognition, v_recognition_state
  )
  RETURNING * INTO v_event;

  INSERT INTO public.location_events (
    organization_id, client_site_id, zone_id, event_type, module_key,
    occurred_at, status, source, external_ref, payload, created_by,
    observed_entity_type
  ) VALUES (
    v_profile.organization_id,
    CASE WHEN p_zone_id IS NULL THEN p_site_id ELSE NULL END,
    p_zone_id,
    'access_control.' || p_event_kind,
    'access_control',
    p_observed_at,
    p_officer_decision,
    'access_control_field',
    'access-control:' || v_event.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'access_control_event_id', v_event.id,
      'subject_kind', p_subject_kind,
      'officer_decision', p_officer_decision,
      'decision_basis', p_decision_basis,
      'evidence_state', v_evidence_state,
      'recognition_review_state', v_recognition_state,
      'geofence_status', coalesce(p_geofence_context->>'resolution_status', 'not_evaluated')
    )),
    p_actor_user_id,
    CASE WHEN p_subject_kind IN ('person', 'vehicle') THEN p_subject_kind ELSE NULL END
  )
  RETURNING public.location_events.id INTO v_location_event_id;

  UPDATE public.access_control_events
  SET location_event_id = v_location_event_id,
      updated_at = clock_timestamp()
  WHERE public.access_control_events.id = v_event.id;

  FOR v_evidence IN
    SELECT value
    FROM jsonb_array_elements(coalesce(p_evidence_items, '[]'::jsonb))
  LOOP
    IF jsonb_typeof(v_evidence) <> 'object' THEN
      RAISE EXCEPTION 'Each evidence item must be an object';
    END IF;
    v_source_hash := lower(coalesce(
      nullif(v_evidence->>'watermarked_sha256', ''),
      nullif(v_evidence->>'sha256_hash', '')
    ));
    IF v_source_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Each access-control evidence item requires a SHA-256 hash';
    END IF;
    IF nullif(trim(coalesce(v_evidence->>'watermarked_path', v_evidence->>'storage_path', '')), '') IS NULL THEN
      RAISE EXCEPTION 'Each access-control evidence item requires a storage path';
    END IF;

    INSERT INTO public.evidence_items (
      organization_id, module_key, evidence_kind, storage_path,
      captured_by_user_id, captured_at, sha256_hash, is_court_ready,
      locked_at, retention_reason, location_event_id, metadata
    ) VALUES (
      v_profile.organization_id,
      'access_control',
      coalesce(nullif(trim(v_evidence->>'evidence_kind'), ''), 'photo'),
      coalesce(v_evidence->>'watermarked_path', v_evidence->>'storage_path'),
      p_actor_user_id,
      coalesce((v_evidence->>'captured_at')::timestamptz, p_observed_at),
      v_source_hash,
      true,
      clock_timestamp(),
      'access_control_event_evidence',
      v_location_event_id,
      jsonb_strip_nulls(jsonb_build_object(
        'original_path', v_evidence->>'original_path',
        'watermarked_path', v_evidence->>'watermarked_path',
        'raw_sha256', v_evidence->>'raw_sha256',
        'watermarked_sha256', v_evidence->>'watermarked_sha256',
        'watermark_text', v_evidence->>'watermark_text',
        'watermark_service', v_evidence->>'watermark_service',
        'access_control_event_id', v_event.id,
        'authoritative_source_preserved', true
      ))
    )
    RETURNING public.evidence_items.id INTO v_evidence_id;

    INSERT INTO public.access_control_event_evidence (
      organization_id, access_control_event_id, evidence_item_id, purpose, ordinal
    ) VALUES (
      v_profile.organization_id, v_event.id, v_evidence_id,
      CASE WHEN v_ordinal = 0 THEN 'primary_evidence' ELSE 'supporting_evidence' END,
      v_ordinal
    );
    v_ordinal := v_ordinal + 1;
  END LOOP;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_profile.organization_id, p_actor_user_id, 'access_control_event_recorded',
    'access_control_events', v_event.id,
    jsonb_build_object(
      'event_kind', p_event_kind,
      'subject_kind', p_subject_kind,
      'officer_decision', p_officer_decision,
      'decision_basis', p_decision_basis,
      'site_id', p_site_id,
      'zone_id', p_zone_id,
      'location_event_id', v_location_event_id,
      'evidence_count', v_ordinal,
      'recognition_review_state', v_recognition_state,
      'geofence_status', coalesce(p_geofence_context->>'resolution_status', 'not_evaluated')
    )
  );

  RETURN QUERY SELECT
    v_event.id, true, v_event.received_at, v_evidence_state,
    v_recognition_state,
    coalesce(p_geofence_context->>'resolution_status', 'not_evaluated');
END;
$$;

COMMENT ON FUNCTION public.submit_access_control_event_receipt(
  uuid, uuid, timestamptz, uuid, uuid, uuid, text, text, text, text,
  text, text, text, double precision, double precision, jsonb, jsonb, jsonb
) IS
  'Service-only, replay-safe access-control field write. Records the officer action, place event, evidence custody, and advisory recognition separately. Recognition never grants access.';

REVOKE ALL ON FUNCTION public.submit_access_control_event_receipt(
  uuid, uuid, timestamptz, uuid, uuid, uuid, text, text, text, text,
  text, text, text, double precision, double precision, jsonb, jsonb, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_access_control_event_receipt(
  uuid, uuid, timestamptz, uuid, uuid, uuid, text, text, text, text,
  text, text, text, double precision, double precision, jsonb, jsonb, jsonb
) TO service_role;

CREATE INDEX perception_evidence_access_control_event_idx
  ON public.perception_evidence_envelopes ((source_receipt->>'access_control_event_id'))
  WHERE domain = 'access_control_photo';

CREATE OR REPLACE FUNCTION public.record_access_control_perception_envelope(
  p_access_control_event_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event public.access_control_events%ROWTYPE;
  v_link public.access_control_event_evidence%ROWTYPE;
  v_evidence public.evidence_items%ROWTYPE;
  v_details jsonb;
  v_confidence real;
  v_authority text;
  v_idempotency_key text;
  v_envelope_id uuid;
  v_recorded integer := 0;
  v_field record;
  v_probe jsonb;
  v_candidate jsonb;
  v_candidate_ordinal integer := 0;
BEGIN
  IF coalesce(auth.jwt()->>'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO v_event
  FROM public.access_control_events
  WHERE id = p_access_control_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Access-control event is missing'; END IF;

  IF coalesce(v_event.recognition_summary->>'status', 'unavailable') <> 'available' THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'recognition_unavailable');
  END IF;

  SELECT * INTO v_link
  FROM public.access_control_event_evidence
  WHERE access_control_event_id = v_event.id
  ORDER BY ordinal, id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_evidence_link');
  END IF;

  SELECT * INTO v_evidence
  FROM public.evidence_items
  WHERE id = v_link.evidence_item_id
    AND organization_id = v_event.organization_id;
  IF NOT FOUND OR lower(coalesce(v_evidence.sha256_hash, '')) !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_source_hash');
  END IF;

  v_confidence := CASE
    WHEN v_event.recognition_summary->>'confidence' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (v_event.recognition_summary->>'confidence')::real
  END;
  IF v_confidence IS NULL OR v_confidence < 0 OR v_confidence > 1 THEN
    RAISE EXCEPTION 'Access-control recognition confidence is invalid';
  END IF;

  v_details := coalesce(v_event.recognition_summary->'details', '{}'::jsonb);
  v_authority := CASE WHEN v_confidence < 0.5 THEN 'insufficient' ELSE 'candidate' END;
  v_idempotency_key :=
    'access-control-photo:' || v_event.id::text || ':v1:' || lower(v_evidence.sha256_hash);

  SELECT id INTO v_envelope_id
  FROM public.perception_evidence_envelopes
  WHERE organization_id = v_event.organization_id
    AND idempotency_key = v_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 1, 'envelope_id', v_envelope_id);
  END IF;

  INSERT INTO public.perception_evidence_envelopes (
    organization_id, schema_version, domain, source_kind, source_sha256,
    evidence_item_id, source_receipt, model_receipt, derivative_receipts,
    status, idempotency_key
  ) VALUES (
    v_event.organization_id, 1, 'access_control_photo', 'image',
    lower(v_evidence.sha256_hash), v_evidence.id,
    jsonb_strip_nulls(jsonb_build_object(
      'access_control_event_id', v_event.id,
      'location_event_id', v_event.location_event_id,
      'site_id', v_event.site_id,
      'zone_id', v_event.zone_id,
      'observed_at', v_event.observed_at,
      'officer_decision_recorded_separately', true,
      'authoritative_source_preserved', true
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'classifier', v_event.recognition_summary->>'classifier',
      'provider', v_event.recognition_summary->>'provider',
      'model', v_event.recognition_summary->>'model',
      'prompt_version', v_event.recognition_summary->>'prompt_version',
      'machine_candidate_discovery_permitted', true,
      'machine_identity_confirmation_permitted', false,
      'machine_access_decision_permitted', false
    )),
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'evidence_item_id', v_evidence.id,
      'original_path', v_evidence.metadata->>'original_path',
      'watermarked_path', v_evidence.metadata->>'watermarked_path',
      'original_sha256', v_evidence.metadata->>'raw_sha256',
      'watermarked_sha256', v_evidence.sha256_hash,
      'watermark_service', v_evidence.metadata->>'watermark_service'
    ))),
    'manual_review_required',
    v_idempotency_key
  )
  RETURNING id INTO v_envelope_id;

  FOR v_field IN
    SELECT *
    FROM (
      VALUES
        ('access.subject_kind', 'classification', nullif(trim(v_details->>'subject_kind'), '')),
        ('access.person_present', 'boolean', CASE
          WHEN jsonb_typeof(v_details->'person_present') = 'boolean'
            THEN v_details->>'person_present'
        END),
        ('access.face_visible', 'boolean', CASE
          WHEN jsonb_typeof(v_details->'face_visible') = 'boolean'
            THEN v_details->>'face_visible'
        END),
        ('access.credential_visible', 'boolean', CASE
          WHEN jsonb_typeof(v_details->'credential_visible') = 'boolean'
            THEN v_details->>'credential_visible'
        END),
        ('access.vehicle_present', 'boolean', CASE
          WHEN jsonb_typeof(v_details->'vehicle_present') = 'boolean'
            THEN v_details->>'vehicle_present'
        END)
    ) AS fields(field_key, value_type, candidate_value)
    WHERE candidate_value IS NOT NULL
  LOOP
    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      source_locations, consensus_rule, authority_state, review_required
    ) VALUES (
      v_event.organization_id, v_envelope_id, v_field.field_key, 0,
      v_field.value_type, v_field.candidate_value, lower(v_field.candidate_value),
      jsonb_build_object(
        'source', 'deterministic_recognition',
        'candidate_discovery_permitted', true,
        'identity_confirmation_permitted', false,
        'access_decision_permitted', false
      ),
      v_confidence,
      jsonb_build_array(jsonb_build_object(
        'evidence_item_id', v_evidence.id,
        'storage_path', v_evidence.storage_path
      )),
      'advisory_access_scene_candidate_human_review_required_v1',
      v_authority,
      true
    );
    v_recorded := v_recorded + 1;
  END LOOP;

  FOR v_probe IN
    SELECT value
    FROM jsonb_array_elements(CASE
      WHEN jsonb_typeof(v_event.recognition_summary->'probes') = 'array'
        THEN v_event.recognition_summary->'probes'
      ELSE '[]'::jsonb
    END)
  LOOP
    FOR v_candidate IN
      SELECT value
      FROM jsonb_array_elements(CASE
        WHEN jsonb_typeof(v_probe->'candidates') = 'array'
          THEN v_probe->'candidates'
        ELSE '[]'::jsonb
      END)
    LOOP
      IF nullif(trim(v_candidate->>'display_name'), '') IS NULL
         OR coalesce(v_candidate->>'score', '') !~ '^[0-9]+([.][0-9]+)?$' THEN
        CONTINUE;
      END IF;
      v_candidate_ordinal := v_candidate_ordinal + 1;
      INSERT INTO public.perception_evidence_fields (
        organization_id, envelope_id, field_key, candidate_ordinal, value_type,
        candidate_value, normalized_value, candidate_payload, raw_confidence,
        source_locations, consensus_rule, authority_state, review_required
      ) VALUES (
        v_event.organization_id,
        v_envelope_id,
        CASE
          WHEN v_candidate->>'entity_kind' = 'vehicle'
            THEN 'access.vehicle_match_candidate'
          ELSE 'access.person_match_candidate'
        END,
        v_candidate_ordinal,
        'entity',
        v_candidate->>'display_name',
        lower(v_candidate->>'display_name'),
        jsonb_strip_nulls(jsonb_build_object(
          'candidate_id', v_candidate->>'candidate_id',
          'entity_kind', v_candidate->>'entity_kind',
          'match_kind', v_candidate->>'match_kind',
          'basis', v_candidate->>'basis',
          'person_record_id', v_candidate->>'person_record_id',
          'canonical_vehicle_id', v_candidate->>'canonical_vehicle_id',
          'plate_number', v_candidate->>'plate_number',
          'last_seen_at', v_candidate->>'last_seen_at',
          'candidate_discovery_only', true,
          'identity_confirmation_permitted', false,
          'access_decision_permitted', false
        )),
        (v_candidate->>'score')::real,
        jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'evidence_item_id', v_evidence.id,
          'storage_path', v_evidence.storage_path,
          'probe_id', v_probe->>'probe_id',
          'probe_kind', v_probe->>'probe_kind',
          'bbox', v_probe->'bbox'
        ))),
        'ranked_similarity_candidate_human_confirmation_required_v1',
        'candidate',
        true
      );
      v_recorded := v_recorded + 1;
    END LOOP;
  END LOOP;

  IF v_recorded = 0 THEN
    UPDATE public.perception_evidence_envelopes
    SET status = 'failed', updated_at = clock_timestamp()
    WHERE id = v_envelope_id;
    RETURN jsonb_build_object(
      'recorded', 0, 'replayed', 0, 'skipped', 'no_structured_candidates',
      'envelope_id', v_envelope_id
    );
  END IF;

  RETURN jsonb_build_object(
    'recorded', v_recorded, 'replayed', 0, 'envelope_id', v_envelope_id
  );
END;
$$;

COMMENT ON FUNCTION public.record_access_control_perception_envelope(uuid) IS
  'Service-only projection of visible access-scene fields and ranked person/vehicle discovery candidates. Candidates require human confirmation and never grant access.';
REVOKE ALL ON FUNCTION public.record_access_control_perception_envelope(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_access_control_perception_envelope(uuid)
  TO service_role;