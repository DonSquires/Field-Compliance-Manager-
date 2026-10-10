-- Shared, versioned evidence receipts for document, CCTV, Desktop and future
-- perception adapters. These rows describe candidates and provenance; they do
-- not replace evidence_items or create identity/legal/enforcement truth.

CREATE TABLE public.perception_model_calibrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain ~ '^[a-z][a-z0-9_]{1,63}$'),
  provider text NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 120),
  model_name text NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 160),
  model_version text NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 160),
  manifest_sha256 text NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  evaluation_set_ref text NOT NULL CHECK (char_length(evaluation_set_ref) BETWEEN 1 AND 500),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  sample_count integer NOT NULL CHECK (sample_count > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','retired')),
  calibrated_at timestamptz NOT NULL,
  expires_at timestamptz,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at IS NULL OR expires_at > calibrated_at)
);

CREATE UNIQUE INDEX perception_model_calibrations_identity_uidx
  ON public.perception_model_calibrations (
    COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid),
    domain, provider, model_name, model_version, manifest_sha256
  );
CREATE INDEX perception_model_calibrations_org_domain_idx
  ON public.perception_model_calibrations (organization_id, domain, status, calibrated_at DESC);

COMMENT ON TABLE public.perception_model_calibrations IS
  'Versioned evaluation receipts for perception models. Approval proves only the recorded evaluation scope; it is not identity, legal, enforcement or commercial authority.';

CREATE TABLE public.perception_evidence_envelopes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  domain text NOT NULL CHECK (domain ~ '^[a-z][a-z0-9_]{1,63}$'),
  source_kind text NOT NULL CHECK (source_kind IN ('document','image','video','audio','sensor','desktop_capture')),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  evidence_item_id uuid REFERENCES public.evidence_items(id) ON DELETE RESTRICT,
  attachment_id uuid REFERENCES public.bob_attachments(id) ON DELETE RESTRICT,
  inference_job_id uuid REFERENCES public.inference_jobs(id) ON DELETE RESTRICT,
  inference_result_id uuid REFERENCES public.inference_results(id) ON DELETE RESTRICT,
  calibration_id uuid REFERENCES public.perception_model_calibrations(id) ON DELETE SET NULL,
  source_receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(source_receipt) = 'object'),
  model_receipt jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(model_receipt) = 'object'),
  derivative_receipts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(derivative_receipts) = 'array'),
  status text NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','complete','manual_review_required','failed','superseded')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 300),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (num_nonnulls(evidence_item_id, attachment_id, inference_job_id, inference_result_id) > 0)
);

CREATE UNIQUE INDEX perception_evidence_envelopes_idempotency_uidx
  ON public.perception_evidence_envelopes (organization_id, idempotency_key);
CREATE INDEX perception_evidence_envelopes_org_status_idx
  ON public.perception_evidence_envelopes (organization_id, domain, status, created_at DESC);
CREATE INDEX perception_evidence_envelopes_evidence_idx
  ON public.perception_evidence_envelopes (evidence_item_id) WHERE evidence_item_id IS NOT NULL;
