BEGIN;

ALTER TABLE public.observations
  ALTER COLUMN officer_id DROP NOT NULL,
  ALTER COLUMN plate_number DROP NOT NULL;

ALTER TABLE public.observations
  ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL DEFAULT 'vehicle',
  ADD COLUMN IF NOT EXISTS reported_by_name text,
  ADD COLUMN IF NOT EXISTS source_document_name text,
  ADD COLUMN IF NOT EXISTS source_reference text,
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS source_locator text,
  ADD COLUMN IF NOT EXISTS import_key text;

ALTER TABLE public.observations
  DROP CONSTRAINT IF EXISTS observations_subject_kind_check;

ALTER TABLE public.observations
  ADD CONSTRAINT observations_subject_kind_check
  CHECK (subject_kind IN ('vehicle', 'person', 'mixed', 'place', 'other')),
  ADD CONSTRAINT observations_subject_required_check
  CHECK (
    nullif(trim(coalesce(plate_number, '')), '') IS NOT NULL
    OR person_record_id IS NOT NULL
    OR nullif(trim(coalesce(officer_notes, '')), '') IS NOT NULL
  ),
  ADD CONSTRAINT observations_source_sha256_check
  CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS observations_org_import_key_unique
  ON public.observations (organization_id, import_key)
  WHERE import_key IS NOT NULL;

COMMENT ON COLUMN public.observations.subject_kind IS
  'Primary subject of the observed fact. A person, place, or other subject does not require a fabricated vehicle plate.';
COMMENT ON COLUMN public.observations.reported_by_name IS
  'Source-authored officer or reporter name when no FCM user identity can be truthfully linked.';
COMMENT ON COLUMN public.observations.import_key IS
  'Tenant-scoped deterministic key for replay-safe imported observations.';

