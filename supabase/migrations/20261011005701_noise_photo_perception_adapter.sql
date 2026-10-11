ALTER TABLE public.noise_assessments
  ADD COLUMN IF NOT EXISTS noise_ai_analysis jsonb,
  ADD COLUMN IF NOT EXISTS noise_ai_review jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.noise_assessments.noise_ai_analysis IS
  'Structured advisory visible-image analysis. It cannot determine acoustic level, excessive noise, or enforcement authority.';
COMMENT ON COLUMN public.noise_assessments.noise_ai_review IS
  'Attributable human confirmation, correction, or rejection of advisory noise-photo fields.';

CREATE TABLE IF NOT EXISTS public.noise_assessment_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  noise_assessment_id uuid NOT NULL REFERENCES public.noise_assessments(id) ON DELETE CASCADE,
  evidence_item_id uuid NOT NULL REFERENCES public.evidence_items(id) ON DELETE CASCADE,
  ordinal integer NOT NULL DEFAULT 0,
  purpose text NOT NULL DEFAULT 'primary_evidence',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT noise_assessment_evidence_unique UNIQUE (noise_assessment_id, evidence_item_id)
);

COMMENT ON TABLE public.noise_assessment_evidence IS
  'Explicit junction linking a noise assessment to immutable canonical evidence items.';

CREATE INDEX IF NOT EXISTS noise_assessment_evidence_assessment_idx
  ON public.noise_assessment_evidence (noise_assessment_id, ordinal);
CREATE INDEX IF NOT EXISTS perception_evidence_noise_assessment_idx
  ON public.perception_evidence_envelopes ((source_receipt->>'noise_assessment_id'))
  WHERE domain = 'noise_photo';

ALTER TABLE public.noise_assessment_evidence ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS noise_assessment_evidence_select ON public.noise_assessment_evidence;
CREATE POLICY noise_assessment_evidence_select
  ON public.noise_assessment_evidence
  FOR SELECT TO authenticated
  USING (
    public.user_has_task_entitlement(
      auth.uid(),
      p_noise_assessment_id => noise_assessment_id
    )
  );
