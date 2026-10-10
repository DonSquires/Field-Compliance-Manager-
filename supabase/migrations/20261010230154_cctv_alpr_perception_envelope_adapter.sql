CREATE INDEX perception_evidence_envelopes_cctv_observation_idx
  ON public.perception_evidence_envelopes ((source_receipt->>'cctv_entity_observation_id'))
  WHERE domain = 'cctv_alpr';

CREATE OR REPLACE FUNCTION public.sync_cctv_alpr_perception_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_field public.perception_evidence_fields%rowtype;
  v_decision text;
  v_next_authority text;
  v_review_required boolean;
BEGIN
  IF NEW.entity_kind <> 'vehicle' OR NEW.candidate_plate IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.review_state IS NOT DISTINCT FROM OLD.review_state
     AND NEW.reviewed_by IS NOT DISTINCT FROM OLD.reviewed_by THEN
    RETURN NEW;
  END IF;

  IF NEW.review_state = 'accepted' THEN
    v_decision := 'approve';
    v_next_authority := 'human_approved';
    v_review_required := false;
  ELSIF NEW.review_state = 'rejected' THEN
    v_decision := 'reject';
    v_next_authority := 'rejected';
    v_review_required := false;
  ELSIF NEW.review_state = 'uncertain' THEN
    v_decision := 'uncertain';
    v_next_authority := 'candidate';
    v_review_required := true;
  ELSIF NEW.review_state = 'needs_more_context' THEN
    v_decision := 'needs_more_context';
    v_next_authority := 'candidate';
    v_review_required := true;
  ELSIF NEW.review_state = 'superseded' THEN
    UPDATE public.perception_evidence_fields f
    SET authority_state = 'superseded',
        review_required = false,
        updated_at = clock_timestamp()
    FROM public.perception_evidence_envelopes e
    WHERE f.envelope_id = e.id
      AND e.organization_id = NEW.organization_id
      AND e.domain = 'cctv_alpr'
      AND e.source_receipt->>'cctv_entity_observation_id' = NEW.id::text;

    UPDATE public.perception_evidence_envelopes
    SET status = 'superseded',
        updated_at = clock_timestamp()
    WHERE organization_id = NEW.organization_id
      AND domain = 'cctv_alpr'
      AND source_receipt->>'cctv_entity_observation_id' = NEW.id::text;
    RETURN NEW;
  ELSE
    RETURN NEW;
  END IF;

  FOR v_field IN
    SELECT f.*
    FROM public.perception_evidence_fields f
    JOIN public.perception_evidence_envelopes e ON e.id = f.envelope_id
    WHERE e.organization_id = NEW.organization_id
      AND e.domain = 'cctv_alpr'
      AND e.source_receipt->>'cctv_entity_observation_id' = NEW.id::text
      AND f.field_key = 'vehicle.plate_number'
  LOOP
    IF NEW.reviewed_by IS NULL THEN
      RAISE EXCEPTION 'CCTV ALPR review state % requires an attributable reviewer', NEW.review_state;
    END IF;
    INSERT INTO public.perception_evidence_reviews (
      organization_id, field_id, previous_authority_state, decision,
      next_authority_state, reviewer_notes, canonical_reference, decided_by
    ) VALUES (
      NEW.organization_id, v_field.id, v_field.authority_state, v_decision,
      v_next_authority, nullif(trim(NEW.review_notes), ''),
      jsonb_strip_nulls(jsonb_build_object(
        'cctv_entity_observation_id', NEW.id,
        'canonical_vehicle_id', NEW.canonical_vehicle_id,
        'review_state', NEW.review_state
      )),
      NEW.reviewed_by
    );

    UPDATE public.perception_evidence_fields
    SET authority_state = v_next_authority,
        review_required = v_review_required,
        updated_at = clock_timestamp()
    WHERE id = v_field.id;

    UPDATE public.perception_evidence_envelopes
    SET status = CASE WHEN v_review_required THEN 'manual_review_required' ELSE 'complete' END,
        updated_at = clock_timestamp()
    WHERE id = v_field.envelope_id;
  END LOOP;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.sync_cctv_alpr_perception_review() IS
  'Projects the existing CCTV observation review decision into shared ALPR field authority. It does not create a second review authority.';
REVOKE ALL ON FUNCTION public.sync_cctv_alpr_perception_review() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS sync_cctv_alpr_perception_review_trigger ON public.cctv_entity_observations;
CREATE TRIGGER sync_cctv_alpr_perception_review_trigger
AFTER UPDATE OF review_state, reviewed_by
ON public.cctv_entity_observations
FOR EACH ROW
EXECUTE FUNCTION public.sync_cctv_alpr_perception_review();

