CREATE OR REPLACE FUNCTION public.ensure_canonical_vehicle(
  p_plate text,
  p_make text,
  p_model text,
  p_colour text,
  p_source_table text,
  p_source_key text,
  p_observed_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_alnum text := upper(regexp_replace(coalesce(p_plate, ''), '[^A-Za-z0-9]', '', 'g'));
  v_plate text := public.normalize_plate_number(p_plate);
  v_id uuid;
  v_make text := CASE WHEN p_source_table = 'cctv_entity_observations' THEN NULL ELSE p_make END;
  v_model text := CASE WHEN p_source_table = 'cctv_entity_observations' THEN NULL ELSE p_model END;
  v_colour text := CASE WHEN p_source_table = 'cctv_entity_observations' THEN NULL ELSE p_colour END;
BEGIN
  IF v_plate IS NULL THEN RETURN NULL; END IF;
  IF length(v_alnum) > 10 THEN RETURN NULL; END IF;

  SELECT id INTO v_id FROM public.canonical_vehicles WHERE plate_number = v_plate;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO public.canonical_vehicles (plate_number, make, model, colour, last_seen_at)
  VALUES (v_plate, v_make, v_model, v_colour, p_observed_at)
  ON CONFLICT (plate_number) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.canonical_vehicles WHERE plate_number = v_plate;
    RETURN v_id;
  END IF;

  INSERT INTO public.canonical_vehicle_links (
    canonical_vehicle_id, source_system, source_table, source_key, metadata
  ) VALUES (
    v_id, 'field_observation', p_source_table, p_source_key,
    jsonb_build_object(
      'created_from_record', true,
      'observed_at', p_observed_at,
      'raw_plate', p_plate
    )
  )
  ON CONFLICT (source_system, source_table, source_key) DO NOTHING;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.ensure_canonical_vehicle(text, text, text, text, text, text, timestamptz) IS
  'Find-or-create the global vehicle identity for a normalized plate. CCTV calls establish identity only; their visual attributes require the dedicated human attribute review before canonical promotion.';
REVOKE ALL ON FUNCTION public.ensure_canonical_vehicle(text, text, text, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ensure_canonical_vehicle(text, text, text, text, text, text, timestamptz)
  TO postgres, service_role;

DROP FUNCTION IF EXISTS public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text, text);

CREATE FUNCTION public.confirm_cctv_vehicle_attributes(
  p_observation_id uuid,
  p_action text,
  p_make text DEFAULT NULL,
  p_model text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_colour text DEFAULT NULL,
  p_body_type text DEFAULT NULL,
  p_year integer DEFAULT NULL
)
RETURNS public.cctv_entity_observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_obs public.cctv_entity_observations%rowtype;
  v_org uuid;
  v_actor uuid := auth.uid();
  v_action text := lower(trim(coalesce(p_action, '')));
  v_existing_request uuid;
  v_final_make text;
  v_final_model text;
  v_final_colour text;
  v_final_body_type text;
  v_final_year integer;
  v_reviewed_fields jsonb := '[]'::jsonb;
  v_vehicle uuid;
  v_plate text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_action NOT IN ('confirm', 'correct', 'reject') THEN
    RAISE EXCEPTION 'Action must be confirm, correct, or reject';
  END IF;
  IF p_year IS NOT NULL AND (p_year < 1886 OR p_year > extract(year FROM current_date)::integer + 2) THEN
    RAISE EXCEPTION 'Vehicle year is outside the supported range';
  END IF;

  SELECT * INTO v_obs
  FROM public.cctv_entity_observations
  WHERE id = p_observation_id
    AND entity_kind = 'vehicle'
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle observation not found'; END IF;
  v_org := v_obs.organization_id;

  IF NOT public.has_role(v_actor, v_org, ARRAY['super_admin','admiral','admin','manager']) THEN
    RAISE EXCEPTION 'Vehicle attribute review requires manager access';
  END IF;

  IF nullif(trim(coalesce(p_request_id, '')), '') IS NOT NULL THEN
    SELECT id INTO v_existing_request
    FROM public.audit_log
    WHERE organization_id = v_org
      AND action = 'cctv_vehicle_attributes_reviewed'
      AND metadata->>'request_id' = trim(p_request_id)
    LIMIT 1;
    IF v_existing_request IS NOT NULL THEN RETURN v_obs; END IF;
  END IF;

  IF v_action = 'correct'
     AND nullif(trim(coalesce(p_make, '')), '') IS NULL
     AND nullif(trim(coalesce(p_model, '')), '') IS NULL
     AND nullif(trim(coalesce(p_colour, '')), '') IS NULL
     AND nullif(trim(coalesce(p_body_type, '')), '') IS NULL
     AND p_year IS NULL THEN
    RAISE EXCEPTION 'A correction requires at least one corrected attribute';
  END IF;

  IF v_action IN ('confirm', 'correct') THEN
    v_final_make := coalesce(nullif(trim(p_make), ''), nullif(trim(v_obs.attributes->>'make'), ''));
    v_final_model := coalesce(nullif(trim(p_model), ''), nullif(trim(v_obs.attributes->>'model'), ''));
    v_final_colour := coalesce(nullif(trim(p_colour), ''), nullif(trim(v_obs.attributes->>'colour'), ''));
    v_final_body_type := coalesce(nullif(trim(p_body_type), ''), nullif(trim(v_obs.attributes->>'body_type'), ''));
    v_final_year := coalesce(
      p_year,
      CASE WHEN v_obs.attributes->>'year' ~ '^[0-9]{4}$' THEN (v_obs.attributes->>'year')::integer END
    );

    IF v_final_make IS NOT NULL THEN v_reviewed_fields := v_reviewed_fields || jsonb_build_array('make'); END IF;
    IF v_final_model IS NOT NULL THEN v_reviewed_fields := v_reviewed_fields || jsonb_build_array('model'); END IF;
    IF v_final_colour IS NOT NULL THEN v_reviewed_fields := v_reviewed_fields || jsonb_build_array('colour'); END IF;
    IF v_final_body_type IS NOT NULL THEN v_reviewed_fields := v_reviewed_fields || jsonb_build_array('body_type'); END IF;
    IF v_final_year IS NOT NULL THEN v_reviewed_fields := v_reviewed_fields || jsonb_build_array('year'); END IF;
    IF jsonb_array_length(v_reviewed_fields) = 0 THEN
      RAISE EXCEPTION 'No vehicle attributes are available to review';
    END IF;
  END IF;

  UPDATE public.cctv_entity_observations
  SET attributes = attributes
        || CASE WHEN v_action IN ('confirm', 'correct') THEN jsonb_strip_nulls(jsonb_build_object(
             'make', v_final_make,
             'model', v_final_model,
             'colour', v_final_colour,
             'body_type', v_final_body_type,
             'year', v_final_year,
             'make_model_source', CASE WHEN v_final_make IS NOT NULL OR v_final_model IS NOT NULL THEN 'human_confirmed' END,
             'vehicle_attribute_source', CASE WHEN v_final_colour IS NOT NULL OR v_final_body_type IS NOT NULL OR v_final_year IS NOT NULL THEN 'human_confirmed' END
           )) ELSE '{}'::jsonb END
        || jsonb_build_object('make_model_review', jsonb_strip_nulls(jsonb_build_object(
             'status', CASE v_action WHEN 'confirm' THEN 'confirmed' WHEN 'correct' THEN 'corrected' ELSE 'rejected' END,
             'reviewed_at', clock_timestamp(),
             'reviewed_by', v_actor,
             'notes', nullif(trim(p_notes), ''),
             'reviewed_fields', CASE WHEN v_action = 'reject' THEN jsonb_build_array('make','model','colour','body_type','year') ELSE v_reviewed_fields END,
             'values', CASE WHEN v_action = 'reject' THEN NULL ELSE jsonb_strip_nulls(jsonb_build_object(
               'make', v_final_make,
               'model', v_final_model,
               'colour', v_final_colour,
               'body_type', v_final_body_type,
               'year', v_final_year
             )) END
           )))
  WHERE id = v_obs.id
  RETURNING * INTO v_obs;

  IF v_action IN ('confirm', 'correct') THEN
    v_plate := public.normalize_plate_number(v_obs.candidate_plate);
    IF v_plate IS NOT NULL THEN
      v_vehicle := coalesce(
        v_obs.canonical_vehicle_id,
        public.ensure_canonical_vehicle(
          v_plate, NULL, NULL, NULL,
          'cctv_entity_observations', v_obs.id::text, v_obs.observed_at
        )
      );
      IF v_vehicle IS NOT NULL THEN
        UPDATE public.canonical_vehicles
        SET make = coalesce(v_final_make, make),
            model = coalesce(v_final_model, model),
            colour = coalesce(v_final_colour, colour),
            body_type = coalesce(v_final_body_type, body_type),
            year = coalesce(v_final_year, year),
            updated_at = clock_timestamp()
        WHERE id = v_vehicle;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_org, v_actor, 'cctv_vehicle_attributes_reviewed',
    'cctv_entity_observations', v_obs.id,
    jsonb_strip_nulls(jsonb_build_object(
      'review_action', v_action,
      'request_id', nullif(trim(p_request_id), ''),
      'reviewed_fields', CASE WHEN v_action = 'reject' THEN jsonb_build_array('make','model','colour','body_type','year') ELSE v_reviewed_fields END,
      'values', CASE WHEN v_action = 'reject' THEN NULL ELSE v_obs.attributes->'make_model_review'->'values' END,
      'canonical_vehicle_id', v_vehicle
    ))
  );
  RETURN v_obs;
