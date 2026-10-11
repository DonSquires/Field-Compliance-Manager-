ALTER TABLE public.biosecurity_assessments
  ADD COLUMN IF NOT EXISTS biosecurity_ai_analysis jsonb,
  ADD COLUMN IF NOT EXISTS biosecurity_ai_review jsonb;

COMMENT ON COLUMN public.biosecurity_assessments.biosecurity_ai_analysis IS
  'Structured advisory image-classification receipt. It is never species confirmation or enforcement authority.';
COMMENT ON COLUMN public.biosecurity_assessments.biosecurity_ai_review IS
  'Attributable human confirmation, correction or rejection of the advisory image-classification fields.';

CREATE INDEX perception_evidence_envelopes_biosecurity_photo_assessment_idx
  ON public.perception_evidence_envelopes ((source_receipt->>'biosecurity_assessment_id'))
  WHERE domain = 'biosecurity_photo';

CREATE OR REPLACE FUNCTION public.apply_biosecurity_photo_review_to_perception(p_assessment_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_assessment public.biosecurity_assessments%rowtype;
  v_envelope public.perception_evidence_envelopes%rowtype;
  v_field public.perception_evidence_fields%rowtype;
  v_review jsonb;
  v_actor uuid;
  v_short_key text;
  v_value_key text;
  v_final_value text;
  v_target_authority text;
  v_decision text;
  v_correction_field_id uuid;
BEGIN
  SELECT * INTO v_assessment
  FROM public.biosecurity_assessments
  WHERE id = p_assessment_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_review := v_assessment.biosecurity_ai_review;
  IF jsonb_typeof(v_review) IS DISTINCT FROM 'object'
     OR v_review->>'status' NOT IN ('confirmed','corrected','rejected') THEN
    RETURN;
  END IF;
  v_actor := nullif(v_review->>'reviewed_by', '')::uuid;
  IF v_actor IS NULL THEN RETURN; END IF;

  FOR v_envelope IN
    SELECT e.*
    FROM public.perception_evidence_envelopes e
    WHERE e.organization_id = v_assessment.organization_id
      AND e.domain = 'biosecurity_photo'
      AND e.source_receipt->>'biosecurity_assessment_id' = v_assessment.id::text
  LOOP
    FOR v_field IN
      SELECT f.*
      FROM public.perception_evidence_fields f
      WHERE f.envelope_id = v_envelope.id
      ORDER BY f.field_key, f.candidate_ordinal
    LOOP
      v_short_key := replace(replace(v_field.field_key, 'biosecurity.', ''), '_candidate', '');
      v_value_key := CASE v_short_key
        WHEN 'species' THEN 'species_name'
        WHEN 'density' THEN 'density_estimate'
        WHEN 'threat_level' THEN 'threat_level'
        ELSE v_short_key
      END;
      IF NOT coalesce(v_review->'reviewed_fields', '[]'::jsonb) ? v_value_key THEN
        CONTINUE;
      END IF;

      v_final_value := coalesce(v_review#>>ARRAY['values', v_value_key], v_field.candidate_value);
      v_target_authority := CASE
        WHEN v_review->>'status' = 'rejected' THEN 'rejected'
        WHEN lower(coalesce(v_field.normalized_value, v_field.candidate_value)) = lower(v_final_value)
          THEN 'human_approved'
        ELSE 'superseded'
      END;
      v_decision := CASE
        WHEN v_target_authority = 'rejected' THEN 'reject'
        WHEN v_target_authority = 'superseded' THEN 'supersede'
        ELSE 'approve'
      END;

      IF v_field.authority_state IS DISTINCT FROM v_target_authority OR v_field.review_required THEN
        INSERT INTO public.perception_evidence_reviews (
          organization_id, field_id, previous_authority_state, decision,
          next_authority_state, reviewer_notes, canonical_reference, decided_by
        ) VALUES (
          v_assessment.organization_id, v_field.id, v_field.authority_state, v_decision,
          v_target_authority, nullif(trim(v_review->>'notes'), ''),
          jsonb_strip_nulls(jsonb_build_object(
            'biosecurity_assessment_id', v_assessment.id,
            'field', v_value_key,
            'final_value', v_final_value,
            'review_status', v_review->>'status'
          )),
          v_actor
        );
        UPDATE public.perception_evidence_fields
        SET authority_state = v_target_authority,
            review_required = false,
            updated_at = clock_timestamp()
        WHERE id = v_field.id;
      END IF;

      IF v_target_authority = 'superseded' AND v_final_value IS NOT NULL THEN
        INSERT INTO public.perception_evidence_fields (
          organization_id, envelope_id, field_key, candidate_ordinal, value_type,
          candidate_value, normalized_value, candidate_payload, source_locations,
          consensus_rule, authority_state, review_required
        ) VALUES (
          v_assessment.organization_id, v_envelope.id, v_field.field_key, 1, v_field.value_type,
          v_final_value, lower(trim(v_final_value)),
          jsonb_build_object('human_correction', true),
          jsonb_build_array(jsonb_build_object('biosecurity_assessment_id', v_assessment.id)),
          'explicit_human_biosecurity_correction_v1', 'candidate', true
        )
        ON CONFLICT (envelope_id, field_key, candidate_ordinal) DO UPDATE
        SET candidate_value = EXCLUDED.candidate_value,
            normalized_value = EXCLUDED.normalized_value,
            candidate_payload = EXCLUDED.candidate_payload,
            updated_at = clock_timestamp()
        RETURNING id INTO v_correction_field_id;

        INSERT INTO public.perception_evidence_reviews (
          organization_id, field_id, previous_authority_state, decision,
          next_authority_state, reviewer_notes, canonical_reference, decided_by
        ) VALUES (
          v_assessment.organization_id, v_correction_field_id, 'candidate', 'correct',
          'human_approved', nullif(trim(v_review->>'notes'), ''),
          jsonb_strip_nulls(jsonb_build_object(
            'biosecurity_assessment_id', v_assessment.id,
            'field', v_value_key,
            'final_value', v_final_value,
            'review_status', v_review->>'status'
          )),
          v_actor
        );
        UPDATE public.perception_evidence_fields
        SET authority_state = 'human_approved',
            review_required = false,
            updated_at = clock_timestamp()
        WHERE id = v_correction_field_id;
      END IF;
    END LOOP;

    UPDATE public.perception_evidence_envelopes e
    SET status = CASE
          WHEN EXISTS (
            SELECT 1
            FROM public.perception_evidence_fields f
            WHERE f.envelope_id = e.id
              AND f.review_required
          ) THEN 'manual_review_required'
          ELSE 'complete'
        END,
        updated_at = clock_timestamp()
    WHERE e.id = v_envelope.id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.apply_biosecurity_photo_review_to_perception(uuid) IS
  'Internal projection of the dedicated human biosecurity classification decision into shared field authority.';
REVOKE ALL ON FUNCTION public.apply_biosecurity_photo_review_to_perception(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_biosecurity_photo_perception_envelope(
  p_assessment_id uuid,
  p_classification jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_assessment public.biosecurity_assessments%rowtype;
  v_link public.biosecurity_assessment_evidence%rowtype;
  v_evidence public.evidence_items%rowtype;
  v_source_hash text;
  v_classification text;
  v_species text;
  v_density text;
  v_threat_level text;
  v_reasoning text;
  v_confidence real;
  v_authority text;
  v_conflicts jsonb := '[]'::jsonb;
  v_envelope_id uuid;
  v_idempotency_key text;
  v_field_count integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF jsonb_typeof(p_classification) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Structured biosecurity classification is required';
  END IF;

  SELECT * INTO v_assessment
  FROM public.biosecurity_assessments
  WHERE id = p_assessment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Biosecurity assessment is missing'; END IF;

  SELECT link.* INTO v_link
  FROM public.biosecurity_assessment_evidence link
  WHERE link.biosecurity_assessment_id = v_assessment.id
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
  IF v_source_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_source_hash');
  END IF;
  IF coalesce(p_classification->>'status', 'unavailable') <> 'available' THEN
    UPDATE public.biosecurity_assessments
    SET biosecurity_ai_analysis = p_classification,
        review_state = 'requires_supervisor_review',
        updated_at = clock_timestamp()
    WHERE id = v_assessment.id;
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'classification_unavailable');
  END IF;

  v_classification := nullif(trim(p_classification->>'classification'), '');
  v_species := nullif(trim(coalesce(
    p_classification#>>'{details,species_name}',
    v_classification
  )), '');
  v_density := nullif(trim(p_classification#>>'{details,density}'), '');
  v_threat_level := nullif(trim(p_classification#>>'{details,threat_level}'), '');
  v_reasoning := nullif(trim(p_classification->>'reasoning'), '');
  v_confidence := CASE
    WHEN p_classification->>'confidence' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (p_classification->>'confidence')::real
  END;

  IF v_species IS NULL OR lower(v_species) = 'unknown' THEN
    UPDATE public.biosecurity_assessments
    SET biosecurity_ai_analysis = p_classification,
        review_state = 'requires_supervisor_review',
        updated_at = clock_timestamp()
    WHERE id = v_assessment.id;
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'no_species_candidate');
  END IF;
  IF v_confidence IS NULL OR v_confidence < 0 OR v_confidence > 1 THEN
    RAISE EXCEPTION 'Biosecurity classification confidence is invalid';
  END IF;

  UPDATE public.evidence_items
  SET sha256_hash = coalesce(sha256_hash, v_source_hash)
  WHERE id = v_evidence.id;

  UPDATE public.biosecurity_assessments
  SET biosecurity_ai_analysis = p_classification,
      bob_classification = v_classification,
      bob_confidence = v_confidence,
      bob_species_id = v_species,
      bob_species_confirmed = false,
      bob_recommendation = v_reasoning,
      review_state = 'requires_supervisor_review',
      updated_at = clock_timestamp()
  WHERE id = v_assessment.id
  RETURNING * INTO v_assessment;

  IF nullif(trim(v_assessment.species_name), '') IS NOT NULL
     AND lower(trim(v_assessment.species_name)) <> lower(v_species) THEN
    v_conflicts := jsonb_build_array(jsonb_build_object(
      'source', 'officer_submission',
      'candidate', v_assessment.species_name,
      'reason', 'differs_from_photo_classifier'
    ));
  END IF;
  v_authority := CASE WHEN v_confidence < 0.5 THEN 'insufficient' ELSE 'candidate' END;
  v_idempotency_key := 'biosecurity-photo:' || v_assessment.id::text || ':v1:' || v_source_hash;

  SELECT id INTO v_envelope_id
  FROM public.perception_evidence_envelopes
  WHERE organization_id = v_assessment.organization_id
    AND idempotency_key = v_idempotency_key;
  IF FOUND THEN
    PERFORM public.apply_biosecurity_photo_review_to_perception(v_assessment.id);
    RETURN jsonb_build_object('recorded', 0, 'replayed', 1, 'envelope_id', v_envelope_id);
  END IF;

  INSERT INTO public.perception_evidence_envelopes (
    organization_id, schema_version, domain, source_kind, source_sha256,
    evidence_item_id, source_receipt, model_receipt, derivative_receipts,
    status, idempotency_key
  ) VALUES (
    v_assessment.organization_id, 1, 'biosecurity_photo', 'image', v_source_hash,
    v_evidence.id,
    jsonb_strip_nulls(jsonb_build_object(
      'biosecurity_assessment_id', v_assessment.id,
      'evidence_item_id', v_evidence.id,
      'assessed_at', v_assessment.assessed_at,
      'source_location_id', v_assessment.location_id,
      'source_site_id', v_assessment.site_id,
      'protected_land_site_id', v_assessment.protected_land_site_id,
      'storage_bucket', 'scans',
      'storage_path', v_evidence.storage_path,
      'authoritative_source_preserved', true
    )),
    jsonb_strip_nulls(jsonb_build_object(
      'classifier', coalesce(p_classification->>'classifier', 'bob_vision'),
      'provider', p_classification->'provider',
      'model', p_classification->'model',
      'prompt_version', coalesce(p_classification->>'prompt_version', 'biosecurity_photo_v1'),
      'machine_confirmation_permitted', false
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

  INSERT INTO public.perception_evidence_fields (
    organization_id, envelope_id, field_key, candidate_ordinal, value_type,
    candidate_value, normalized_value, candidate_payload, raw_confidence,
    source_locations, consensus_rule, conflicts, authority_state, review_required
  ) VALUES (
    v_assessment.organization_id, v_envelope_id, 'biosecurity.species_candidate', 0, 'classification',
    v_species, lower(v_species),
    jsonb_strip_nulls(jsonb_build_object(
      'common_name', p_classification#>'{details,common_name}',
      'reasoning', v_reasoning,
      'officer_recorded_species', v_assessment.species_name,
      'legal_or_enforcement_authority', false
    )),
    v_confidence,
    jsonb_build_array(jsonb_build_object(
      'evidence_item_id', v_evidence.id,
      'storage_path', v_evidence.storage_path
    )),
    'advisory_biosecurity_photo_candidate_human_review_required_v1',
    v_conflicts, v_authority, true
  );
  v_field_count := v_field_count + 1;

  IF v_density IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      source_locations, consensus_rule, authority_state, review_required
    ) VALUES (
      v_assessment.organization_id, v_envelope_id, 'biosecurity.density_candidate', 0, 'classification',
      v_density, lower(v_density),
      jsonb_build_object('legal_or_enforcement_authority', false),
      v_confidence,
      jsonb_build_array(jsonb_build_object('evidence_item_id', v_evidence.id)),
      'advisory_biosecurity_photo_candidate_human_review_required_v1',
      v_authority, true
    );
    v_field_count := v_field_count + 1;
  END IF;

  IF v_threat_level IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      source_locations, consensus_rule, authority_state, review_required
    ) VALUES (
      v_assessment.organization_id, v_envelope_id, 'biosecurity.threat_level_candidate', 0, 'classification',
      v_threat_level, lower(v_threat_level),
      jsonb_build_object('legal_or_enforcement_authority', false),
      v_confidence,
      jsonb_build_array(jsonb_build_object('evidence_item_id', v_evidence.id)),
      'advisory_biosecurity_photo_candidate_human_review_required_v1',
      v_authority, true
    );
    v_field_count := v_field_count + 1;
  END IF;

  PERFORM public.apply_biosecurity_photo_review_to_perception(v_assessment.id);
  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_assessment.organization_id, NULL, 'biosecurity_photo_perception_recorded',
    'perception_evidence_envelopes', v_envelope_id,
    jsonb_build_object(
      'biosecurity_assessment_id', v_assessment.id,
      'evidence_item_id', v_evidence.id,
      'field_count', v_field_count,
      'machine_confirmation_permitted', false
    )
  );

  RETURN jsonb_build_object(
    'recorded', 1,
    'replayed', 0,
    'envelope_id', v_envelope_id,
    'field_count', v_field_count
  );
END;
$$;

COMMENT ON FUNCTION public.record_biosecurity_photo_perception_envelope(uuid, jsonb) IS
  'Service-only replay-safe compiler for advisory biosecurity photo classification. It stores custody and candidates but never confirms species or enforcement action.';
REVOKE ALL ON FUNCTION public.record_biosecurity_photo_perception_envelope(uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_biosecurity_photo_perception_envelope(uuid, jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.review_biosecurity_photo_classification(
  p_assessment_id uuid,
  p_action text,
  p_species_name text DEFAULT NULL,
  p_density_estimate text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_request_id text DEFAULT NULL
)
RETURNS public.biosecurity_assessments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_assessment public.biosecurity_assessments%rowtype;
  v_actor uuid := auth.uid();
  v_action text := lower(trim(coalesce(p_action, '')));
  v_analysis jsonb;
  v_candidate_species text;
  v_candidate_density text;
  v_candidate_threat text;
  v_final_species text;
  v_final_density text;
  v_reviewed_fields jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_action NOT IN ('confirm','correct','reject') THEN
    RAISE EXCEPTION 'Action must be confirm, correct, or reject';
  END IF;

  SELECT * INTO v_assessment
  FROM public.biosecurity_assessments
  WHERE id = p_assessment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Biosecurity assessment not found'; END IF;
  IF NOT public.is_admin_for_org(v_assessment.organization_id) THEN
    RAISE EXCEPTION 'Active Biosecurity administrator required';
  END IF;
  IF nullif(trim(coalesce(p_request_id, '')), '') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.audit_log
       WHERE organization_id = v_assessment.organization_id
         AND action = 'biosecurity_photo_classification_reviewed'
         AND metadata->>'request_id' = trim(p_request_id)
     ) THEN
    RETURN v_assessment;
  END IF;

  v_analysis := v_assessment.biosecurity_ai_analysis;
  IF jsonb_typeof(v_analysis) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'This assessment has no structured photo classification to review';
  END IF;
  v_candidate_species := nullif(trim(coalesce(
    v_analysis#>>'{details,species_name}',
    v_analysis->>'classification'
  )), '');
  v_candidate_density := nullif(trim(v_analysis#>>'{details,density}'), '');
  v_candidate_threat := nullif(trim(v_analysis#>>'{details,threat_level}'), '');

  IF v_action = 'correct'
     AND nullif(trim(coalesce(p_species_name, '')), '') IS NULL
     AND nullif(trim(coalesce(p_density_estimate, '')), '') IS NULL THEN
    RAISE EXCEPTION 'A correction requires a species or density value';
  END IF;
  IF v_action = 'confirm'
     AND coalesce(v_analysis->>'status', 'unavailable') <> 'available' THEN
    RAISE EXCEPTION 'An unavailable machine classification cannot be confirmed';
  END IF;
  IF nullif(trim(coalesce(p_density_estimate, '')), '') IS NOT NULL
     AND lower(trim(p_density_estimate)) NOT IN ('isolated','scattered','moderate','dense','severe','not_found') THEN
    RAISE EXCEPTION 'Density estimate is not supported';
  END IF;
  v_final_species := CASE
    WHEN v_action = 'correct' THEN coalesce(nullif(trim(p_species_name), ''), v_candidate_species)
    WHEN v_action = 'confirm' THEN v_candidate_species
  END;
  v_final_density := CASE
    WHEN v_action = 'correct' THEN coalesce(nullif(trim(p_density_estimate), ''), v_candidate_density)
    WHEN v_action = 'confirm' THEN v_candidate_density
  END;
  IF v_action IN ('confirm','correct') AND v_final_species IS NULL THEN
    RAISE EXCEPTION 'A species candidate is required before approval';
  END IF;
  IF v_final_species IS NOT NULL THEN
    v_reviewed_fields := v_reviewed_fields || jsonb_build_array('species_name');
  END IF;
  IF v_final_density IS NOT NULL THEN
    v_reviewed_fields := v_reviewed_fields || jsonb_build_array('density_estimate');
  END IF;
  IF v_candidate_threat IS NOT NULL THEN
    v_reviewed_fields := v_reviewed_fields || jsonb_build_array('threat_level');
  END IF;

  UPDATE public.biosecurity_assessments
  SET species_name = CASE WHEN v_action IN ('confirm','correct') THEN v_final_species ELSE species_name END,
      species_identified = CASE WHEN v_action IN ('confirm','correct') THEN v_final_species ELSE species_identified END,
      confirmed_species_name = CASE WHEN v_action IN ('confirm','correct') THEN v_final_species ELSE NULL END,
      density_estimate = CASE WHEN v_action IN ('confirm','correct') THEN coalesce(v_final_density, density_estimate) ELSE density_estimate END,
      bob_species_confirmed = v_action IN ('confirm','correct'),
      species_confirmed = v_action IN ('confirm','correct'),
      species_review_decision = CASE WHEN v_action IN ('confirm','correct') THEN 'confirmed' ELSE 'rejected' END,
      biosecurity_ai_review = jsonb_strip_nulls(jsonb_build_object(
        'status', CASE v_action
          WHEN 'confirm' THEN 'confirmed'
          WHEN 'correct' THEN 'corrected'
          ELSE 'rejected'
        END,
        'reviewed_at', clock_timestamp(),
        'reviewed_by', v_actor,
        'notes', nullif(trim(p_notes), ''),
        'reviewed_fields', CASE
          WHEN v_action = 'reject'
            THEN jsonb_build_array('species_name','density_estimate','threat_level')
          ELSE v_reviewed_fields
        END,
        'values', CASE WHEN v_action = 'reject' THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
          'species_name', v_final_species,
          'density_estimate', v_final_density,
          'threat_level', v_candidate_threat
        )) END
      )),
      updated_at = clock_timestamp()
  WHERE id = v_assessment.id
  RETURNING * INTO v_assessment;

  PERFORM public.apply_biosecurity_photo_review_to_perception(v_assessment.id);
  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_assessment.organization_id, v_actor, 'biosecurity_photo_classification_reviewed',
    'biosecurity_assessments', v_assessment.id,
    jsonb_strip_nulls(jsonb_build_object(
      'request_id', nullif(trim(p_request_id), ''),
      'review_action', v_action,
      'reviewed_fields', CASE
        WHEN v_action = 'reject'
          THEN jsonb_build_array('species_name','density_estimate','threat_level')
        ELSE v_reviewed_fields
      END,
      'values', v_assessment.biosecurity_ai_review->'values',
      'legal_or_enforcement_decision', false
    ))
  );
  RETURN v_assessment;
END;
$$;

COMMENT ON FUNCTION public.review_biosecurity_photo_classification(uuid, text, text, text, text, text) IS
  'Admin confirmation, correction or rejection of advisory biosecurity photo fields. It cannot create a notice, referral or enforcement action.';
REVOKE ALL ON FUNCTION public.review_biosecurity_photo_classification(uuid, text, text, text, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_biosecurity_photo_classification(uuid, text, text, text, text, text)
  TO authenticated, service_role;