CREATE OR REPLACE FUNCTION public.record_cctv_alpr_perception_envelopes(p_job_id uuid)
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
  v_field_id uuid;
  v_source_plate text;
  v_enhanced_plate text;
  v_conflicts jsonb;
  v_authority text;
  v_agreement boolean;
  v_temporal_consensus boolean;
  v_char_confidence real;
  v_evidence_quality text;
  v_idempotency_key text;
  v_recorded integer := 0;
  v_replayed integer := 0;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
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
    RAISE EXCEPTION 'CCTV source custody SHA-256 is required before ALPR evidence can be recorded';
  END IF;

  FOR v_observation IN
    SELECT o.*
    FROM public.cctv_entity_observations o
    WHERE o.inference_job_id = p_job_id
      AND o.organization_id = v_job.organization_id
      AND o.entity_kind = 'vehicle'
      AND o.candidate_plate IS NOT NULL
      AND o.review_state <> 'superseded'
    ORDER BY o.observed_at, o.id
  LOOP
    v_idempotency_key := 'cctv-alpr:' || v_observation.id::text || ':v1:' || lower(v_evidence.sha256_hash);
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

    v_source_plate := regexp_replace(upper(coalesce(
      v_derivative.recognition_comparison#>>'{alpr,source,text}', ''
    )), '[^A-Z0-9]', '', 'g');
    v_enhanced_plate := regexp_replace(upper(coalesce(
      v_derivative.recognition_comparison#>>'{alpr,enhanced,text}', ''
    )), '[^A-Z0-9]', '', 'g');
    v_agreement := coalesce((v_derivative.recognition_comparison#>>'{alpr,agreement}')::boolean, false);
    v_temporal_consensus := coalesce((v_observation.attributes->>'temporal_consensus')::boolean, false);
    v_char_confidence := nullif(v_observation.attributes->>'plate_char_confidence_min', '')::real;
    v_evidence_quality := coalesce(nullif(v_observation.attributes->>'alpr_evidence_quality', ''), 'unknown');

    v_conflicts := '[]'::jsonb;
    IF v_source_plate <> '' AND v_source_plate <> v_observation.candidate_plate THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'source', 'source_derivative', 'candidate', v_source_plate,
        'reason', 'differs_from_temporal_candidate'
      ));
    END IF;
    IF v_enhanced_plate <> '' AND v_enhanced_plate <> v_observation.candidate_plate THEN
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'source', 'enhanced_derivative', 'candidate', v_enhanced_plate,
        'reason', 'differs_from_temporal_candidate'
      ));
    END IF;

    v_authority := CASE
      WHEN v_evidence_quality = 'insufficient'
        OR coalesce((v_observation.attributes->>'plate_width_px')::integer, 0) < 48
        THEN 'insufficient'
      WHEN v_temporal_consensus
        AND v_agreement
        AND v_source_plate = v_observation.candidate_plate
        AND v_enhanced_plate = v_observation.candidate_plate
        AND coalesce(v_char_confidence, 0) >= 0.55
        AND jsonb_array_length(v_conflicts) = 0
        THEN 'verified_candidate'
      ELSE 'candidate'
    END;

    INSERT INTO public.perception_evidence_envelopes (
      organization_id, schema_version, domain, source_kind, source_sha256,
      evidence_item_id, inference_job_id, source_receipt, model_receipt,
      derivative_receipts, status, idempotency_key
    ) VALUES (
      v_job.organization_id, 1, 'cctv_alpr',
      CASE WHEN v_evidence.evidence_kind IN ('photo', 'image') THEN 'image' ELSE 'video' END,
      lower(v_evidence.sha256_hash), v_evidence.id, v_job.id,
      jsonb_strip_nulls(jsonb_build_object(
        'cctv_entity_observation_id', v_observation.id,
        'source_event_id', v_observation.source_event_id,
        'observed_at', v_observation.observed_at,
        'observed_to', v_observation.observed_to,
        'source_frame_sha256', v_observation.frame_sha256,
        'authoritative_source_preserved', true
      )),
      jsonb_strip_nulls(jsonb_build_object(
        'alpr_provider', v_observation.attributes->'alpr_provider',
        'alpr_models', v_observation.attributes->'alpr_models',
        'detector_provider', v_observation.attributes->'detector_provider',
        'inference_provider', v_observation.attributes->'inference_provider'
      )),
      CASE WHEN v_derivative.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'cctv_observation_derivative_id', v_derivative.id,
          'provider', v_derivative.provider,
          'original_sha256', v_derivative.original_sha256,
          'enhanced_sha256', v_derivative.enhanced_sha256,
          'fusion', v_derivative.fusion_receipt,
          'enhancement', v_derivative.enhancement_receipt,
          'recognition_comparison', v_derivative.recognition_comparison,
          'generative', v_derivative.generative
        ))
      ) END,
      'manual_review_required',
      v_idempotency_key
    )
    RETURNING id INTO v_envelope_id;

    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      character_confidences, source_locations, consensus_rule, conflicts,
      authority_state, review_required
    ) VALUES (
      v_job.organization_id, v_envelope_id, 'vehicle.plate_number', 0, 'identifier',
      v_observation.candidate_plate, v_observation.candidate_plate,
      jsonb_strip_nulls(jsonb_build_object(
        'raw_text', v_observation.attributes->'plate_raw_text',
        'corrections', v_observation.attributes->'plate_corrections',
        'minimum_character_confidence', v_char_confidence,
        'plate_width_px', v_observation.attributes->'plate_width_px',
        'evidence_quality', v_evidence_quality,
        'frame_count', v_observation.attributes->'frame_count',
        'visit_count', v_observation.attributes->'visit_count',
        'temporal_consensus', v_temporal_consensus,
        'source_candidate', nullif(v_source_plate, ''),
        'enhanced_candidate', nullif(v_enhanced_plate, ''),
        'source_enhanced_agreement', v_agreement
      )),
      v_observation.model_confidence,
      '[]'::jsonb,
      jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'source_event_id', v_observation.source_event_id,
        'frame_sha256', v_observation.frame_sha256,
        'bbox', v_observation.attributes->'bbox',
        'observed_at', v_observation.observed_at,
        'observed_to', v_observation.observed_to
      ))),
      CASE
        WHEN v_authority = 'verified_candidate' THEN 'temporal_and_source_enhanced_consensus_v1'
        ELSE 'cctv_alpr_candidate_v1'
      END,
      v_conflicts, v_authority, true
    )
    RETURNING id INTO v_field_id;

    IF v_observation.review_state IN ('accepted','rejected','uncertain','needs_more_context')
       AND v_observation.reviewed_by IS NOT NULL THEN
      INSERT INTO public.perception_evidence_reviews (
        organization_id, field_id, previous_authority_state, decision,
        next_authority_state, reviewer_notes, canonical_reference, decided_by
      ) VALUES (
        v_job.organization_id, v_field_id, v_authority,
        CASE v_observation.review_state
          WHEN 'accepted' THEN 'approve'
          WHEN 'rejected' THEN 'reject'
          WHEN 'uncertain' THEN 'uncertain'
          ELSE 'needs_more_context'
        END,
        CASE
          WHEN v_observation.review_state = 'accepted' THEN 'human_approved'
          WHEN v_observation.review_state = 'rejected' THEN 'rejected'
          ELSE 'candidate'
        END,
        nullif(trim(v_observation.review_notes), ''),
        jsonb_strip_nulls(jsonb_build_object(
          'cctv_entity_observation_id', v_observation.id,
          'canonical_vehicle_id', v_observation.canonical_vehicle_id,
          'review_state', v_observation.review_state
        )),
        v_observation.reviewed_by
      );

      UPDATE public.perception_evidence_fields
      SET authority_state = CASE
            WHEN v_observation.review_state = 'accepted' THEN 'human_approved'
            WHEN v_observation.review_state = 'rejected' THEN 'rejected'
            ELSE 'candidate'
          END,
          review_required = v_observation.review_state IN ('uncertain','needs_more_context'),
          updated_at = clock_timestamp()
      WHERE id = v_field_id;

      UPDATE public.perception_evidence_envelopes
      SET status = CASE
            WHEN v_observation.review_state IN ('uncertain','needs_more_context') THEN 'manual_review_required'
            ELSE 'complete'
          END,
          updated_at = clock_timestamp()
      WHERE id = v_envelope_id;
    END IF;

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_job.organization_id, auth.uid(), 'cctv_alpr_perception_evidence_recorded',
      'perception_evidence_envelopes', v_envelope_id,
      jsonb_build_object(
        'inference_job_id', p_job_id,
        'cctv_entity_observation_id', v_observation.id,
        'authority_state', v_authority
      )
    );
    v_recorded := v_recorded + 1;
  END LOOP;

  RETURN jsonb_build_object('recorded', v_recorded, 'replayed', v_replayed);
END;
$$;

COMMENT ON FUNCTION public.record_cctv_alpr_perception_envelopes(uuid) IS
  'Service-only replay-safe projection of CCTV ALPR observations and source/enhanced derivative receipts into the shared perception evidence spine.';
REVOKE ALL ON FUNCTION public.record_cctv_alpr_perception_envelopes(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_alpr_perception_envelopes(uuid) TO service_role;