REVOKE INSERT, UPDATE, DELETE ON public.noise_assessment_evidence FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.noise_assessment_evidence TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.submit_officer_noise_assessment_v2(
  p_client_request_id uuid,
  p_assessed_at timestamptz,
  p_noise_source text,
  p_noise_source_address text,
  p_action_taken text DEFAULT 'no_action',
  p_volume_score smallint DEFAULT 0,
  p_time_score smallint DEFAULT 1,
  p_tone_score smallint DEFAULT 0,
  p_complaint_address text DEFAULT NULL,
  p_complainant_site_id uuid DEFAULT NULL,
  p_notice_number text DEFAULT NULL,
  p_end_number text DEFAULT NULL,
  p_occupant_name text DEFAULT NULL,
  p_occupant_dob date DEFAULT NULL,
  p_is_large_event_or_commercial boolean DEFAULT false,
  p_police_requested boolean DEFAULT false,
  p_police_present boolean DEFAULT false,
  p_scene_description text DEFAULT NULL,
  p_incident_report_text text DEFAULT NULL,
  p_follow_up_required boolean DEFAULT false,
  p_shift_id uuid DEFAULT NULL,
  p_dispatch_job_id uuid DEFAULT NULL,
  p_gps_lat double precision DEFAULT NULL,
  p_gps_lng double precision DEFAULT NULL,
  p_evidence_items jsonb DEFAULT '[]'::jsonb,
  p_classification jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id uuid,
  created boolean,
  received_at timestamptz,
  review_status text,
  matrix_total smallint,
  evidence_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_org uuid;
  v_receipt record;
  v_assessment public.noise_assessments%ROWTYPE;
  v_item jsonb;
  v_evidence_id uuid;
  v_hash text;
  v_ordinal integer := 0;
  v_photos jsonb := '[]'::jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF jsonb_typeof(p_evidence_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Noise evidence items must be an array';
  END IF;
  IF jsonb_array_length(p_evidence_items) = 0 THEN
    RAISE EXCEPTION 'At least one governed noise evidence photo is required';
  END IF;
  IF jsonb_typeof(p_classification) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Structured noise classification receipt is required';
  END IF;

  SELECT organization_id INTO v_org
  FROM public.user_profiles
  WHERE id = v_actor AND deactivated_at IS NULL
    AND role IN ('officer', 'admin_officer', 'admin', 'master', 'grand_master');
  IF v_org IS NULL THEN RAISE EXCEPTION 'Active officer profile required'; END IF;

  SELECT * INTO v_receipt
  FROM public.submit_officer_noise_assessment(
    p_client_request_id => p_client_request_id,
    p_assessed_at => p_assessed_at,
    p_noise_source => p_noise_source,
    p_noise_source_address => p_noise_source_address,
    p_action_taken => p_action_taken,
    p_volume_score => p_volume_score,
    p_time_score => p_time_score,
    p_tone_score => p_tone_score,
    p_complaint_address => p_complaint_address,
    p_complainant_site_id => p_complainant_site_id,
    p_notice_number => p_notice_number,
    p_end_number => p_end_number,
    p_occupant_name => p_occupant_name,
    p_occupant_dob => p_occupant_dob,
    p_is_large_event_or_commercial => p_is_large_event_or_commercial,
    p_police_requested => p_police_requested,
    p_police_present => p_police_present,
    p_scene_description => p_scene_description,
    p_incident_report_text => p_incident_report_text,
    p_follow_up_required => p_follow_up_required,
    p_shift_id => p_shift_id,
    p_dispatch_job_id => p_dispatch_job_id,
    p_gps_lat => p_gps_lat,
    p_gps_lng => p_gps_lng
  );

  SELECT * INTO v_assessment
  FROM public.noise_assessments
  WHERE noise_assessments.id = v_receipt.id
    AND organization_id = v_org
    AND officer_user_id = v_actor
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Noise assessment receipt is outside caller authority'; END IF;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_evidence_items)
  LOOP
    IF nullif(v_item->>'watermarked_path', '') IS NULL
       OR v_item->>'watermarked_path' NOT LIKE
          'org/' || v_org::text || '/noise-assessments/' || p_client_request_id::text || '/%' THEN
      RAISE EXCEPTION 'Noise evidence is outside the governed private intake path';
    END IF;
    v_hash := lower(coalesce(v_item->>'watermarked_sha256', ''));
    IF (v_hash ~ '^[0-9a-f]{64}$') IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Noise evidence requires a valid SHA-256 custody hash';
    END IF;

    SELECT link.evidence_item_id INTO v_evidence_id
    FROM public.noise_assessment_evidence link
    JOIN public.evidence_items evidence ON evidence.id = link.evidence_item_id
    WHERE link.noise_assessment_id = v_assessment.id
      AND evidence.storage_path = v_item->>'watermarked_path';

    IF v_evidence_id IS NULL THEN
      INSERT INTO public.evidence_items (
        organization_id, module_key, evidence_kind, storage_path,
        captured_by_user_id, captured_at, metadata, sha256_hash,
        is_court_ready, locked_at
      ) VALUES (
        v_org, 'noise_control', coalesce(v_item->>'evidence_kind', 'photo'),
        v_item->>'watermarked_path', v_actor, p_assessed_at, v_item, v_hash,
        true, clock_timestamp()
      )
      RETURNING evidence_items.id INTO v_evidence_id;

      INSERT INTO public.noise_assessment_evidence (
        organization_id, noise_assessment_id, evidence_item_id, ordinal, purpose
      ) VALUES (
        v_org, v_assessment.id, v_evidence_id, v_ordinal,
        coalesce(v_item->>'purpose', 'primary_evidence')
      );
    END IF;

    v_photos := v_photos || jsonb_build_array(jsonb_build_object(
      'id', v_evidence_id,
      'storage_path', v_item->>'watermarked_path',
      'original_path', v_item->>'original_path',
      'captured_at', p_assessed_at,
      'sha256', v_hash
    ));
    v_ordinal := v_ordinal + 1;
  END LOOP;

  UPDATE public.noise_assessments
  SET photo_urls = v_photos,
      noise_ai_analysis = p_classification,
      bob_classification = nullif(trim(coalesce(p_classification->>'classification', '')), ''),
      bob_confidence = CASE
        WHEN p_classification->>'confidence' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (p_classification->>'confidence')::real
        ELSE NULL
      END,
      updated_at = clock_timestamp()
  WHERE noise_assessments.id = v_assessment.id
  RETURNING * INTO v_assessment;

  RETURN QUERY
  SELECT v_assessment.id, v_receipt.created, v_receipt.received_at,
         v_assessment.review_status, v_assessment.matrix_total, 'verified'::text;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_officer_noise_assessment_v2(
  uuid,timestamptz,text,text,text,smallint,smallint,smallint,text,uuid,text,text,
  text,date,boolean,boolean,boolean,text,text,boolean,uuid,uuid,double precision,
  double precision,jsonb,jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_officer_noise_assessment_v2(
  uuid,timestamptz,text,text,text,smallint,smallint,smallint,text,uuid,text,text,
  text,date,boolean,boolean,boolean,text,text,boolean,uuid,uuid,double precision,
  double precision,jsonb,jsonb
) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_noise_photo_perception_envelope(
  p_assessment_id uuid,
  p_classification jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_assessment public.noise_assessments%ROWTYPE;
  v_evidence public.evidence_items%ROWTYPE;
  v_source text;
  v_equipment text;
  v_level text;
  v_confidence real;
  v_authority text;
  v_key text;
  v_envelope uuid;
  v_recorded integer := 0;
BEGIN
  IF coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF jsonb_typeof(p_classification) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Structured noise classification is required';
  END IF;

  SELECT * INTO v_assessment
  FROM public.noise_assessments
  WHERE id = p_assessment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Noise assessment is missing'; END IF;

  SELECT evidence.* INTO v_evidence
  FROM public.noise_assessment_evidence link
  JOIN public.evidence_items evidence ON evidence.id = link.evidence_item_id
  WHERE link.noise_assessment_id = v_assessment.id
    AND link.organization_id = v_assessment.organization_id
  ORDER BY CASE WHEN link.purpose = 'primary_evidence' THEN 0 ELSE 1 END,
           link.ordinal, link.id
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_evidence_link');
  END IF;
  IF (lower(v_evidence.sha256_hash) ~ '^[0-9a-f]{64}$') IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'missing_source_hash');
  END IF;
  IF coalesce(p_classification->>'status', 'unavailable') <> 'available' THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'classification_unavailable');
  END IF;

  v_source := nullif(trim(coalesce(
    p_classification#>>'{details,source_type}',
    p_classification->>'classification'
  )), '');
  v_equipment := nullif(trim(p_classification#>>'{details,equipment_type}'), '');
  v_level := nullif(trim(p_classification#>>'{details,estimated_level}'), '');
  v_confidence := CASE
    WHEN p_classification->>'confidence' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (p_classification->>'confidence')::real
  END;
  IF v_confidence IS NULL OR v_confidence < 0 OR v_confidence > 1 THEN
    RAISE EXCEPTION 'Noise classification confidence is invalid';
  END IF;
  IF v_source IS NULL AND v_equipment IS NULL AND v_level IS NULL THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 0, 'skipped', 'no_structured_candidates');
  END IF;

  v_key := 'noise-photo:' || v_assessment.id::text || ':v1:' || lower(v_evidence.sha256_hash);
  SELECT id INTO v_envelope
  FROM public.perception_evidence_envelopes
  WHERE organization_id = v_assessment.organization_id
    AND idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('recorded', 0, 'replayed', 1, 'envelope_id', v_envelope);
  END IF;

  INSERT INTO public.perception_evidence_envelopes (
    organization_id, schema_version, domain, source_kind, source_sha256,
    evidence_item_id, source_receipt, model_receipt, derivative_receipts,
    status, idempotency_key
  ) VALUES (
    v_assessment.organization_id, 1, 'noise_photo', 'image',
    lower(v_evidence.sha256_hash), v_evidence.id,
    jsonb_build_object(
      'noise_assessment_id', v_assessment.id,
      'evidence_item_id', v_evidence.id,
      'assessed_at', v_assessment.assessed_at,
      'source_site_id', v_assessment.site_id,
      'complainant_site_id', v_assessment.complainant_site_id,
      'storage_bucket', coalesce(v_evidence.metadata->>'storage_bucket', 'scans'),
      'storage_path', v_evidence.storage_path,
      'authoritative_source_preserved', true
    ),
    jsonb_strip_nulls(jsonb_build_object(
      'classifier', coalesce(p_classification->>'classifier', 'bob_vision'),
      'provider', p_classification->'provider',
      'model', p_classification->'model',
      'prompt_version', coalesce(p_classification->>'prompt_version', 'noise_photo_v1'),
      'machine_acoustic_decision_permitted', false,
      'machine_legal_decision_permitted', false
    )),
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'original_path', v_evidence.metadata->>'original_path',
      'watermarked_path', v_evidence.storage_path,
      'original_sha256', v_evidence.metadata->>'raw_sha256',
      'watermarked_sha256', v_evidence.sha256_hash
    ))),
    'manual_review_required', v_key
  )
  RETURNING id INTO v_envelope;

  v_authority := CASE WHEN v_confidence < 0.5 THEN 'insufficient' ELSE 'candidate' END;

  IF v_source IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id,envelope_id,field_key,candidate_ordinal,value_type,
      candidate_value,normalized_value,candidate_payload,raw_confidence,
      source_locations,consensus_rule,authority_state,review_required
    ) VALUES (
      v_assessment.organization_id,v_envelope,'noise.source_candidate',0,'classification',
      to_jsonb(v_source),lower(v_source),
      jsonb_build_object('source','visible_image_classifier','acoustic_decision_permitted',false),
      v_confidence,jsonb_build_array(jsonb_build_object('evidence_item_id',v_evidence.id)),
      'advisory_visible_noise_candidate_human_review_required_v1',v_authority,true
    );
    v_recorded := v_recorded + 1;
  END IF;
  IF v_equipment IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id,envelope_id,field_key,candidate_ordinal,value_type,
      candidate_value,normalized_value,candidate_payload,raw_confidence,
      source_locations,consensus_rule,authority_state,review_required
    ) VALUES (
      v_assessment.organization_id,v_envelope,'noise.equipment_candidate',0,'text',
      to_jsonb(v_equipment),lower(v_equipment),
      jsonb_build_object('source','visible_image_classifier'),
      v_confidence,jsonb_build_array(jsonb_build_object('evidence_item_id',v_evidence.id)),
      'advisory_visible_noise_candidate_human_review_required_v1',v_authority,true
    );
    v_recorded := v_recorded + 1;
  END IF;
  IF v_level IS NOT NULL THEN
    INSERT INTO public.perception_evidence_fields (
      organization_id,envelope_id,field_key,candidate_ordinal,value_type,
      candidate_value,normalized_value,candidate_payload,raw_confidence,
      source_locations,consensus_rule,authority_state,review_required
    ) VALUES (
      v_assessment.organization_id,v_envelope,'noise.estimated_level_candidate',0,'classification',
      to_jsonb(v_level),lower(v_level),
      jsonb_build_object(
        'source','visible_image_classifier',
        'acoustic_measurement',false,
        'excessive_noise_decision_permitted',false
      ),
      v_confidence,jsonb_build_array(jsonb_build_object('evidence_item_id',v_evidence.id)),
      'advisory_visual_only_level_candidate_human_review_required_v1',v_authority,true
    );
    v_recorded := v_recorded + 1;
  END IF;

  RETURN jsonb_build_object(
    'recorded',1,'replayed',0,'envelope_id',v_envelope,'field_candidates',v_recorded
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_noise_photo_perception_envelope(uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_noise_photo_perception_envelope(uuid,jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.review_noise_photo_classification(
  p_assessment_id uuid,
  p_action text,
  p_source_candidate text,
  p_equipment_candidate text,
  p_level_candidate text,
  p_notes text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_assessment public.noise_assessments%ROWTYPE;
  v_envelope uuid;
  v_field public.perception_evidence_fields%ROWTYPE;
  v_action text := lower(trim(coalesce(p_action,'')));
  v_notes text := nullif(trim(coalesce(p_notes,'')),'');
  v_value text;
  v_new_field uuid;
  v_ordinal integer;
BEGIN
  SELECT * INTO v_assessment
  FROM public.noise_assessments
  WHERE id = p_assessment_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Noise assessment is missing'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_assessment.organization_id) THEN
    RAISE EXCEPTION 'Active Noise Control administrator required';
  END IF;
  IF v_action NOT IN ('confirm','correct','reject') THEN
    RAISE EXCEPTION 'Unsupported noise photo review action';
  END IF;
  IF v_notes IS NULL THEN RAISE EXCEPTION 'Review notes are required'; END IF;
  IF jsonb_typeof(v_assessment.noise_ai_analysis) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'This assessment has no structured photo classification to review';
  END IF;
  IF v_action IN ('confirm','correct')
     AND coalesce(v_assessment.noise_ai_analysis->>'status','unavailable') <> 'available' THEN
    RAISE EXCEPTION 'An unavailable machine classification cannot be approved';
  END IF;

  SELECT id INTO v_envelope
  FROM public.perception_evidence_envelopes
  WHERE organization_id = v_assessment.organization_id
    AND domain = 'noise_photo'
    AND source_receipt->>'noise_assessment_id' = v_assessment.id::text
  ORDER BY created_at DESC, id DESC
  LIMIT 1;
  IF v_envelope IS NULL THEN RAISE EXCEPTION 'Noise photo evidence envelope is missing'; END IF;

  FOR v_field IN
    SELECT * FROM public.perception_evidence_fields
    WHERE envelope_id = v_envelope
      AND candidate_ordinal = 0
      AND field_key IN (
        'noise.source_candidate','noise.equipment_candidate','noise.estimated_level_candidate'
      )
    ORDER BY field_key
  LOOP
    IF v_action = 'reject' THEN
      INSERT INTO public.perception_evidence_reviews (
        organization_id,field_id,previous_authority_state,decision,
        next_authority_state,reviewer_notes,canonical_reference,decided_by
      ) VALUES (
        v_assessment.organization_id,v_field.id,v_field.authority_state,'reject',
        'rejected',v_notes,jsonb_build_object('noise_assessment_id',v_assessment.id),v_actor
      );
      UPDATE public.perception_evidence_fields
      SET authority_state='rejected',review_required=false,updated_at=clock_timestamp()
      WHERE id=v_field.id;
      CONTINUE;
    END IF;

    v_value := CASE v_field.field_key
      WHEN 'noise.source_candidate' THEN nullif(trim(coalesce(p_source_candidate,'')),'')
      WHEN 'noise.equipment_candidate' THEN nullif(trim(coalesce(p_equipment_candidate,'')),'')
      WHEN 'noise.estimated_level_candidate' THEN nullif(trim(coalesce(p_level_candidate,'')),'')
    END;
    IF v_value IS NULL THEN CONTINUE; END IF;

    INSERT INTO public.perception_evidence_reviews (
      organization_id,field_id,previous_authority_state,decision,
      next_authority_state,reviewer_notes,canonical_reference,decided_by
    ) VALUES (
      v_assessment.organization_id,v_field.id,v_field.authority_state,'supersede',
      'superseded',v_notes,jsonb_build_object('noise_assessment_id',v_assessment.id),v_actor
    );
    UPDATE public.perception_evidence_fields
    SET authority_state='superseded',review_required=false,updated_at=clock_timestamp()
    WHERE id=v_field.id;

    SELECT coalesce(max(candidate_ordinal),0)+1 INTO v_ordinal
    FROM public.perception_evidence_fields
    WHERE envelope_id=v_envelope AND field_key=v_field.field_key;

    INSERT INTO public.perception_evidence_fields (
      organization_id,envelope_id,field_key,candidate_ordinal,value_type,
      candidate_value,normalized_value,candidate_payload,source_locations,
      consensus_rule,authority_state,review_required
    ) VALUES (
      v_assessment.organization_id,v_envelope,v_field.field_key,v_ordinal,v_field.value_type,
      to_jsonb(v_value),lower(v_value),
      jsonb_build_object('source','human_noise_photo_review','machine_candidate_preserved',true),
      v_field.source_locations,'attributable_human_noise_photo_review_v1','candidate',true
    ) RETURNING id INTO v_new_field;

    INSERT INTO public.perception_evidence_reviews (
      organization_id,field_id,previous_authority_state,decision,
      next_authority_state,reviewer_notes,canonical_reference,decided_by
    ) VALUES (
      v_assessment.organization_id,v_new_field,'candidate',
      CASE WHEN v_action='correct' THEN 'correct' ELSE 'approve' END,
      'human_approved',v_notes,jsonb_build_object('noise_assessment_id',v_assessment.id),v_actor
    );
    UPDATE public.perception_evidence_fields
    SET authority_state='human_approved',review_required=false,updated_at=clock_timestamp()
    WHERE id=v_new_field;
  END LOOP;

  UPDATE public.noise_assessments
  SET noise_ai_review = jsonb_strip_nulls(jsonb_build_object(
        'action',v_action,
        'source_candidate',p_source_candidate,
        'equipment_candidate',p_equipment_candidate,
        'level_candidate',p_level_candidate,
        'notes',v_notes,
        'reviewed_by',v_actor,
        'reviewed_at',clock_timestamp()
      )),
      updated_at=clock_timestamp()
  WHERE id=v_assessment.id;

  INSERT INTO public.audit_log (
    organization_id,actor_user_id,action,target_table,target_id,metadata
  ) VALUES (
    v_assessment.organization_id,v_actor,'noise_photo_classification_reviewed',
    'noise_assessments',v_assessment.id,
    jsonb_build_object(
      'review_action',v_action,
      'acoustic_matrix_changed',false,
      'legal_action_changed',false,
      'notice_changed',false,
      'notes',v_notes
    )
  );

  RETURN jsonb_build_object(
    'assessment_id',v_assessment.id,'action',v_action,
    'reviewed_by',v_actor,'matrix_changed',false,'legal_action_changed',false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.review_noise_photo_classification(uuid,text,text,text,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_noise_photo_classification(uuid,text,text,text,text,text)
  TO authenticated, service_role;