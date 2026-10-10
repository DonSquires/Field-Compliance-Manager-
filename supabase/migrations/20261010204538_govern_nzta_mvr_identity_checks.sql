-- NZTA MVR screenshots are authoritative source evidence for the facts shown at
-- the query time. OCR remains a proposal; an administrator must compare the
-- private source image before any canonical person/vehicle facts are promoted.

ALTER TABLE public.canonical_vehicles
  ADD COLUMN IF NOT EXISTS vin text,
  ADD COLUMN IF NOT EXISTS chassis_number text,
  ADD COLUMN IF NOT EXISTS engine_number text;

COMMENT ON COLUMN public.canonical_vehicles.vin IS
  'Vehicle identification number from a human-reviewed authoritative source. Source-time evidence remains in vehicle_identity_checks.';
COMMENT ON COLUMN public.canonical_vehicles.chassis_number IS
  'Chassis number from a human-reviewed authoritative source. Source-time evidence remains in vehicle_identity_checks.';
COMMENT ON COLUMN public.canonical_vehicles.engine_number IS
  'Engine number from a human-reviewed authoritative source. Source-time evidence remains in vehicle_identity_checks.';

CREATE TABLE public.vehicle_identity_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  canonical_vehicle_id uuid NOT NULL REFERENCES public.canonical_vehicles(id) ON DELETE CASCADE,
  person_record_id uuid NOT NULL REFERENCES public.person_records(id) ON DELETE RESTRICT,
  canonical_person_id uuid NOT NULL REFERENCES public.canonical_people(id) ON DELETE RESTRICT,
  identity_document_id uuid NOT NULL UNIQUE REFERENCES public.person_identity_documents(id) ON DELETE RESTRICT,
  evidence_item_id uuid REFERENCES public.evidence_items(id) ON DELETE RESTRICT,
  source_authority text NOT NULL DEFAULT 'NZTA Motor Vehicle Register',
  checked_at timestamptz NOT NULL,
  relationship text NOT NULL DEFAULT 'registered_person_at_check'
    CHECK (relationship IN ('registered_person_at_check','acquisition_party_at_check','operator_at_check')),
  vehicle_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  reviewed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.vehicle_identity_checks IS
  'Org-scoped, human-reviewed source-time identity checks linking a canonical vehicle, canonical person, private source image, and the exact NZTA MVR snapshot. A historical check does not claim current ownership.';

CREATE INDEX idx_vehicle_identity_checks_vehicle
  ON public.vehicle_identity_checks (organization_id, canonical_vehicle_id, checked_at DESC);
CREATE INDEX idx_vehicle_identity_checks_person
  ON public.vehicle_identity_checks (organization_id, person_record_id, checked_at DESC);

ALTER TABLE public.vehicle_identity_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vehicle_identity_checks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.vehicle_identity_checks TO service_role;

INSERT INTO public.identity_document_type_definitions (
  document_kind, display_name, category, canonical_destination,
  staff_credential_type, default_authorized_activities, strong_identity,
  supports_face_enrollment, extraction_rules, display_order
) VALUES (
  'nzta_mvr_record',
  'NZTA Motor Vehicle Register query result',
  'identity',
  'person_records',
  NULL,
  '{}',
  true,
  false,
  '{
    "indicators":["current details query results","current registered person details","vehicle details","registration details"],
    "required_review_fields":["display_name","plate_number","query_completed_at","person_vehicle_match_confirmed"],
    "authority":"NZTA Motor Vehicle Register",
    "source_time_only":true
  }'::jsonb,
  35
)
ON CONFLICT (document_kind) DO UPDATE SET
  display_name = excluded.display_name,
  category = excluded.category,
  canonical_destination = excluded.canonical_destination,
  staff_credential_type = excluded.staff_credential_type,
  default_authorized_activities = excluded.default_authorized_activities,
  strong_identity = excluded.strong_identity,
  supports_face_enrollment = excluded.supports_face_enrollment,
  extraction_rules = excluded.extraction_rules,
  display_order = excluded.display_order,
  active = true,
  updated_at = clock_timestamp();

