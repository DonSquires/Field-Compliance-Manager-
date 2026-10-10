CREATE INDEX perception_evidence_envelopes_cctv_person_observation_idx
  ON public.perception_evidence_envelopes ((source_receipt->>'cctv_entity_observation_id'))
  WHERE domain = 'cctv_person';

CREATE OR REPLACE FUNCTION public.apply_cctv_person_review_to_perception(p_observation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_observation public.cctv_entity_observations%rowtype;
  v_envelope public.perception_evidence_envelopes%rowtype;
  v_field public.perception_evidence_fields%rowtype;
  v_target_authority text;
  v_decision text;
  v_review_required boolean;
  v_identity_value text;
BEGIN
  SELECT * INTO v_observation
  FROM public.cctv_entity_observations
  WHERE id = p_observation_id;
  IF NOT FOUND OR v_observation.entity_kind <> 'person' THEN
    RETURN;
  END IF;

  FOR v_envelope IN
    SELECT e.*
    FROM public.perception_evidence_envelopes e
    WHERE e.organization_id = v_observation.organization_id
      AND e.domain = 'cctv_person'
      AND e.source_receipt->>'cctv_entity_observation_id' = v_observation.id::text
  LOOP
    IF v_observation.review_state = 'superseded' THEN
      UPDATE public.perception_evidence_fields
      SET authority_state = 'superseded',
          review_required = false,
          updated_at = clock_timestamp()
      WHERE envelope_id = v_envelope.id;
      UPDATE public.perception_evidence_envelopes
      SET status = 'superseded',
          updated_at = clock_timestamp()
      WHERE id = v_envelope.id;
      CONTINUE;
    END IF;

    IF v_observation.review_state NOT IN ('accepted', 'rejected') THEN
      CONTINUE;
    END IF;
    IF v_observation.reviewed_by IS NULL THEN
      RAISE EXCEPTION 'CCTV person review state % requires an attributable reviewer', v_observation.review_state;
    END IF;

    IF v_observation.review_state = 'accepted'
       AND v_observation.portfolio_state IN ('linked', 'new_identity')
       AND (v_observation.canonical_person_id IS NOT NULL OR v_observation.person_record_id IS NOT NULL) THEN
      v_identity_value := coalesce(v_observation.canonical_person_id, v_observation.person_record_id)::text;
      INSERT INTO public.perception_evidence_fields (
        organization_id, envelope_id, field_key, candidate_ordinal, value_type,
        candidate_value, normalized_value, candidate_payload, source_locations,
        consensus_rule, authority_state, review_required
      ) VALUES (
        v_observation.organization_id, v_envelope.id, 'person.identity_reference', 0, 'entity',
        v_identity_value, v_identity_value,
        jsonb_strip_nulls(jsonb_build_object(
          'person_record_id', v_observation.person_record_id,
          'canonical_person_id', v_observation.canonical_person_id,
          'identity_basis', v_observation.portfolio_state
        )),
        jsonb_build_array(jsonb_build_object(
          'cctv_entity_observation_id', v_observation.id,
          'source_event_id', v_observation.source_event_id
        )),
        'explicit_human_cctv_identity_link_v1', 'candidate', true
      )
      ON CONFLICT (envelope_id, field_key, candidate_ordinal) DO UPDATE
      SET candidate_value = EXCLUDED.candidate_value,
          normalized_value = EXCLUDED.normalized_value,
          candidate_payload = EXCLUDED.candidate_payload,
          updated_at = clock_timestamp()
      WHERE public.perception_evidence_fields.authority_state <> 'human_approved';
    END IF;

    FOR v_field IN
      SELECT f.*
      FROM public.perception_evidence_fields f
      WHERE f.envelope_id = v_envelope.id
      ORDER BY f.field_key, f.candidate_ordinal
    LOOP
      v_target_authority := NULL;
      v_decision := NULL;
      v_review_required := v_field.review_required;

      IF v_observation.review_state = 'rejected' THEN
        v_target_authority := 'rejected';
        v_decision := 'reject';
        v_review_required := false;
      ELSIF v_field.field_key IN ('person.presence', 'person.face_detected', 'person.identity_reference') THEN
        v_target_authority := 'human_approved';
        v_decision := 'approve';
        v_review_required := false;
      ELSIF v_field.field_key = 'person.portfolio_candidate'
            AND v_observation.portfolio_state IN ('linked', 'new_identity') THEN
        v_target_authority := 'superseded';
        v_decision := 'supersede';
        v_review_required := false;
      END IF;

      IF v_target_authority IS NULL
         OR (v_field.authority_state = v_target_authority AND v_field.review_required = v_review_required) THEN
        CONTINUE;
      END IF;

      INSERT INTO public.perception_evidence_reviews (
        organization_id, field_id, previous_authority_state, decision,
        next_authority_state, reviewer_notes, canonical_reference, decided_by
      ) VALUES (
        v_observation.organization_id, v_field.id, v_field.authority_state, v_decision,
        v_target_authority, nullif(trim(v_observation.review_notes), ''),
        jsonb_strip_nulls(jsonb_build_object(
          'cctv_entity_observation_id', v_observation.id,
          'person_record_id', v_observation.person_record_id,
          'canonical_person_id', v_observation.canonical_person_id,
          'portfolio_state', v_observation.portfolio_state,
          'review_state', v_observation.review_state
        )),
        v_observation.reviewed_by
      );

      UPDATE public.perception_evidence_fields
      SET authority_state = v_target_authority,
          review_required = v_review_required,
          updated_at = clock_timestamp()
      WHERE id = v_field.id;
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

COMMENT ON FUNCTION public.apply_cctv_person_review_to_perception(uuid) IS
  'Internal projection of the existing CCTV person-observation decision into shared perception authority. It never reads or copies biometric templates.';
REVOKE ALL ON FUNCTION public.apply_cctv_person_review_to_perception(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_cctv_person_perception_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.entity_kind = 'person'
     AND (
       NEW.review_state IS DISTINCT FROM OLD.review_state
       OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.person_record_id IS DISTINCT FROM OLD.person_record_id
       OR NEW.canonical_person_id IS DISTINCT FROM OLD.canonical_person_id
       OR NEW.portfolio_state IS DISTINCT FROM OLD.portfolio_state
     ) THEN
    PERFORM public.apply_cctv_person_review_to_perception(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_cctv_person_perception_review() IS
  'Keeps shared CCTV person receipts aligned to the single existing human observation-review authority.';
REVOKE ALL ON FUNCTION public.sync_cctv_person_perception_review()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS sync_cctv_person_perception_review_trigger ON public.cctv_entity_observations;
CREATE TRIGGER sync_cctv_person_perception_review_trigger
AFTER UPDATE OF review_state, reviewed_by, person_record_id, canonical_person_id, portfolio_state
ON public.cctv_entity_observations
FOR EACH ROW
EXECUTE FUNCTION public.sync_cctv_person_perception_review();

CREATE OR REPLACE FUNCTION public.record_cctv_person_perception_envelopes(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_job public.inference_jobs%rowtype;
  v_evidence public.evidence_items%rowtype;
  v_observation public.cctv_entity_observations%rowtype;
  v_derivative public.cctv_observation_derivatives%rowtype;
  v_envelope_id uuid;
  v_idempotency_key text;
  v_initial_authority text;
  v_face_present boolean;
  v_candidate_count integer;
  v_top_similarity real;
  v_recorded integer := 0;
  v_replayed integer := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO v_job FROM public.inference_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inference job is missing'; END IF;

  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = v_job.evidence_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evidence item is missing'; END IF;
  IF v_evidence.organization_id <> v_job.organization_id THEN
    RAISE EXCEPTION 'Evidence and inference job organization mismatch';
  END IF;
  IF lower(coalesce(v_evidence.sha256_hash, '')) !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'CCTV source custody SHA-256 is required before person evidence can be recorded';
  END IF;

  FOR v_observation IN
    SELECT o.*
    FROM public.cctv_entity_observations o
    WHERE o.inference_job_id = p_job_id
      AND o.organization_id = v_job.organization_id
      AND o.entity_kind = 'person'
      AND o.review_state <> 'superseded'
    ORDER BY o.observed_at, o.id
  LOOP
    v_idempotency_key := 'cctv-person:' || v_observation.id::text || ':v1:' || lower(v_evidence.sha256_hash);
    SELECT id INTO v_envelope_id
    FROM public.perception_evidence_envelopes
    WHERE organization_id = v_job.organization_id
      AND idempotency_key = v_idempotency_key;
    IF FOUND THEN
      v_replayed := v_replayed + 1;
      CONTINUE;
    END IF;

    SELECT d.* INTO v_derivative
    FROM public.cctv_observation_derivatives d
    WHERE d.observation_id = v_observation.id
    ORDER BY d.created_at DESC
    LIMIT 1;

    v_initial_authority := CASE
      WHEN v_observation.quality_state IN ('glitch', 'flare', 'ir_switch', 'degraded', 'occluded')
        THEN 'insufficient'
      ELSE 'candidate'
    END;
    v_face_present := coalesce((v_observation.attributes->>'face_detected')::boolean, false)
      OR v_observation.attributes ? 'face_event_id'
      OR coalesce((v_observation.attributes->>'face_only')::boolean, false);
    v_candidate_count := CASE
      WHEN jsonb_typeof(v_observation.portfolio_candidates) = 'array'
        THEN jsonb_array_length(v_observation.portfolio_candidates)
      ELSE 0
    END;
    SELECT max(
      CASE WHEN candidate.value->>'score' ~ '^[0-9]+([.][0-9]+)?$'
        THEN (candidate.value->>'score')::real END
    )
    INTO v_top_similarity
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(v_observation.portfolio_candidates) = 'array'
        THEN v_observation.portfolio_candidates ELSE '[]'::jsonb END
    ) AS candidate(value);

    INSERT INTO public.perception_evidence_envelopes (
      organization_id, schema_version, domain, source_kind, source_sha256,
      evidence_item_id, inference_job_id, source_receipt, model_receipt,
      derivative_receipts, status, idempotency_key
    ) VALUES (
      v_job.organization_id, 1, 'cctv_person',
      CASE WHEN v_evidence.evidence_kind IN ('photo', 'image') THEN 'image' ELSE 'video' END,
      lower(v_evidence.sha256_hash), v_evidence.id, v_job.id,
      jsonb_strip_nulls(jsonb_build_object(
        'cctv_entity_observation_id', v_observation.id,
        'source_event_id', v_observation.source_event_id,
        'observed_at', v_observation.observed_at,
        'observed_to', v_observation.observed_to,
        'source_frame_sha256', v_observation.frame_sha256,
        'location_id', v_observation.location_id,
        'canonical_place_id', v_observation.canonical_place_id,
        'authoritative_source_preserved', true
      )),
      jsonb_strip_nulls(jsonb_build_object(
        'face_provider', v_observation.attributes->'face_provider',
        'face_detector_model', v_observation.attributes->'face_detector_model',
        'face_embedding_model', v_observation.attributes->'face_embedding_model',
        'appearance_embedding_model', v_observation.attributes->'appearance_embedding_model',
        'identity_resolution', 'manual_review_required',
        'biometric_templates_copied', false
      )),
      CASE WHEN v_derivative.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'cctv_observation_derivative_id', v_derivative.id,
          'provider', v_derivative.provider,
          'original_sha256', v_derivative.original_sha256,
          'enhanced_sha256', v_derivative.enhanced_sha256,
          'fusion_profile', v_derivative.fusion_receipt->>'profile',
          'enhancement_profile', v_derivative.enhancement_profile,
          'generative', v_derivative.generative,
          'source_face_count', v_derivative.recognition_comparison->'source_face_count',
          'enhanced_face_count', v_derivative.recognition_comparison->'enhanced_face_count'
        ))
      ) END,
      'manual_review_required',
      v_idempotency_key
    )
    RETURNING id INTO v_envelope_id;

    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      source_locations, consensus_rule, authority_state, review_required
    ) VALUES (
      v_job.organization_id, v_envelope_id, 'person.presence', 0, 'boolean',
      'true', 'true',
      jsonb_strip_nulls(jsonb_build_object(
        'frame_count', v_observation.attributes->'frame_count',
        'review_candidate_basis', v_observation.attributes->'review_candidate_basis',
        'face_only', v_observation.attributes->'face_only',
        'upper_body_colour', v_observation.attributes->'upper_body_colour',
        'lower_body_colour', v_observation.attributes->'lower_body_colour',
        'visible_head_region', v_observation.attributes->'visible_head_region',
        'quality_state', v_observation.quality_state
      )),
      v_observation.model_confidence,
      jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'source_event_id', v_observation.source_event_id,
        'frame_sha256', v_observation.frame_sha256,
        'bbox', v_observation.attributes->'bbox',
        'observed_at', v_observation.observed_at,
        'observed_to', v_observation.observed_to
      ))),
      'person_detection_requires_human_review_v1',
      v_initial_authority, true
    );

    IF v_face_present THEN
      INSERT INTO public.perception_evidence_fields (
        organization_id, envelope_id, field_key, candidate_ordinal, value_type,
        candidate_value, normalized_value, candidate_payload, raw_confidence,
        source_locations, consensus_rule, authority_state, review_required
      ) VALUES (
        v_job.organization_id, v_envelope_id, 'person.face_detected', 0, 'boolean',
        'true', 'true',
        jsonb_strip_nulls(jsonb_build_object(
          'face_basis', v_observation.attributes->'face_basis',
          'face_provider', v_observation.attributes->'face_provider',
          'face_detector_model', v_observation.attributes->'face_detector_model',
          'face_embedding_model', v_observation.attributes->'face_embedding_model',
          'face_crop_width_px', v_observation.attributes->'face_crop_width_px',
          'face_alignment_basis', v_observation.attributes->'face_alignment_basis',
          'visit_count', coalesce(v_observation.attributes->'face_visit_count', v_observation.attributes->'visit_count'),
          'biometric_template_included', false
        )),
        nullif(v_observation.attributes->>'face_detector_confidence', '')::real,
        jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'source_event_id', v_observation.source_event_id,
          'frame_sha256', v_observation.frame_sha256,
          'bbox', v_observation.attributes->'bbox'
        ))),
        'human_review_required_no_tenant_face_calibration_v1',
        v_initial_authority, true
      );
    END IF;

    IF v_observation.portfolio_key IS NOT NULL THEN
      INSERT INTO public.perception_evidence_fields (
        organization_id, envelope_id, field_key, candidate_ordinal, value_type,
        candidate_value, normalized_value, candidate_payload,
        source_locations, consensus_rule, authority_state, review_required
      ) VALUES (
        v_job.organization_id, v_envelope_id, 'person.portfolio_candidate', 0, 'entity',
        v_observation.portfolio_key::text, v_observation.portfolio_key::text,
        jsonb_strip_nulls(jsonb_build_object(
          'portfolio_state', v_observation.portfolio_state,
          'candidate_count', v_candidate_count,
          'top_similarity', v_top_similarity,
          'identity_claimed', false,
          'biometric_template_included', false
        )),
        jsonb_build_array(jsonb_build_object(
          'cctv_entity_observation_id', v_observation.id,
          'source_event_id', v_observation.source_event_id
        )),
        'provisional_similarity_cluster_human_identity_required_v1',
        'candidate', true
      );
    END IF;

    PERFORM public.apply_cctv_person_review_to_perception(v_observation.id);

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_job.organization_id, auth.uid(), 'cctv_person_perception_evidence_recorded',
      'perception_evidence_envelopes', v_envelope_id,
      jsonb_build_object(
        'inference_job_id', p_job_id,
        'cctv_entity_observation_id', v_observation.id,
        'face_present', v_face_present,
        'biometric_templates_copied', false
      )
    );
    v_recorded := v_recorded + 1;
  END LOOP;

  RETURN jsonb_build_object('recorded', v_recorded, 'replayed', v_replayed);
END;
$$;

COMMENT ON FUNCTION public.record_cctv_person_perception_envelopes(uuid) IS
  'Service-only replay-safe projection of CCTV person and face provenance into shared perception receipts. Raw biometric templates never enter the shared envelope.';
REVOKE ALL ON FUNCTION public.record_cctv_person_perception_envelopes(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_person_perception_envelopes(uuid)
  TO service_role;