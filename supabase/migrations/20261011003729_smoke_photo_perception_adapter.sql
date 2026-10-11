ALTER TABLE public.smoke_assessments
  ADD COLUMN IF NOT EXISTS smoke_ai_review jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.smoke_assessments.smoke_ai_analysis IS
  'Structured advisory visible-image analysis. It is never a statutory smoke breach or enforcement decision.';
COMMENT ON COLUMN public.smoke_assessments.smoke_ai_review IS
  'Attributable human confirmation, correction, or rejection of advisory photo-classification fields.';
COMMENT ON COLUMN public.smoke_assessments.updated_at IS
  'Timestamp of the latest governed assessment, evidence, legal-action, or review state change.';

CREATE INDEX IF NOT EXISTS perception_evidence_smoke_assessment_idx
  ON public.perception_evidence_envelopes ((source_receipt->>'smoke_assessment_id'))
  WHERE domain = 'smoke_photo';

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;

CREATE OR REPLACE FUNCTION private.apply_smoke_photo_review_to_perception(
  p_assessment_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assessment public.smoke_assessments%ROWTYPE;
  v_envelope_id uuid;
  v_review jsonb;
  v_action text;
  v_field public.perception_evidence_fields%ROWTYPE;
  v_next_authority text;
  v_decision text;
  v_final_value text;
  v_correction_id uuid;
  v_ordinal integer;
BEGIN
  SELECT * INTO v_assessment
  FROM public.smoke_assessments
  WHERE id = p_assessment_id;
  IF NOT FOUND OR jsonb_typeof(v_assessment.smoke_ai_review) IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;

  SELECT id INTO v_envelope_id
  FROM public.perception_evidence_envelopes
  WHERE organization_id = v_assessment.organization_id
    AND domain = 'smoke_photo'
    AND source_receipt->>'smoke_assessment_id' = v_assessment.id::text
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF v_envelope_id IS NULL THEN RETURN; END IF;

  v_review := v_assessment.smoke_ai_review;
  v_action := v_review->>'action';
  IF v_action NOT IN ('confirm', 'correct', 'reject') THEN RETURN; END IF;

  IF v_action = 'reject' THEN
    FOR v_field IN
      SELECT *
      FROM public.perception_evidence_fields
      WHERE envelope_id = v_envelope_id
        AND field_key IN (
          'smoke.source_candidate',
          'smoke.severity_candidate',
          'smoke.visibility_impact_candidate'
        )
        AND authority_state <> 'rejected'
      ORDER BY field_key, candidate_ordinal
    LOOP
      INSERT INTO public.perception_evidence_reviews (
        organization_id, field_id, previous_authority_state, decision,
        next_authority_state, reviewer_notes, canonical_reference, decided_by
      ) VALUES (
        v_assessment.organization_id, v_field.id, v_field.authority_state, 'reject',
        'rejected', nullif(trim(v_review->>'notes'), ''),
        jsonb_build_object('smoke_assessment_id', v_assessment.id),
        (v_review->>'reviewed_by')::uuid
      );
      UPDATE public.perception_evidence_fields
      SET authority_state = 'rejected',
          review_required = false,
          updated_at = clock_timestamp()
      WHERE id = v_field.id;
    END LOOP;
    RETURN;
  END IF;

  FOR v_field IN
    SELECT *
    FROM public.perception_evidence_fields
    WHERE envelope_id = v_envelope_id
      AND candidate_ordinal = 0
      AND field_key IN (
        'smoke.source_candidate',
        'smoke.severity_candidate',
        'smoke.visibility_impact_candidate'
      )
    ORDER BY field_key
  LOOP
    IF v_field.field_key = 'smoke.visibility_impact_candidate' THEN
      v_next_authority := 'human_approved';
      v_decision := CASE WHEN v_action = 'correct' THEN 'correct' ELSE 'approve' END;
      INSERT INTO public.perception_evidence_reviews (
        organization_id, field_id, previous_authority_state, decision,
        next_authority_state, reviewer_notes, canonical_reference, decided_by
      ) VALUES (
        v_assessment.organization_id, v_field.id, v_field.authority_state, v_decision,
        v_next_authority, nullif(trim(v_review->>'notes'), ''),
        jsonb_build_object('smoke_assessment_id', v_assessment.id),
        (v_review->>'reviewed_by')::uuid
      );
      UPDATE public.perception_evidence_fields
      SET authority_state = v_next_authority,
          review_required = false,
          updated_at = clock_timestamp()
      WHERE id = v_field.id;
      CONTINUE;
    END IF;

    v_final_value := CASE v_field.field_key
      WHEN 'smoke.source_candidate' THEN v_review->>'smoke_source_type'
      WHEN 'smoke.severity_candidate' THEN v_review->>'severity'
    END;
    IF nullif(trim(coalesce(v_final_value, '')), '') IS NULL THEN CONTINUE; END IF;

    IF v_field.authority_state <> 'superseded' OR v_field.review_required THEN
      INSERT INTO public.perception_evidence_reviews (
        organization_id, field_id, previous_authority_state, decision,
        next_authority_state, reviewer_notes, canonical_reference, decided_by
      ) VALUES (
        v_assessment.organization_id, v_field.id, v_field.authority_state, 'supersede',
        'superseded', nullif(trim(v_review->>'notes'), ''),
        jsonb_build_object('smoke_assessment_id', v_assessment.id),
        (v_review->>'reviewed_by')::uuid
      );
      UPDATE public.perception_evidence_fields
      SET authority_state = 'superseded',
          review_required = false,
          updated_at = clock_timestamp()
      WHERE id = v_field.id;
    END IF;

    SELECT coalesce(max(candidate_ordinal), 0) + 1 INTO v_ordinal
    FROM public.perception_evidence_fields
    WHERE envelope_id = v_envelope_id
      AND field_key = v_field.field_key;

    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, source_locations,
      consensus_rule, authority_state, review_required
    ) VALUES (
      v_assessment.organization_id, v_envelope_id, v_field.field_key, v_ordinal,
      v_field.value_type, to_jsonb(v_final_value), lower(v_final_value),
      jsonb_build_object(
        'source', 'human_smoke_photo_review',
        'action', v_action,
        'machine_candidate_preserved', true
      ),
      v_field.source_locations,
      'attributable_human_smoke_review_v1',
      'candidate',
      true
    )
    RETURNING id INTO v_correction_id;

    INSERT INTO public.perception_evidence_reviews (
      organization_id, field_id, previous_authority_state, decision,
      next_authority_state, reviewer_notes, canonical_reference, decided_by
    ) VALUES (
      v_assessment.organization_id, v_correction_id, 'candidate',
      CASE WHEN v_action = 'correct' THEN 'correct' ELSE 'approve' END,
      'human_approved', nullif(trim(v_review->>'notes'), ''),
      jsonb_build_object('smoke_assessment_id', v_assessment.id),
      (v_review->>'reviewed_by')::uuid
    );
    UPDATE public.perception_evidence_fields
    SET authority_state = 'human_approved',
        review_required = false,
        updated_at = clock_timestamp()
    WHERE id = v_correction_id;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.apply_smoke_photo_review_to_perception(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_smoke_photo_perception_envelope(
  p_assessment_id uuid,
  p_classification jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assessment public.smoke_assessments%ROWTYPE;
  v_link public.smoke_assessment_evidence%ROWTYPE;
  v_evidence public.evidence_items%ROWTYPE;
  v_source_hash text;
  v_source text;
  v_severity text;
  v_visibility text;
  v_reasoning text;
  v_confidence real;
  v_authority text;
  v_idempotency_key text;
  v_envelope_id uuid;
  v_recorded integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF jsonb_typeof(p_classification) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Structured smoke classification is required';
  END IF;

  SELECT * INTO v_assessment
  FROM public.smoke_assessments
  WHERE id = p_assessment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Smoke assessment is missing'; END IF;

  SELECT link.* INTO v_link
  FROM public.smoke_assessment_evidence link
  WHERE link.smoke_assessment_id = v_assessment.id
    AND link.organization_id = v_assessment.organization_id
  ORDER BY
    CASE WHEN link.purpose = 'primary_evidence' THEN 0 ELSE 1 END,
    link.ordinal,
    link.id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_evidence_link');
  END IF;

  SELECT * INTO v_evidence
  FROM public.evidence_items
  WHERE id = v_link.evidence_item_id
    AND organization_id = v_assessment.organization_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_evidence_item');
  END IF;

  v_source_hash := lower(coalesce(
    nullif(v_evidence.sha256_hash, ''),
    nullif(v_evidence.metadata->>'watermarked_sha256', '')
  ));
  IF (v_source_hash ~ '^[0-9a-f]{64}$') IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_source_hash');
  END IF;

  IF coalesce(p_classification->>'status', 'unavailable') <> 'available' THEN
    UPDATE public.smoke_assessments
    SET smoke_ai_analysis = p_classification,
        review_state = 'requires_supervisor_review',
        updated_at = clock_timestamp()
    WHERE id = v_assessment.id;
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'classification_unavailable');
  END IF;

  v_source := nullif(trim(coalesce(
    p_classification#>>'{details,smoke_source}',
    p_classification->>'classification'
  )), '');
  v_severity := nullif(trim(p_classification#>>'{details,severity}'), '');
  v_visibility := nullif(trim(p_classification#>>'{details,visibility_impact}'), '');
  v_reasoning := nullif(trim(p_classification->>'reasoning'), '');
  v_confidence := CASE
    WHEN p_classification->>'confidence' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (p_classification->>'confidence')::real
  END;
  IF v_confidence IS NULL OR v_confidence < 0 OR v_confidence > 1 THEN
    RAISE EXCEPTION 'Smoke classification confidence is invalid';
  END IF;
  IF v_source IS NULL AND v_severity IS NULL AND v_visibility IS NULL THEN
    UPDATE public.smoke_assessments
    SET smoke_ai_analysis = p_classification,
        review_state = 'requires_supervisor_review',
        updated_at = clock_timestamp()
    WHERE id = v_assessment.id;
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'no_structured_candidates');
  END IF;

  UPDATE public.evidence_items
  SET sha256_hash = coalesce(sha256_hash, v_source_hash)
  WHERE id = v_evidence.id;

  UPDATE public.smoke_assessments
  SET smoke_ai_analysis = p_classification,
      smoke_ai_analyzed_at = clock_timestamp(),
      bob_classification = coalesce(v_source, p_classification->>'classification'),
      bob_confidence = v_confidence,
      bob_recommendation = v_reasoning,
      review_state = 'requires_supervisor_review',
      updated_at = clock_timestamp()
  WHERE id = v_assessment.id
  RETURNING * INTO v_assessment;

  v_authority := CASE WHEN v_confidence < 0.5 THEN 'insufficient' ELSE 'candidate' END;
  v_idempotency_key := 'smoke-photo:' || v_assessment.id::text || ':v1:' || v_source_hash;

  SELECT id INTO v_envelope_id
  FROM public.perception_evidence_envelopes
  WHERE organization_id = v_assessment.organization_id
    AND idempotency_key = v_idempotency_key;
  IF FOUND THEN
    PERFORM private.apply_smoke_photo_review_to_perception(v_assessment.id);
    RETURN jsonb_build_object('recorded', 0, 'replayed', 1, 'envelope_id', v_envelope_id);
  END IF;

  INSERT INTO public.perception_evidence_envelopes (
    organization_id, schema_version, domain, source_kind, source_sha256,
    evidence_item_id, source_receipt, model_receipt, derivative_receipts,
    status, idempotency_key
  ) VALUES (
    v_assessment.organization_id, 1, 'smoke_photo', 'image', v_source_hash,
    v_evidence.id,
    jsonb_strip_nulls(jsonb_build_object(
      'smoke_assessment_id', v_assessment.id,
      'evidence_item_id', v_evidence.id,
      'assessed_at', v_assessment.assessed_at,
      'source_location_id', v_assessment.location_id,
      'source_site_id', v_assessment.site_id,
      'complainant_site_id', v_assessment.complainant_site_id,
      'storage_bucket', 'scans',
      'storage_path', v_evidence.storage_path,
      'authoritative_source_preserved', true
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'classifier', coalesce(p_classification->>'classifier', 'bob_vision'),
      'provider', p_classification->'provider',
      'model', p_classification->'model',
      'prompt_version', coalesce(p_classification->>'prompt_version', 'smoke_photo_v1'),
      'machine_legal_decision_permitted', false
    )),
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'evidence_item_id', v_evidence.id,
      'original_path', v_evidence.metadata->>'original_path',
      'watermarked_path', v_evidence.metadata->>'watermarked_path',
      'original_sha256', v_evidence.metadata->>'raw_sha256',
      'watermarked_sha256', v_source_hash,
      'watermark_service', v_evidence.metadata->>'watermark_service'
    ))),
    'manual_review_required',
    v_idempotency_key
  )
  RETURNING id INTO v_envelope_id;

  IF v_source IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      source_locations, consensus_rule, authority_state, review_required
    ) VALUES (
      v_assessment.organization_id, v_envelope_id, 'smoke.source_candidate', 0, 'classification',
      to_jsonb(v_source), lower(v_source),
      jsonb_build_object('source', 'visible_image_classifier', 'legal_decision_permitted', false),
      v_confidence,
      jsonb_build_array(jsonb_build_object('evidence_item_id', v_evidence.id, 'storage_path', v_evidence.storage_path)),
      'advisory_visible_smoke_candidate_human_review_required_v1',
      v_authority,
      true
    );
    v_recorded := v_recorded + 1;
  END IF;

  IF v_severity IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      source_locations, consensus_rule, authority_state, review_required
    ) VALUES (
      v_assessment.organization_id, v_envelope_id, 'smoke.severity_candidate', 0, 'classification',
      to_jsonb(v_severity), lower(v_severity),
      jsonb_build_object('source', 'visible_image_classifier', 'statutory_threshold_permitted', false),
      v_confidence,
      jsonb_build_array(jsonb_build_object('evidence_item_id', v_evidence.id)),
      'advisory_visible_smoke_candidate_human_review_required_v1',
      v_authority,
      true
    );
    v_recorded := v_recorded + 1;
  END IF;

  IF v_visibility IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      source_locations, consensus_rule, authority_state, review_required
    ) VALUES (
      v_assessment.organization_id, v_envelope_id, 'smoke.visibility_impact_candidate', 0, 'text',
      to_jsonb(v_visibility), lower(v_visibility),
      jsonb_build_object('source', 'visible_image_classifier', 'visual_observation_only', true),
      v_confidence,
      jsonb_build_array(jsonb_build_object('evidence_item_id', v_evidence.id)),
      'advisory_visible_smoke_candidate_human_review_required_v1',
      v_authority,
      true
    );
    v_recorded := v_recorded + 1;
  END IF;

  PERFORM private.apply_smoke_photo_review_to_perception(v_assessment.id);
  RETURN jsonb_build_object(
    'recorded', 1,
    'replayed', 0,
    'envelope_id', v_envelope_id,
    'field_candidates', v_recorded
  );