CREATE OR REPLACE FUNCTION public.sync_observation_to_location_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event_id uuid;
BEGIN
  IF NEW.site_id IS NOT NULL AND NEW.zone_id IS NOT NULL THEN
    RAISE EXCEPTION 'Observation must reference a Site or Zone, not both';
  END IF;

  IF NEW.site_id IS NULL AND NEW.zone_id IS NULL THEN
    INSERT INTO public.event_context_snapshots (
      source_table, source_event_id, location_id, module_key, provider_organization_id,
      client_organization_id, authority_snapshot, source_refs, captured_at
    ) VALUES (
      'observations', NEW.id, NEW.location_id, NEW.module_key, NEW.organization_id,
      NEW.client_org_id, jsonb_build_object(
        'officer_id', NEW.officer_id,
        'reported_by_name', NEW.reported_by_name
      ),
      jsonb_build_object(
        'source', 'observation_trigger',
        'unresolved_reason', 'no_site_or_zone',
        'subject_kind', NEW.subject_kind,
        'source_reference', NEW.source_reference
      ),
      NEW.observed_at
    ) ON CONFLICT (source_table, source_event_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO public.location_events (
    organization_id, client_site_id, zone_id, event_type, module_key, occurred_at,
    status, source, external_ref, payload, observed_entity_type, observed_entity_id, created_by
  ) VALUES (
    NEW.organization_id, NEW.site_id, NEW.zone_id, 'observation', NEW.module_key, NEW.observed_at,
    coalesce(NEW.compliance_status, 'recorded'), 'observation_trigger', NEW.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'observation_id', NEW.id,
      'plate_number', NEW.plate_number,
      'canonical_person_id', NEW.canonical_person_id,
      'compliance_status', NEW.compliance_status,
      'source_reference', NEW.source_reference
    )),
    NEW.subject_kind,
    NEW.id,
    NEW.officer_id
  ) RETURNING id INTO v_event_id;

  INSERT INTO public.event_context_snapshots (
    source_table, source_event_id, location_id, client_site_id, zone_id, module_key,
    provider_organization_id, client_organization_id, authority_snapshot, source_refs, captured_at
  ) VALUES (
    'observations', NEW.id, NEW.location_id, NEW.site_id, NEW.zone_id, NEW.module_key,
    NEW.organization_id, NEW.client_org_id, jsonb_build_object(
      'officer_id', NEW.officer_id,
      'reported_by_name', NEW.reported_by_name
    ),
    jsonb_build_object(
      'location_event_id', v_event_id,
      'source', 'observation_trigger',
      'subject_kind', NEW.subject_kind,
      'source_reference', NEW.source_reference
    ),
    NEW.observed_at
  ) ON CONFLICT (source_table, source_event_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

ALTER TABLE public.notices
  ADD COLUMN IF NOT EXISTS observation_id uuid REFERENCES public.observations(id),
  ADD COLUMN IF NOT EXISTS source_author text,
  ADD COLUMN IF NOT EXISTS source_document_name text,
  ADD COLUMN IF NOT EXISTS source_reference text,
  ADD COLUMN IF NOT EXISTS source_sha256 text,
  ADD COLUMN IF NOT EXISTS import_key text,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.notices
  DROP CONSTRAINT IF EXISTS notices_notice_type_check;

ALTER TABLE public.notices
  ADD CONSTRAINT notices_notice_type_check
  CHECK (notice_type IN (
    'warning',
    'infringement',
    'notice_to_vacate',
    'trespass',
    'abatement',
    'direction',
    'enforcement',
    'biosecurity',
    'smoke'
  )),
  ADD CONSTRAINT notices_source_sha256_check
  CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT notices_metadata_object_check
  CHECK (jsonb_typeof(metadata) = 'object');

CREATE UNIQUE INDEX IF NOT EXISTS notices_org_import_key_unique
  ON public.notices (organization_id, import_key)
  WHERE import_key IS NOT NULL;

COMMENT ON COLUMN public.notices.source_reference IS
  'Governed source reference. Local paths use the approved local:// source alias rather than exposing workstation paths.';
COMMENT ON COLUMN public.notices.import_key IS
  'Tenant-scoped deterministic key for replay-safe imported notices.';

CREATE OR REPLACE FUNCTION public.import_human_authored_trespass_notice(
  p_organization_id uuid,
  p_subject_display_name text,
  p_issued_at timestamptz,
  p_status text,
  p_source_document_name text,
  p_source_reference text,
  p_source_sha256 text,
  p_import_key text,
  p_narrative text DEFAULT NULL,
  p_source_author text DEFAULT NULL,
  p_notice_number text DEFAULT NULL,
  p_legal_basis text DEFAULT NULL,
  p_location_id uuid DEFAULT NULL,
  p_site_id uuid DEFAULT NULL,
  p_zone_id uuid DEFAULT NULL,
  p_source_locator text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_subject text := nullif(trim(coalesce(p_subject_display_name, '')), '');
  v_hash text := lower(nullif(trim(coalesce(p_source_sha256, '')), ''));
  v_key text := nullif(trim(coalesce(p_import_key, '')), '');
  v_notice public.notices%rowtype;
  v_person_record_id uuid;
  v_canonical_person_id uuid;
  v_observation_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_organization_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN
    RAISE EXCEPTION 'Not permitted to import records for this organization';
  END IF;
  IF v_subject IS NULL THEN RAISE EXCEPTION 'Subject display name is required'; END IF;
  IF p_issued_at IS NULL THEN RAISE EXCEPTION 'Issued date is required'; END IF;
  IF p_status NOT IN ('draft', 'issued', 'withdrawn') THEN
    RAISE EXCEPTION 'Unsupported historical notice status %', p_status;
  END IF;
  IF nullif(trim(coalesce(p_source_document_name, '')), '') IS NULL
    OR nullif(trim(coalesce(p_source_reference, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Source document name and governed source reference are required';
  END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'A SHA-256 source hash is required';
  END IF;
  IF v_key IS NULL THEN RAISE EXCEPTION 'A deterministic import key is required'; END IF;
  IF p_location_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.locations l
    WHERE l.id = p_location_id AND l.organization_id = p_organization_id
  ) THEN RAISE EXCEPTION 'Location is not owned by the target organization'; END IF;
  IF p_site_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.client_sites s
    WHERE s.id = p_site_id AND s.client_organization_id = p_organization_id
  ) THEN RAISE EXCEPTION 'Site is not owned by the target organization'; END IF;
  IF p_zone_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.location_zones z
    WHERE z.id = p_zone_id AND z.organization_id = p_organization_id
  ) THEN RAISE EXCEPTION 'Zone is not owned by the target organization'; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_organization_id::text || ':trespass:' || v_key,
    0
  ));

  SELECT * INTO v_notice
  FROM public.notices n
  WHERE n.organization_id = p_organization_id
    AND n.import_key = v_key;

  IF v_notice.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'notice_id', v_notice.id,
      'observation_id', v_notice.observation_id,
      'canonical_person_id', v_notice.person_id,
      'inserted', false
    );
  END IF;

  INSERT INTO public.person_records (
    organization_id,
    display_name,
    review_state,
    metadata
  ) VALUES (
    p_organization_id,
    v_subject,
    'manual_review_required',
    jsonb_strip_nulls(jsonb_build_object(
      'created_from', 'human_authored_trespass_notice',
      'source_document_name', trim(p_source_document_name),
      'source_reference', trim(p_source_reference),
      'source_sha256', v_hash,
      'source_identity_scope', v_key
    ))
  )
  RETURNING id INTO v_person_record_id;

  v_canonical_person_id := public.ensure_canonical_person_for_record(v_person_record_id);

  INSERT INTO public.observations (
    organization_id,
    officer_id,
    plate_number,
    location_id,
    site_id,
    zone_id,
    observed_at,
    module_key,
    plate_source,
    officer_notes,
    compliance_status,
    person_record_id,
    canonical_person_id,
    subject_kind,
    reported_by_name,
    source_document_name,
    source_reference,
    source_sha256,
    source_locator,
    import_key,
    external_refs
  ) VALUES (
    p_organization_id,
    NULL,
    NULL,
    p_location_id,
    p_site_id,
    p_zone_id,
    p_issued_at,
    'security_operations',
    'historical_import',
    coalesce(
      nullif(trim(coalesce(p_narrative, '')), ''),
      'Human-authored source records a trespass notice for ' || v_subject || '.'
    ),
    'unknown',
    v_person_record_id,
    v_canonical_person_id,
    'person',
    nullif(trim(coalesce(p_source_author, '')), ''),
    trim(p_source_document_name),
    trim(p_source_reference),
    v_hash,
    nullif(trim(coalesce(p_source_locator, '')), ''),
    'observation:' || v_key,
    jsonb_build_object(
      'source_system', 'rm_local_folder',
      'notice_import_key', v_key,
      'human_authored', true
    )
  )
  RETURNING id INTO v_observation_id;

  INSERT INTO public.notices (
    organization_id,
    person_id,
    location_id,
    notice_type,
    notice_number,
    legal_basis,
    status,
    authorized_by,
    authorized_at,
    issued_at,
    observation_id,
    source_author,
    source_document_name,
    source_reference,
    source_sha256,
    import_key,
    metadata
  ) VALUES (
    p_organization_id,
    v_canonical_person_id,
    p_location_id,
    'trespass',
    nullif(trim(coalesce(p_notice_number, '')), ''),
    nullif(trim(coalesce(p_legal_basis, '')), ''),
    p_status,
    nullif(trim(coalesce(p_source_author, '')), ''),
    CASE WHEN p_status = 'issued' THEN p_issued_at ELSE NULL END,
    CASE WHEN p_status = 'issued' THEN p_issued_at ELSE NULL END,
    v_observation_id,
    nullif(trim(coalesce(p_source_author, '')), ''),
    trim(p_source_document_name),
    trim(p_source_reference),
    v_hash,
    v_key,
    jsonb_build_object(
      'provenance', 'human_authored_source',
      'identity_review_state', 'manual_review_required',
      'allegation_proven', false,
      'enforcement_authority_inferred', false
    )
  )
  RETURNING * INTO v_notice;

  INSERT INTO public.audit_log (
    organization_id,
    actor_user_id,
    action,
    target_table,
    target_id,
    metadata
  ) VALUES (
    p_organization_id,
    v_actor,
    'human_authored_trespass_notice_imported',
    'notices',
    v_notice.id,
    jsonb_build_object(
      'observation_id', v_observation_id,
      'canonical_person_id', v_canonical_person_id,
      'source_sha256', v_hash,
      'import_key', v_key,
      'status', p_status
    )
  );

  RETURN jsonb_build_object(
    'notice_id', v_notice.id,
    'observation_id', v_observation_id,
    'canonical_person_id', v_canonical_person_id,
    'person_record_id', v_person_record_id,
    'inserted', true
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.import_human_authored_trespass_notice(
  uuid, text, timestamptz, text, text, text, text, text, text, text, text, text,
  uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.import_human_authored_trespass_notice(
  uuid, text, timestamptz, text, text, text, text, text, text, text, text, text,
  uuid, uuid, uuid, text
) TO authenticated, service_role;

COMMIT;