END;
$$;

COMMENT ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text, text, text, text, integer) IS
  'The sole human authority for CCTV-derived make, model, colour, body type and year. Machine candidates remain provisional until this action confirms or corrects them.';
REVOKE ALL ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text, text, text, text, integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_cctv_vehicle_attributes(uuid, text, text, text, text, text, text, text, integer)
  TO authenticated, service_role;

CREATE INDEX perception_evidence_envelopes_cctv_vehicle_attributes_observation_idx
  ON public.perception_evidence_envelopes ((source_receipt->>'cctv_entity_observation_id'))
  WHERE domain = 'cctv_vehicle_attributes';

CREATE OR REPLACE FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception(p_observation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_observation public.cctv_entity_observations%rowtype;
  v_envelope public.perception_evidence_envelopes%rowtype;
  v_field public.perception_evidence_fields%rowtype;
  v_review jsonb;
  v_reviewed_fields jsonb;
  v_short_key text;
  v_final_value text;
  v_target_authority text;
  v_decision text;
  v_actor uuid;
  v_correction_field_id uuid;
BEGIN
  SELECT * INTO v_observation
  FROM public.cctv_entity_observations
  WHERE id = p_observation_id;
  IF NOT FOUND OR v_observation.entity_kind <> 'vehicle' THEN RETURN; END IF;

  v_review := v_observation.attributes->'make_model_review';
  IF jsonb_typeof(v_review) <> 'object' OR v_review->>'status' NOT IN ('confirmed','corrected','rejected') THEN
    RETURN;
  END IF;
  v_actor := nullif(v_review->>'reviewed_by', '')::uuid;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Vehicle attribute review requires an attributable reviewer';
  END IF;
  v_reviewed_fields := CASE
    WHEN jsonb_typeof(v_review->'reviewed_fields') = 'array' THEN v_review->'reviewed_fields'
    WHEN v_review->>'status' = 'rejected' THEN jsonb_build_array('make','model')
    ELSE jsonb_build_array('make','model')
  END;

  FOR v_envelope IN
    SELECT e.*
    FROM public.perception_evidence_envelopes e
    WHERE e.organization_id = v_observation.organization_id
      AND e.domain = 'cctv_vehicle_attributes'
      AND e.source_receipt->>'cctv_entity_observation_id' = v_observation.id::text
  LOOP
    FOR v_field IN
      SELECT f.*
      FROM public.perception_evidence_fields f
      WHERE f.envelope_id = v_envelope.id
      ORDER BY f.field_key, f.candidate_ordinal
    LOOP
      v_short_key := replace(v_field.field_key, 'vehicle.', '');
      IF NOT v_reviewed_fields ? v_short_key THEN CONTINUE; END IF;
      v_final_value := coalesce(v_review#>>ARRAY['values', v_short_key], v_field.candidate_value);
      v_target_authority := CASE
        WHEN v_review->>'status' = 'rejected' THEN 'rejected'
        WHEN lower(coalesce(v_field.normalized_value, v_field.candidate_value)) = lower(v_final_value) THEN 'human_approved'
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
          v_observation.organization_id, v_field.id, v_field.authority_state, v_decision,
          v_target_authority, nullif(trim(v_review->>'notes'), ''),
          jsonb_strip_nulls(jsonb_build_object(
            'cctv_entity_observation_id', v_observation.id,
            'canonical_vehicle_id', v_observation.canonical_vehicle_id,
            'field', v_short_key,
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
          v_observation.organization_id, v_envelope.id, v_field.field_key, 1, v_field.value_type,
          v_final_value, lower(trim(v_final_value)),
          jsonb_build_object('human_correction', true),
          jsonb_build_array(jsonb_build_object('cctv_entity_observation_id', v_observation.id)),
          'explicit_human_vehicle_attribute_correction_v1', 'candidate', true
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
          v_observation.organization_id, v_correction_field_id, 'candidate', 'correct',
          'human_approved', nullif(trim(v_review->>'notes'), ''),
          jsonb_strip_nulls(jsonb_build_object(
            'cctv_entity_observation_id', v_observation.id,
            'canonical_vehicle_id', v_observation.canonical_vehicle_id,
            'field', v_short_key,
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
            SELECT 1 FROM public.perception_evidence_fields f
            WHERE f.envelope_id = e.id AND f.review_required
          ) THEN 'manual_review_required'
          ELSE 'complete'
        END,
        updated_at = clock_timestamp()
    WHERE e.id = v_envelope.id;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception(uuid) IS
  'Projects the existing human vehicle-attribute decision into shared field authority while preserving corrected machine candidates as superseded evidence.';
REVOKE ALL ON FUNCTION public.apply_cctv_vehicle_attribute_review_to_perception(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_cctv_vehicle_attribute_perception_review()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.entity_kind = 'vehicle'
     AND NEW.attributes->'make_model_review' IS DISTINCT FROM OLD.attributes->'make_model_review' THEN
    PERFORM public.apply_cctv_vehicle_attribute_review_to_perception(NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_cctv_vehicle_attribute_perception_review()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS sync_cctv_vehicle_attribute_perception_review_trigger
  ON public.cctv_entity_observations;
CREATE TRIGGER sync_cctv_vehicle_attribute_perception_review_trigger
AFTER UPDATE OF attributes
ON public.cctv_entity_observations
FOR EACH ROW
EXECUTE FUNCTION public.sync_cctv_vehicle_attribute_perception_review();

CREATE OR REPLACE FUNCTION public.record_cctv_vehicle_attribute_perception_envelopes(p_job_id uuid)
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
  v_field_key text;
  v_value text;
  v_confidence real;
  v_recorded integer := 0;
  v_replayed integer := 0;
  v_field_count integer;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Service identity required'; END IF;

  SELECT * INTO v_job FROM public.inference_jobs WHERE id = p_job_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Inference job is missing'; END IF;
  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = v_job.evidence_item_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Evidence item is missing'; END IF;
  IF v_evidence.organization_id <> v_job.organization_id THEN
    RAISE EXCEPTION 'Evidence and inference job organization mismatch';
  END IF;
  IF lower(coalesce(v_evidence.sha256_hash, '')) !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'CCTV source custody SHA-256 is required before vehicle attributes can be recorded';
  END IF;

  FOR v_observation IN
    SELECT o.*
    FROM public.cctv_entity_observations o
    WHERE o.inference_job_id = p_job_id
      AND o.organization_id = v_job.organization_id
      AND o.entity_kind = 'vehicle'
      AND o.review_state <> 'superseded'
      AND (
        nullif(trim(o.attributes->>'make'), '') IS NOT NULL
        OR nullif(trim(o.attributes->>'model'), '') IS NOT NULL
        OR nullif(trim(o.attributes->>'colour'), '') IS NOT NULL
        OR nullif(trim(o.attributes->>'body_type'), '') IS NOT NULL
        OR nullif(trim(o.attributes->>'year'), '') IS NOT NULL
      )
    ORDER BY o.observed_at, o.id
  LOOP
    v_idempotency_key := 'cctv-vehicle-attributes:' || v_observation.id::text
      || ':v1:' || lower(v_evidence.sha256_hash);
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

    INSERT INTO public.perception_evidence_envelopes (
      organization_id, schema_version, domain, source_kind, source_sha256,
      evidence_item_id, inference_job_id, source_receipt, model_receipt,
      derivative_receipts, status, idempotency_key
    ) VALUES (
      v_job.organization_id, 1, 'cctv_vehicle_attributes',
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
        'attribute_provider', coalesce(
          v_observation.attributes->'vehicle_attribute_source',
          v_observation.attributes->'inference_provider'
        ),
        'attribute_model', v_observation.attributes->'vehicle_attribute_model',
        'attribute_status', v_observation.attributes->'vehicle_attribute_status',
        'crop_status', v_observation.attributes->'vehicle_crop_status',
        'make_model_source', v_observation.attributes->'make_model_source',
        'appearance_embedding_included', false
      )),
      CASE WHEN v_derivative.id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'cctv_observation_derivative_id', v_derivative.id,
          'provider', v_derivative.provider,
          'original_sha256', v_derivative.original_sha256,
          'enhanced_sha256', v_derivative.enhanced_sha256,
          'enhancement_profile', v_derivative.enhancement_profile,
          'generative', v_derivative.generative
        ))
      ) END,
      'manual_review_required',
      v_idempotency_key
    )
    RETURNING id INTO v_envelope_id;

    v_field_count := 0;
    FOR v_field_key, v_value, v_confidence IN
      SELECT *
      FROM (VALUES
        ('vehicle.make', nullif(trim(v_observation.attributes->>'make'), ''), NULL::real),
        ('vehicle.model', nullif(trim(v_observation.attributes->>'model'), ''), NULL::real),
        ('vehicle.colour', nullif(trim(v_observation.attributes->>'colour'), ''),
          coalesce(
            CASE WHEN v_observation.attributes->>'colour_confidence' ~ '^[0-9]+([.][0-9]+)?$'
              THEN (v_observation.attributes->>'colour_confidence')::real END,
            CASE WHEN v_observation.attributes->>'attribute_confidence' ~ '^[0-9]+([.][0-9]+)?$'
              THEN (v_observation.attributes->>'attribute_confidence')::real END
          )),
        ('vehicle.body_type', nullif(trim(v_observation.attributes->>'body_type'), ''),
          coalesce(
            CASE WHEN v_observation.attributes->>'body_type_confidence' ~ '^[0-9]+([.][0-9]+)?$'
              THEN (v_observation.attributes->>'body_type_confidence')::real END,
            CASE WHEN v_observation.attributes->>'attribute_confidence' ~ '^[0-9]+([.][0-9]+)?$'
              THEN (v_observation.attributes->>'attribute_confidence')::real END
          )),
        ('vehicle.year', nullif(trim(v_observation.attributes->>'year'), ''), NULL::real)
      ) AS candidate(field_key, candidate_value, confidence)
      WHERE candidate_value IS NOT NULL
    LOOP
      INSERT INTO public.perception_evidence_fields (
        organization_id, envelope_id, field_key, candidate_ordinal, value_type,
        candidate_value, normalized_value, candidate_payload, raw_confidence,
        source_locations, consensus_rule, authority_state, review_required
      ) VALUES (
        v_job.organization_id, v_envelope_id, v_field_key, 0,
        CASE WHEN v_field_key = 'vehicle.year' THEN 'number' ELSE 'text' END,
        v_value, lower(trim(v_value)),
        jsonb_strip_nulls(jsonb_build_object(
          'source', CASE
            WHEN v_field_key IN ('vehicle.make','vehicle.model')
              THEN v_observation.attributes->'make_model_source'
            ELSE coalesce(
              v_observation.attributes->'vehicle_attribute_source',
              v_observation.attributes->'inference_provider'
            )
          END,
          'model', v_observation.attributes->'vehicle_attribute_model',
          'attribute_status', v_observation.attributes->'vehicle_attribute_status',
          'crop_status', v_observation.attributes->'vehicle_crop_status',
          'quality_state', v_observation.quality_state,
          'appearance_embedding_included', false
        )),
        v_confidence,
        jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'source_event_id', v_observation.source_event_id,
          'frame_sha256', v_observation.frame_sha256,
          'bbox', v_observation.attributes->'bbox',
          'observed_at', v_observation.observed_at,
          'observed_to', v_observation.observed_to
        ))),
        CASE
          WHEN v_field_key IN ('vehicle.make','vehicle.model')
            THEN 'unverified_vision_llm_hint_human_review_required_v1'
          WHEN coalesce(
            v_observation.attributes->>'vehicle_attribute_source',
            v_observation.attributes->>'inference_provider',
            ''
          ) = 'openvino_vehicle_attributes_0039'
            THEN 'trained_vehicle_attribute_candidate_human_review_required_v1'
          ELSE 'legacy_or_heuristic_vehicle_attribute_human_review_required_v1'
        END,
        CASE
          WHEN v_observation.quality_state IN ('glitch','flare','ir_switch','degraded','occluded')
            THEN 'insufficient'
          ELSE 'candidate'
        END,
        true
      );
      v_field_count := v_field_count + 1;
    END LOOP;

    IF v_field_count = 0 THEN
      RAISE EXCEPTION 'Vehicle attribute envelope requires at least one candidate field';
    END IF;
    PERFORM public.apply_cctv_vehicle_attribute_review_to_perception(v_observation.id);

    INSERT INTO public.audit_log (
      organization_id, actor_user_id, action, target_table, target_id, metadata
    ) VALUES (
      v_job.organization_id, auth.uid(), 'cctv_vehicle_attribute_perception_recorded',
      'perception_evidence_envelopes', v_envelope_id,
      jsonb_build_object(
        'inference_job_id', p_job_id,
        'cctv_entity_observation_id', v_observation.id,
        'field_count', v_field_count,
        'appearance_embedding_included', false
      )
    );
    v_recorded := v_recorded + 1;
  END LOOP;

  RETURN jsonb_build_object('recorded', v_recorded, 'replayed', v_replayed);
END;
$$;

COMMENT ON FUNCTION public.record_cctv_vehicle_attribute_perception_envelopes(uuid) IS
  'Service-only replay-safe projection of CCTV vehicle attribute candidates into shared receipts. Machine attributes never become canonical without the existing human review action.';
REVOKE ALL ON FUNCTION public.record_cctv_vehicle_attribute_perception_envelopes(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_vehicle_attribute_perception_envelopes(uuid)
  TO service_role;