END;
$$;

COMMENT ON FUNCTION public.record_smoke_photo_perception_envelope(uuid, jsonb) IS
  'Service-only replay-safe compiler for advisory smoke photo candidates. Missing custody fails closed and machine output never creates statutory or enforcement authority.';
REVOKE ALL ON FUNCTION public.record_smoke_photo_perception_envelope(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_smoke_photo_perception_envelope(uuid, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.submit_smoke_assessment_receipt_v2(
  p_client_request_id uuid,
  p_assessed_at timestamptz,
  p_smoke_source_type text DEFAULT 'domestic_solid_fuel',
  p_complaint_source text DEFAULT 'neighbour',
  p_severity text DEFAULT 'moderate',
  p_action_taken text DEFAULT 'no_action',
  p_scene_description text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_source_confirmed boolean DEFAULT false,
  p_address text DEFAULT NULL,
  p_complaint_address text DEFAULT NULL,
  p_complainant_site_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_notice_number text DEFAULT NULL,
  p_legal_basis text DEFAULT 'RMA s.17A',
  p_is_out_of_hours boolean DEFAULT false,
  p_follow_up_required boolean DEFAULT false,
  p_shift_id uuid DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_evidence_items jsonb DEFAULT '[]'::jsonb,
  p_classification jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  created boolean,
  received_at timestamptz,
  evidence_state text,
  review_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_receipt record;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF coalesce(p_source_confirmed, false) IS FALSE THEN
    RAISE EXCEPTION 'Officer must confirm the observed smoke source';
  END IF;
  IF p_severity NOT IN ('low', 'moderate', 'high', 'critical') THEN
    RAISE EXCEPTION 'Unsupported smoke severity';
  END IF;

  SELECT * INTO v_receipt
  FROM public.submit_smoke_assessment_receipt(
    p_client_request_id => p_client_request_id,
    p_assessed_at => p_assessed_at,
    p_smoke_source_type => p_smoke_source_type,
    p_complaint_source => p_complaint_source,
    p_severity => p_severity,
    p_action_taken => p_action_taken,
    p_scene_description => p_scene_description,
    p_address => p_address,
    p_complaint_address => p_complaint_address,
    p_complainant_site_id => p_complainant_site_id,
    p_site_id => p_site_id,
    p_notice_number => p_notice_number,
    p_legal_basis => p_legal_basis,
    p_is_out_of_hours => p_is_out_of_hours,
    p_follow_up_required => p_follow_up_required,
    p_shift_id => p_shift_id,
    p_dispatch_job_id => p_dispatch_job_id,
    p_evidence_items => p_evidence_items,
    p_classification => p_classification
  );

  UPDATE public.smoke_assessments
  SET source_confirmed = true,
      notes = nullif(trim(coalesce(p_notes, '')), ''),
      smoke_ai_analysis = p_classification,
      smoke_ai_analyzed_at = CASE
        WHEN p_classification->>'status' = 'available' THEN clock_timestamp()
        ELSE smoke_ai_analyzed_at
      END,
      review_state = 'requires_supervisor_review',
      updated_at = clock_timestamp()
  WHERE smoke_assessments.id = v_receipt.id;

  RETURN QUERY
  SELECT v_receipt.id, v_receipt.created, v_receipt.received_at,
         v_receipt.evidence_state, 'requires_supervisor_review'::text;
END;
$$;

COMMENT ON FUNCTION public.submit_smoke_assessment_receipt_v2(
  uuid,timestamptz,text,text,text,text,text,text,boolean,text,text,uuid,uuid,text,text,boolean,boolean,uuid,uuid,jsonb,jsonb
) IS
  'Caller-context smoke receipt preserving human source confirmation, notes, and structured advisory classification without changing legal authority.';
REVOKE ALL ON FUNCTION public.submit_smoke_assessment_receipt_v2(
  uuid,timestamptz,text,text,text,text,text,text,boolean,text,text,uuid,uuid,text,text,boolean,boolean,uuid,uuid,jsonb,jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_smoke_assessment_receipt_v2(
  uuid,timestamptz,text,text,text,text,text,text,boolean,text,text,uuid,uuid,text,text,boolean,boolean,uuid,uuid,jsonb,jsonb
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.review_smoke_photo_classification(
  p_assessment_id uuid,
  p_action text,
  p_smoke_source_type text,
  p_severity text,
  p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_assessment public.smoke_assessments%ROWTYPE;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_notes text := nullif(trim(coalesce(p_notes, '')), '');
  v_source text := nullif(trim(coalesce(p_smoke_source_type, '')), '');
  v_severity text := nullif(trim(coalesce(p_severity, '')), '');
BEGIN
  SELECT * INTO v_assessment
  FROM public.smoke_assessments
  WHERE id = p_assessment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Smoke assessment is missing'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_assessment.organization_id) THEN
    RAISE EXCEPTION 'Active Smoke Control administrator required';
  END IF;
  IF v_action NOT IN ('confirm', 'correct', 'reject') THEN
    RAISE EXCEPTION 'Unsupported smoke photo review action';
  END IF;
  IF v_notes IS NULL THEN RAISE EXCEPTION 'Review notes are required'; END IF;
  IF jsonb_typeof(v_assessment.smoke_ai_analysis) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'This assessment has no structured photo classification to review';
  END IF;
  IF v_action IN ('confirm', 'correct')
     AND coalesce(v_assessment.smoke_ai_analysis->>'status', 'unavailable') <> 'available' THEN
    RAISE EXCEPTION 'An unavailable machine classification cannot be approved';
  END IF;
  IF v_action IN ('confirm', 'correct')
     AND v_source NOT IN (
       'domestic_solid_fuel', 'industrial', 'vehicle_exhaust',
       'agricultural', 'nuisance_burning', 'unknown'
     ) THEN
    RAISE EXCEPTION 'A supported canonical smoke source is required';
  END IF;
  IF v_action IN ('confirm', 'correct')
     AND v_severity NOT IN ('low', 'moderate', 'high', 'critical') THEN
    RAISE EXCEPTION 'A supported canonical severity is required';
  END IF;

  UPDATE public.smoke_assessments
  SET smoke_source_type = CASE WHEN v_action IN ('confirm', 'correct') THEN v_source ELSE smoke_source_type END,
      smoke_source = CASE WHEN v_action IN ('confirm', 'correct') THEN v_source ELSE smoke_source END,
      severity = CASE WHEN v_action IN ('confirm', 'correct') THEN v_severity ELSE severity END,
      source_confirmed = CASE WHEN v_action IN ('confirm', 'correct') THEN true ELSE source_confirmed END,
      smoke_ai_review = jsonb_strip_nulls(jsonb_build_object(
        'action', v_action,
        'smoke_source_type', CASE WHEN v_action IN ('confirm', 'correct') THEN v_source END,
        'severity', CASE WHEN v_action IN ('confirm', 'correct') THEN v_severity END,
        'notes', v_notes,
        'reviewed_by', v_actor,
        'reviewed_at', clock_timestamp()
      )),
      updated_at = clock_timestamp()
  WHERE id = v_assessment.id
  RETURNING * INTO v_assessment;

  PERFORM private.apply_smoke_photo_review_to_perception(v_assessment.id);

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_assessment.organization_id, v_actor, 'smoke_photo_classification_reviewed',
    'smoke_assessments', v_assessment.id,
    jsonb_build_object(
      'review_action', v_action,
      'smoke_source_type', v_source,
      'severity', v_severity,
      'legal_action_changed', false,
      'notice_changed', false,
      'notes', v_notes
    )
  );

  RETURN jsonb_build_object(
    'assessment_id', v_assessment.id,
    'action', v_action,
    'smoke_source_type', v_assessment.smoke_source_type,
    'severity', v_assessment.severity,
    'reviewed_by', v_actor,
    'reviewed_at', v_assessment.smoke_ai_review->>'reviewed_at'
  );
END;
$$;

COMMENT ON FUNCTION public.review_smoke_photo_classification(uuid,text,text,text,text) IS
  'Administrator-only field review for advisory smoke photo candidates. It never changes legal action, notice number, legal basis, or workflow closure.';
REVOKE ALL ON FUNCTION public.review_smoke_photo_classification(uuid,text,text,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_smoke_photo_classification(uuid,text,text,text,text)
  TO authenticated, service_role;