CREATE INDEX perception_evidence_envelopes_attachment_idx
  ON public.perception_evidence_envelopes (attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX perception_evidence_envelopes_job_idx
  ON public.perception_evidence_envelopes (inference_job_id) WHERE inference_job_id IS NOT NULL;
CREATE INDEX perception_evidence_envelopes_result_idx
  ON public.perception_evidence_envelopes (inference_result_id) WHERE inference_result_id IS NOT NULL;
CREATE INDEX perception_evidence_envelopes_calibration_idx
  ON public.perception_evidence_envelopes (calibration_id) WHERE calibration_id IS NOT NULL;

COMMENT ON TABLE public.perception_evidence_envelopes IS
  'Shared perception provenance envelope. It links immutable source hashes, model/derivative receipts and field candidates to existing canonical evidence and work records.';

CREATE TABLE public.perception_evidence_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  envelope_id uuid NOT NULL REFERENCES public.perception_evidence_envelopes(id) ON DELETE CASCADE,
  field_key text NOT NULL CHECK (field_key ~ '^[a-z][a-z0-9_.]{1,127}$'),
  candidate_ordinal integer NOT NULL DEFAULT 0 CHECK (candidate_ordinal >= 0),
  value_type text NOT NULL CHECK (value_type IN ('identifier','text','number','boolean','entity','measurement','classification')),
  candidate_value text,
  normalized_value text,
  candidate_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(candidate_payload) = 'object'),
  raw_confidence real CHECK (raw_confidence IS NULL OR (raw_confidence >= 0 AND raw_confidence <= 1)),
  calibrated_confidence real CHECK (calibrated_confidence IS NULL OR (calibrated_confidence >= 0 AND calibrated_confidence <= 1)),
  character_confidences jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(character_confidences) = 'array'),
  source_locations jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_locations) = 'array'),
  consensus_rule text,
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(conflicts) = 'array'),
  authority_state text NOT NULL DEFAULT 'candidate'
    CHECK (authority_state IN ('insufficient','candidate','verified_candidate','human_approved','rejected','superseded')),
  review_required boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (envelope_id, field_key, candidate_ordinal),
  CHECK (candidate_value IS NOT NULL OR candidate_payload <> '{}'::jsonb),
  CHECK (authority_state <> 'human_approved' OR review_required = false)
);

CREATE INDEX perception_evidence_fields_org_authority_idx
  ON public.perception_evidence_fields (organization_id, authority_state, review_required, created_at DESC);
CREATE INDEX perception_evidence_fields_envelope_idx
  ON public.perception_evidence_fields (envelope_id, field_key, candidate_ordinal);
CREATE INDEX perception_evidence_fields_normalized_identifier_idx
  ON public.perception_evidence_fields (organization_id, field_key, normalized_value)
  WHERE value_type = 'identifier' AND normalized_value IS NOT NULL;

COMMENT ON TABLE public.perception_evidence_fields IS
  'Field-level candidates, confidence, source locations, conflicts and authority. verified_candidate is machine consensus only; human_approved requires a review receipt.';

CREATE TABLE public.perception_evidence_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES public.perception_evidence_fields(id) ON DELETE RESTRICT,
  previous_authority_state text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approve','reject','uncertain','needs_more_context','supersede')),
  next_authority_state text NOT NULL
    CHECK (next_authority_state IN ('human_approved','rejected','candidate','superseded')),
  reviewer_notes text,
  canonical_reference jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(canonical_reference) = 'object'),
  decided_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX perception_evidence_reviews_field_idx
  ON public.perception_evidence_reviews (field_id, decided_at DESC);
CREATE INDEX perception_evidence_reviews_org_idx
  ON public.perception_evidence_reviews (organization_id, decided_at DESC);

COMMENT ON TABLE public.perception_evidence_reviews IS
  'Append-only human decisions over perception candidates. The current authority state remains on perception_evidence_fields for efficient guarded reads.';

ALTER TABLE public.perception_model_calibrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perception_evidence_envelopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perception_evidence_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.perception_evidence_reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY perception_model_calibrations_select ON public.perception_model_calibrations
  FOR SELECT TO authenticated
  USING (organization_id IS NULL OR public.org_access_allowed(organization_id));
CREATE POLICY perception_evidence_envelopes_select ON public.perception_evidence_envelopes
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));
CREATE POLICY perception_evidence_fields_select ON public.perception_evidence_fields
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));
CREATE POLICY perception_evidence_reviews_select ON public.perception_evidence_reviews
  FOR SELECT TO authenticated
  USING (public.org_access_allowed(organization_id));

REVOKE ALL ON TABLE public.perception_model_calibrations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.perception_evidence_envelopes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.perception_evidence_fields FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.perception_evidence_reviews FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.perception_model_calibrations TO authenticated;
GRANT SELECT ON TABLE public.perception_evidence_envelopes TO authenticated;
GRANT SELECT ON TABLE public.perception_evidence_fields TO authenticated;
GRANT SELECT ON TABLE public.perception_evidence_reviews TO authenticated;
GRANT ALL ON TABLE public.perception_model_calibrations TO service_role;
GRANT ALL ON TABLE public.perception_evidence_envelopes TO service_role;
GRANT ALL ON TABLE public.perception_evidence_fields TO service_role;
GRANT ALL ON TABLE public.perception_evidence_reviews TO service_role;