CREATE OR REPLACE FUNCTION public.review_nzta_mvr_identity_evidence(
  p_identity_document_id uuid,
  p_action text,
  p_approved_fields jsonb DEFAULT '{}'::jsonb,
  p_review_notes text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_document public.person_identity_documents%rowtype;
  v_person public.person_records%rowtype;
  v_plate text;
  v_checked_at timestamptz;
  v_canonical_person_id uuid;
  v_vehicle_result jsonb;
  v_vehicle_id uuid;
  v_vehicle public.canonical_vehicles%rowtype;
  v_check_id uuid;
  v_result jsonb;
  v_year integer;
  v_vin text := nullif(upper(regexp_replace(trim(coalesce(p_approved_fields->>'vin', '')), '[^A-Z0-9]', '', 'g')), '');
  v_chassis text := nullif(upper(regexp_replace(trim(coalesce(p_approved_fields->>'chassis_number', '')), '[^A-Z0-9-]', '', 'g')), '');
  v_engine text := nullif(upper(regexp_replace(trim(coalesce(p_approved_fields->>'engine_number', '')), '[^A-Z0-9-]', '', 'g')), '');
BEGIN
  SELECT * INTO v_document
  FROM public.person_identity_documents
  WHERE id = p_identity_document_id
  FOR UPDATE;
  IF v_document.id IS NULL OR v_document.document_kind <> 'nzta_mvr_record' THEN
    RAISE EXCEPTION 'NZTA MVR identity evidence not found';
  END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_document.organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;
  IF p_action NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Unsupported identity evidence action';
  END IF;
  IF p_action = 'reject' THEN
    RETURN public.review_canonical_identity_evidence(
      p_identity_document_id, p_action, '{}'::jsonb, p_review_notes
    );
  END IF;
  IF v_document.review_state <> 'manual_review_required' THEN
    RAISE EXCEPTION 'Identity evidence has already been reviewed';
  END IF;
  IF coalesce(p_approved_fields->>'person_vehicle_match_confirmed', '') <> 'true' THEN
    RAISE EXCEPTION 'Confirm that the private source image links this person and vehicle';
  END IF;
  v_plate := public.normalize_plate_number(p_approved_fields->>'plate_number');
  IF v_plate IS NULL OR length(v_plate) > 10 THEN
    RAISE EXCEPTION 'A valid plate from the source image is required';
  END IF;
  v_checked_at := nullif(p_approved_fields->>'query_completed_at', '')::timestamptz;
  IF v_checked_at IS NULL OR v_checked_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'A valid NZTA query completion time is required';
  END IF;
  IF nullif(p_approved_fields->>'vehicle_year', '') IS NOT NULL THEN
    v_year := (p_approved_fields->>'vehicle_year')::integer;
    IF v_year NOT BETWEEN 1886 AND extract(year FROM current_date)::integer + 1 THEN
      RAISE EXCEPTION 'Enter a valid vehicle year';
    END IF;
  END IF;

  SELECT * INTO v_person
  FROM public.person_records
  WHERE id = v_document.person_record_id
    AND organization_id = v_document.organization_id;
  IF v_person.id IS NULL THEN
    RAISE EXCEPTION 'Person record not found in this organization';
  END IF;

  v_result := public.review_canonical_identity_evidence(
    p_identity_document_id, p_action, p_approved_fields, p_review_notes
  );
  v_canonical_person_id := public.ensure_canonical_person_for_record(v_person.id);
  UPDATE public.person_records
  SET review_state = 'verified'
  WHERE id = v_person.id;
  UPDATE public.canonical_people
  SET
    display_name = coalesce(nullif(trim(p_approved_fields->>'display_name'), ''), display_name),
    normalized_name = regexp_replace(
      lower(trim(coalesce(nullif(p_approved_fields->>'display_name', ''), display_name, ''))),
      '[^a-z0-9]+', '', 'g'
    ),
    review_state = 'verified',
    metadata = metadata || jsonb_build_object(
      'last_nzta_mvr_identity_document_id', v_document.id,
      'last_nzta_mvr_checked_at', v_checked_at,
      'last_nzta_mvr_reviewed_by', v_actor
    ),
    updated_at = clock_timestamp()
  WHERE id = v_canonical_person_id;

  v_vehicle_result := public.manage_identity_vehicle(
    v_document.organization_id,
    NULL,
    v_plate,
    jsonb_strip_nulls(jsonb_build_object(
      'make', nullif(trim(p_approved_fields->>'vehicle_make'), ''),
      'model', nullif(trim(p_approved_fields->>'vehicle_model'), ''),
      'year', v_year,
      'colour', nullif(trim(p_approved_fields->>'vehicle_colour'), ''),
      'body_type', nullif(trim(p_approved_fields->>'vehicle_body_type'), ''),
      'rego_expiry', nullif(p_approved_fields->>'rego_expiry', ''),
      'wof_expiry', nullif(p_approved_fields->>'wof_expiry', ''),
      'cof_expiry', nullif(p_approved_fields->>'cof_expiry', ''),
      'notes', nullif(trim(p_approved_fields->>'vehicle_notes'), '')
    )),
    'Human-approved NZTA MVR source image ' || p_identity_document_id::text
  );
  v_vehicle_id := (v_vehicle_result->>'vehicle_id')::uuid;

  SELECT * INTO v_vehicle
  FROM public.canonical_vehicles
  WHERE id = v_vehicle_id
  FOR UPDATE;
  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'Canonical vehicle was not returned';
  END IF;
  IF NOT public.is_grand_master() AND (
    (v_vin IS NOT NULL AND v_vehicle.vin IS NOT NULL AND v_vehicle.vin <> v_vin)
    OR (v_chassis IS NOT NULL AND v_vehicle.chassis_number IS NOT NULL AND v_vehicle.chassis_number <> v_chassis)
    OR (v_engine IS NOT NULL AND v_vehicle.engine_number IS NOT NULL AND v_vehicle.engine_number <> v_engine)
  ) THEN
    RAISE EXCEPTION 'Conflicting canonical vehicle identifiers require grand master review';
  END IF;

  UPDATE public.canonical_vehicles
  SET
    vin = coalesce(v_vin, vin),
    chassis_number = coalesce(v_chassis, chassis_number),
    engine_number = coalesce(v_engine, engine_number),
    fuel_type = coalesce(nullif(trim(p_approved_fields->>'fuel_type'), ''), fuel_type),
    compliance_checked_at = v_checked_at,
    compliance_source = 'nzta_mvr',
    rego_status = CASE
      WHEN lower(coalesce(p_approved_fields->>'registration_status', '')) IN ('active','current') THEN 'current'
      WHEN lower(coalesce(p_approved_fields->>'registration_status', '')) IN ('expired','cancelled','inactive') THEN lower(p_approved_fields->>'registration_status')
      ELSE rego_status
    END,
    wof_status = CASE
      WHEN nullif(p_approved_fields->>'wof_expiry', '')::date >= v_checked_at::date THEN 'current'
      WHEN nullif(p_approved_fields->>'wof_expiry', '') IS NOT NULL THEN 'expired'
      ELSE wof_status
    END,
    cof_status = CASE
      WHEN nullif(p_approved_fields->>'cof_expiry', '')::date >= v_checked_at::date THEN 'current'
      WHEN nullif(p_approved_fields->>'cof_expiry', '') IS NOT NULL THEN 'expired'
      ELSE cof_status
    END,
    updated_at = clock_timestamp()
  WHERE id = v_vehicle_id;

  UPDATE public.person_records
  SET metadata = metadata || jsonb_build_object(
    'profile_details',
    coalesce(metadata->'profile_details', '{}'::jsonb)
      || jsonb_build_object(
        'nzta_mvr_sourced', true,
        'nzta_mvr_last_checked_at', v_checked_at,
        'nzta_mvr_last_identity_document_id', v_document.id
      )
  )
  WHERE id = v_person.id;

  INSERT INTO public.vehicle_identity_checks (
    organization_id, canonical_vehicle_id, person_record_id,
    canonical_person_id, identity_document_id, evidence_item_id,
    checked_at, vehicle_snapshot, reviewed_by
  ) VALUES (
    v_document.organization_id, v_vehicle_id, v_person.id,
    v_canonical_person_id, v_document.id, v_document.evidence_item_id,
    v_checked_at,
    p_approved_fields - ARRAY[
      'address','email','phone','driver_licence_number','firearms_licence_number',
      'security_licence_number','document_number'
    ],
    v_actor
  )
  ON CONFLICT (identity_document_id) DO UPDATE SET
    canonical_vehicle_id = excluded.canonical_vehicle_id,
    person_record_id = excluded.person_record_id,
    canonical_person_id = excluded.canonical_person_id,
    evidence_item_id = excluded.evidence_item_id,
    checked_at = excluded.checked_at,
    vehicle_snapshot = excluded.vehicle_snapshot,
    reviewed_by = excluded.reviewed_by,
    reviewed_at = clock_timestamp()
  RETURNING id INTO v_check_id;

  INSERT INTO public.audit_log (
    organization_id, actor_user_id, action, target_table, target_id, metadata
  ) VALUES (
    v_document.organization_id, v_actor, 'nzta_mvr_identity_check_approved',
    'vehicle_identity_checks', v_check_id,
    jsonb_build_object(
      'canonical_vehicle_id', v_vehicle_id,
      'canonical_person_id', v_canonical_person_id,
      'person_record_id', v_person.id,
      'identity_document_id', v_document.id,
      'evidence_item_id', v_document.evidence_item_id,
      'checked_at', v_checked_at,
      'source_authority', 'NZTA Motor Vehicle Register'
    )
  );

  RETURN v_result || jsonb_build_object(
    'vehicle_identity_check_id', v_check_id,
    'canonical_vehicle_id', v_vehicle_id,
    'canonical_person_id', v_canonical_person_id,
    'nzta_check_completed', true,
    'checked_at', v_checked_at
  );
END;
$function$;

COMMENT ON FUNCTION public.review_nzta_mvr_identity_evidence(uuid,text,jsonb,text) IS
  'Human approval boundary for private NZTA MVR source images. Promotes reviewed vehicle facts, records a source-time person/vehicle link, preserves the evidence link, and audits the decision.';
REVOKE ALL ON FUNCTION public.review_nzta_mvr_identity_evidence(uuid,text,jsonb,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_nzta_mvr_identity_evidence(uuid,text,jsonb,text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_vehicle_identity_checks(
  p_organization_id uuid,
  p_canonical_vehicle_id uuid
) RETURNS TABLE (
  check_id uuid,
  checked_at timestamptz,
  relationship text,
  person_record_id uuid,
  canonical_person_id uuid,
  display_name text,
  identity_document_id uuid,
  evidence_item_id uuid,
  source_authority text,
  vehicle_snapshot jsonb,
  storage_bucket text,
  storage_path text,
  file_name text,
  reviewed_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;
  RETURN QUERY
  SELECT
    checks.id,
    checks.checked_at,
    checks.relationship,
    checks.person_record_id,
    checks.canonical_person_id,
    person.display_name,
    checks.identity_document_id,
    checks.evidence_item_id,
    checks.source_authority,
    checks.vehicle_snapshot,
    attachment.storage_bucket,
    attachment.storage_path,
    attachment.file_name,
    checks.reviewed_at
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

COMMENT ON FUNCTION public.get_vehicle_identity_checks(uuid,uuid) IS
  'Administrator-only vehicle view of human-approved NZTA source-time checks, linked people, and private evidence paths.';
REVOKE ALL ON FUNCTION public.get_vehicle_identity_checks(uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_vehicle_identity_checks(uuid,uuid)
  TO authenticated, service_role;