CREATE OR REPLACE FUNCTION public.record_perception_evidence_envelope(
  p_attachment_id uuid,
  p_idempotency_key text,
  p_payload jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_attachment public.bob_attachments%rowtype;
  v_envelope_id uuid;
  v_field jsonb;
  v_domain text := nullif(trim(p_payload->>'domain'), '');
  v_source_sha256 text := lower(coalesce(p_payload->>'source_sha256', ''));
  v_status text := coalesce(nullif(trim(p_payload->>'status'), ''), 'candidate');
BEGIN
  IF coalesce(auth.jwt()->>'role', '') <> 'service_role'
     AND session_user NOT IN ('postgres','supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_attachment_id IS NULL OR p_idempotency_key IS NULL OR char_length(p_idempotency_key) NOT BETWEEN 8 AND 300 THEN
    RAISE EXCEPTION 'Attachment and idempotency key are required';
  END IF;
  IF jsonb_typeof(p_payload) <> 'object' OR jsonb_typeof(p_payload->'fields') <> 'array' THEN
    RAISE EXCEPTION 'Perception payload and fields array are required';
  END IF;
  IF v_domain IS NULL OR v_domain !~ '^[a-z][a-z0-9_]{1,63}$' OR v_source_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Perception domain or source SHA-256 is invalid';
  END IF;
  IF v_status NOT IN ('candidate','complete','manual_review_required','failed','superseded') THEN
    RAISE EXCEPTION 'Perception envelope status is invalid';
  END IF;

  SELECT * INTO v_attachment FROM public.bob_attachments WHERE id = p_attachment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bob attachment is missing'; END IF;

  SELECT id INTO v_envelope_id
  FROM public.perception_evidence_envelopes
  WHERE organization_id = v_attachment.organization_id
    AND idempotency_key = p_idempotency_key;
  IF v_envelope_id IS NOT NULL THEN RETURN v_envelope_id; END IF;

  INSERT INTO public.perception_evidence_envelopes (
    organization_id, schema_version, domain, source_kind, source_sha256,
    attachment_id, source_receipt, model_receipt, derivative_receipts,
    status, idempotency_key
  ) VALUES (
    v_attachment.organization_id,
    coalesce((p_payload->>'schema_version')::integer, 1),
    v_domain,
    coalesce(nullif(trim(p_payload->>'source_kind'), ''), 'document'),
    v_source_sha256,
    v_attachment.id,
    coalesce(p_payload->'source_receipt', '{}'::jsonb),
    coalesce(p_payload->'model_receipt', '{}'::jsonb),
    coalesce(p_payload->'derivative_receipts', '[]'::jsonb),
    v_status,
    p_idempotency_key
  )
  RETURNING id INTO v_envelope_id;

  FOR v_field IN SELECT value FROM jsonb_array_elements(p_payload->'fields')
  LOOP
    INSERT INTO public.perception_evidence_fields (
      organization_id, envelope_id, field_key, candidate_ordinal, value_type,
      candidate_value, normalized_value, candidate_payload, raw_confidence,
      calibrated_confidence, character_confidences, source_locations,
      consensus_rule, conflicts, authority_state, review_required
    ) VALUES (
      v_attachment.organization_id,
      v_envelope_id,
      trim(v_field->>'field_key'),
      coalesce((v_field->>'candidate_ordinal')::integer, 0),
      coalesce(nullif(trim(v_field->>'value_type'), ''), 'text'),
      nullif(v_field->>'candidate_value', ''),
      nullif(v_field->>'normalized_value', ''),
      coalesce(v_field->'candidate_payload', '{}'::jsonb),
      nullif(v_field->>'raw_confidence', '')::real,
      nullif(v_field->>'calibrated_confidence', '')::real,
      coalesce(v_field->'character_confidences', '[]'::jsonb),
      coalesce(v_field->'source_locations', '[]'::jsonb),
      nullif(v_field->>'consensus_rule', ''),
      coalesce(v_field->'conflicts', '[]'::jsonb),
      coalesce(nullif(v_field->>'authority_state', ''), 'candidate'),
      coalesce((v_field->>'review_required')::boolean, true)
    );
  END LOOP;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_attachment.organization_id, auth.uid(), 'perception_evidence_recorded',
    'perception_evidence_envelopes', v_envelope_id,
    jsonb_build_object('domain', v_domain, 'attachment_id', p_attachment_id, 'schema_version', coalesce((p_payload->>'schema_version')::integer, 1))
  );
  RETURN v_envelope_id;
END;
$$;

COMMENT ON FUNCTION public.record_perception_evidence_envelope(uuid,text,jsonb) IS
  'Service-only, replay-safe writer for field-level perception candidates linked to a Bob attachment. It never approves a candidate.';
REVOKE ALL ON FUNCTION public.record_perception_evidence_envelope(uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_perception_evidence_envelope(uuid,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.review_perception_evidence_field(
  p_field_id uuid,
  p_decision text,
  p_reviewer_notes text DEFAULT NULL,
  p_canonical_reference jsonb DEFAULT '{}'::jsonb
)
RETURNS public.perception_evidence_fields
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_field public.perception_evidence_fields%rowtype;
  v_next text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_field FROM public.perception_evidence_fields WHERE id = p_field_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Perception field is missing'; END IF;
  IF NOT public.is_admin_for_org(v_field.organization_id) THEN
    RAISE EXCEPTION 'Administrator review authority required';
  END IF;
  IF p_decision = 'approve' THEN v_next := 'human_approved';
  ELSIF p_decision = 'reject' THEN v_next := 'rejected';
  ELSIF p_decision IN ('uncertain','needs_more_context') THEN v_next := 'candidate';
  ELSIF p_decision = 'supersede' THEN v_next := 'superseded';
  ELSE RAISE EXCEPTION 'Perception review decision is invalid';
  END IF;
  IF jsonb_typeof(coalesce(p_canonical_reference, '{}'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Canonical reference must be an object';
  END IF;

  INSERT INTO public.perception_evidence_reviews (
    organization_id, field_id, previous_authority_state, decision,
    next_authority_state, reviewer_notes, canonical_reference, decided_by
  ) VALUES (
    v_field.organization_id, v_field.id, v_field.authority_state, p_decision,
    v_next, nullif(trim(p_reviewer_notes), ''), coalesce(p_canonical_reference, '{}'::jsonb), v_actor
  );

  UPDATE public.perception_evidence_fields
  SET authority_state = v_next,
      review_required = (v_next NOT IN ('human_approved','rejected','superseded')),
      updated_at = clock_timestamp()
  WHERE id = v_field.id
  RETURNING * INTO v_field;

  UPDATE public.perception_evidence_envelopes
  SET status = CASE
        WHEN EXISTS (
          SELECT 1 FROM public.perception_evidence_fields f
          WHERE f.envelope_id = v_field.envelope_id AND f.review_required
        ) THEN 'manual_review_required'
        ELSE 'complete'
      END,
      updated_at = clock_timestamp()
  WHERE id = v_field.envelope_id;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_field.organization_id, v_actor, 'perception_evidence_reviewed',
    'perception_evidence_fields', v_field.id,
    jsonb_build_object('decision', p_decision, 'authority_state', v_next, 'canonical_reference', coalesce(p_canonical_reference, '{}'::jsonb))
  );
  RETURN v_field;
END;
$$;

COMMENT ON FUNCTION public.review_perception_evidence_field(uuid,text,text,jsonb) IS
  'Administrator review of one perception candidate. Writes an append-only decision receipt and updates the guarded current authority state.';
REVOKE ALL ON FUNCTION public.review_perception_evidence_field(uuid,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_perception_evidence_field(uuid,text,text,jsonb) TO authenticated;