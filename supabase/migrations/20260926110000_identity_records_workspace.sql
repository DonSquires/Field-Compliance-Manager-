-- Governed identity records for non-staff people and vehicles.
-- Extracted ID fields and face templates are proposals until an authorized human approves them.

ALTER TABLE public.bob_attachments DROP CONSTRAINT IF EXISTS bob_attachments_purpose_check;
ALTER TABLE public.bob_attachments ADD CONSTRAINT bob_attachments_purpose_check
  CHECK (purpose = ANY (ARRAY['document_intake','photo_intake','video_intake','identity_document']));
ALTER TABLE public.bob_attachments DROP CONSTRAINT IF EXISTS bob_attachments_storage_bucket_check;
ALTER TABLE public.bob_attachments ADD CONSTRAINT bob_attachments_storage_bucket_check
  CHECK (storage_bucket = ANY (ARRAY['bob-uploads','identity-evidence']));

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('identity-evidence', 'identity-evidence', false, 26214400,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp','image/bmp','image/tiff'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

DROP POLICY IF EXISTS identity_evidence_select ON storage.objects;
DROP POLICY IF EXISTS identity_evidence_insert ON storage.objects;
DROP POLICY IF EXISTS identity_evidence_update ON storage.objects;
DROP POLICY IF EXISTS identity_evidence_delete ON storage.objects;
CREATE POLICY identity_evidence_select ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'identity-evidence' AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
);
CREATE POLICY identity_evidence_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'identity-evidence' AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
);
CREATE POLICY identity_evidence_update ON storage.objects FOR UPDATE TO authenticated USING (
  bucket_id = 'identity-evidence' AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
) WITH CHECK (
  bucket_id = 'identity-evidence' AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
);
CREATE POLICY identity_evidence_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'identity-evidence' AND (storage.foldername(name))[1] = 'org'
  AND (storage.foldername(name))[2] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND public.is_admin_for_org(((storage.foldername(name))[2])::uuid)
);

DROP POLICY IF EXISTS bob_attachments_select ON public.bob_attachments;
DROP POLICY IF EXISTS bob_attachments_insert ON public.bob_attachments;
DROP POLICY IF EXISTS bob_attachments_update ON public.bob_attachments;
DROP POLICY IF EXISTS bob_full_read ON public.bob_attachments;
CREATE POLICY bob_attachments_select ON public.bob_attachments FOR SELECT USING (
  public.org_access_allowed(organization_id) AND (purpose <> 'identity_document' OR public.is_admin_for_org(organization_id))
);
CREATE POLICY bob_attachments_insert ON public.bob_attachments FOR INSERT WITH CHECK (
  public.org_access_allowed(organization_id) AND (purpose <> 'identity_document' OR public.is_admin_for_org(organization_id))
);
CREATE POLICY bob_attachments_update ON public.bob_attachments FOR UPDATE USING (
  public.org_access_allowed(organization_id) AND (purpose <> 'identity_document' OR public.is_admin_for_org(organization_id))
) WITH CHECK (
  public.org_access_allowed(organization_id) AND (purpose <> 'identity_document' OR public.is_admin_for_org(organization_id))
);
CREATE POLICY bob_full_read ON public.bob_attachments FOR SELECT TO authenticated USING (
  auth.uid() = '00000000-0000-0000-0000-00000000b0b0'::uuid AND purpose <> 'identity_document'
);

ALTER TABLE public.person_identity_documents
  ADD COLUMN IF NOT EXISTS organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS attachment_id uuid REFERENCES public.bob_attachments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_notes text,
  ADD COLUMN IF NOT EXISTS face_confidence real,
  ADD COLUMN IF NOT EXISTS face_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

UPDATE public.person_identity_documents d
SET organization_id = p.organization_id
FROM public.person_records p
WHERE d.organization_id IS NULL AND p.id = d.person_record_id;

CREATE UNIQUE INDEX IF NOT EXISTS person_identity_documents_attachment_uidx
  ON public.person_identity_documents (attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_identity_documents_org_created_idx
  ON public.person_identity_documents (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.person_identity_face_proposals (
  identity_document_id uuid PRIMARY KEY REFERENCES public.person_identity_documents(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  person_record_id uuid NOT NULL REFERENCES public.person_records(id) ON DELETE CASCADE,
  face_vec vector(128) NOT NULL,
  confidence real,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.person_face_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  person_record_id uuid NOT NULL REFERENCES public.person_records(id) ON DELETE CASCADE,
  identity_document_id uuid UNIQUE REFERENCES public.person_identity_documents(id) ON DELETE CASCADE,
  face_vec vector(128) NOT NULL,
  confidence real,
  model text NOT NULL DEFAULT 'sface',
  source_kind text NOT NULL DEFAULT 'identity_document',
  source_ref text NOT NULL,
  retention_reason text NOT NULL,
  approved_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS person_face_templates_org_person_idx
  ON public.person_face_templates (organization_id, person_record_id);
CREATE UNIQUE INDEX IF NOT EXISTS person_face_templates_source_uidx
  ON public.person_face_templates (organization_id, person_record_id, source_kind, source_ref);
ALTER TABLE public.person_identity_face_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_face_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.person_identity_face_proposals FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.person_face_templates FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.person_identity_face_proposals TO service_role;
GRANT ALL ON TABLE public.person_face_templates TO service_role;

COMMENT ON TABLE public.person_identity_face_proposals IS 'Private, non-matchable face proposals. A rejected proposal is deleted; only explicit approval promotes it.';
COMMENT ON TABLE public.person_face_templates IS 'Human-approved, organization-scoped face templates. Vectors are available only inside governed definer/service matching paths.';

INSERT INTO public.person_face_templates (organization_id, person_record_id, face_vec, confidence, model,
  source_kind, source_ref, retention_reason, approved_at)
SELECT record.organization_id, record.id,
  public.cctv_jsonb_to_vector(record.metadata #> '{face_reference,embedding}', 128),
  CASE WHEN jsonb_typeof(record.metadata #> '{face_reference,confidence}') = 'number'
    THEN (record.metadata #>> '{face_reference,confidence}')::real ELSE NULL END,
  coalesce(nullif(record.metadata #>> '{face_reference,model}', ''), 'legacy_face_reference'),
  'legacy_reviewed_reference', record.id::text,
  'Migrated reviewed face reference; retain only while its operational purpose remains',
  coalesce(nullif(record.metadata #>> '{face_reference,reviewed_at}', '')::timestamptz, record.created_at, clock_timestamp())
FROM public.person_records record
WHERE jsonb_typeof(record.metadata #> '{face_reference,embedding}') = 'array'
  AND jsonb_array_length(record.metadata #> '{face_reference,embedding}') = 128
  AND public.cctv_jsonb_to_vector(record.metadata #> '{face_reference,embedding}', 128) IS NOT NULL
ON CONFLICT (organization_id, person_record_id, source_kind, source_ref) DO NOTHING;

UPDATE public.person_records
SET metadata = metadata #- '{face_reference,embedding}'
WHERE metadata #> '{face_reference,embedding}' IS NOT NULL;

REVOKE SELECT ON TABLE public.face_observations FROM anon, authenticated;
GRANT SELECT (id, organization_id, evidence_item_id, person_record_id, confidence, purpose, review_state, created_at)
  ON TABLE public.face_observations TO authenticated;

CREATE OR REPLACE FUNCTION public.get_cctv_face_observation_links(p_organization_id uuid, p_evidence_item_id uuid)
RETURNS TABLE(id uuid, person_record_id uuid, metadata jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT observation.id, observation.person_record_id,
    observation.metadata - ARRAY['embedding','face_embedding','candidate_embedding','appearance_embedding']::text[]
  FROM public.face_observations observation
  WHERE observation.organization_id = p_organization_id
    AND observation.evidence_item_id = p_evidence_item_id
    AND auth.uid() IS NOT NULL
    AND public.org_access_allowed(p_organization_id)
$$;
REVOKE ALL ON FUNCTION public.get_cctv_face_observation_links(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_cctv_face_observation_links(uuid,uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.get_cctv_review_person_records(p_organization_id uuid)
RETURNS TABLE(id uuid, display_name text, review_state text, metadata jsonb)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT person.id, person.display_name, person.review_state,
    person.metadata - 'face_reference' - 'embedding' - 'candidate_embedding' - 'appearance_embedding'
  FROM public.person_records person
  WHERE person.organization_id = p_organization_id
    AND auth.uid() IS NOT NULL
    AND public.org_access_allowed(p_organization_id)
  ORDER BY person.created_at
$$;
REVOKE ALL ON FUNCTION public.get_cctv_review_person_records(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_cctv_review_person_records(uuid) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.refresh_face_observation_candidates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_candidates jsonb;
BEGIN
  IF jsonb_typeof(NEW.metadata->'embedding') <> 'array' THEN RETURN NEW; END IF;
  SELECT coalesce(jsonb_agg(candidate ORDER BY similarity DESC), '[]'::jsonb)
  INTO v_candidates
  FROM (
    SELECT DISTINCT ON (match.person_record_id)
      jsonb_build_object(
        'match_kind', match.match_kind,
        'person_record_id', match.person_record_id,
        'display_name', coalesce(match.display_name, 'Unnamed person'),
        'similarity', round(match.score::numeric, 4),
        'reference_thumbnail', match.thumbnail,
        'review_state', person.review_state
      ) AS candidate,
      match.score AS similarity,
      match.person_record_id
    FROM public.find_cctv_portfolio_matches(NEW.organization_id, 'person', NEW.metadata->'embedding', NULL, NULL, NULL, 10) match
    JOIN public.person_records person ON person.id = match.person_record_id AND person.organization_id = NEW.organization_id
    WHERE match.person_record_id IS NOT NULL
    ORDER BY match.person_record_id, match.score DESC
  ) ranked;
  NEW.metadata := jsonb_set(coalesce(NEW.metadata, '{}'::jsonb), '{candidates}', v_candidates, true);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.refresh_face_observation_candidates() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS face_observations_refresh_candidates ON public.face_observations;
CREATE TRIGGER face_observations_refresh_candidates
BEFORE INSERT OR UPDATE OF metadata ON public.face_observations
FOR EACH ROW EXECUTE FUNCTION public.refresh_face_observation_candidates();

CREATE OR REPLACE FUNCTION public.sync_face_observation_reference()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.assign_face_observation_person(p_observation_id uuid, p_person_record_id uuid, p_display_name text DEFAULT NULL::text)
RETURNS public.face_observations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  observation public.face_observations;
  source_metadata jsonb;
  v_face_vec vector(128);
BEGIN
  IF auth.role() <> 'service_role' AND session_user <> 'postgres' THEN
    IF v_actor IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.face_observations
      WHERE id = p_observation_id AND public.org_access_allowed(organization_id)
    ) THEN RAISE EXCEPTION 'Observation access denied'; END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.face_observations observation
    JOIN public.person_records person ON person.organization_id = observation.organization_id
    WHERE observation.id = p_observation_id AND person.id = p_person_record_id
  ) THEN RAISE EXCEPTION 'Person record does not belong to the observation organization'; END IF;

  SELECT metadata INTO source_metadata FROM public.face_observations WHERE id = p_observation_id;
  IF nullif(trim(p_display_name), '') IS NOT NULL THEN
    UPDATE public.person_records SET display_name = trim(p_display_name) WHERE id = p_person_record_id;
  END IF;
  UPDATE public.person_records
  SET metadata = jsonb_set(metadata, '{face_reference}', jsonb_strip_nulls(jsonb_build_object(
    'thumbnail', source_metadata->>'original_thumbnail',
    'evidence_item_id', source_metadata->>'evidence_item_id',
    'event_id', source_metadata->>'source_event_id'
  )), true)
  WHERE id = p_person_record_id;

  v_face_vec := public.cctv_jsonb_to_vector(source_metadata->'embedding', 128);
  IF v_face_vec IS NOT NULL THEN
    INSERT INTO public.person_face_templates (organization_id, person_record_id, face_vec, confidence, model,
      source_kind, source_ref, retention_reason, approved_by)
    SELECT face.organization_id, p_person_record_id, v_face_vec, face.confidence, 'legacy_face_observation',
      'cctv_face_observation', face.id::text, 'Human-linked CCTV face observation', v_actor
    FROM public.face_observations face WHERE face.id = p_observation_id
    ON CONFLICT (organization_id, person_record_id, source_kind, source_ref) DO NOTHING;
  END IF;

  UPDATE public.face_observations SET person_record_id = p_person_record_id, review_state = 'reviewed'
  WHERE id = p_observation_id RETURNING * INTO observation;
  observation.metadata := observation.metadata - ARRAY['embedding','face_embedding','candidate_embedding','appearance_embedding']::text[];
  RETURN observation;
END;
$$;

CREATE OR REPLACE FUNCTION public.find_cctv_portfolio_matches(p_organization_id uuid, p_entity_kind text, p_face_embedding jsonb DEFAULT NULL::jsonb, p_appearance_embedding jsonb DEFAULT NULL::jsonb, p_plate text DEFAULT NULL::text, p_exclude_observation_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10)
RETURNS TABLE(match_kind text, match_id uuid, observation_id uuid, portfolio_key uuid, display_name text, score real, basis text, last_seen_at timestamptz, canonical_place_id uuid, plate_number text, person_record_id uuid, canonical_vehicle_id uuid, thumbnail text, evidence_item_id uuid, cctv_import_id uuid)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_face public.vector; v_app public.vector; v_plate text; v_n integer := greatest(coalesce(p_limit, 10), 1);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin')
     AND (auth.uid() IS NULL OR NOT public.org_access_allowed(p_organization_id)) THEN
    RAISE EXCEPTION 'CCTV portfolio access denied';
  END IF;
  IF p_entity_kind NOT IN ('person', 'vehicle', 'animal') THEN RAISE EXCEPTION 'Unknown entity kind %', p_entity_kind; END IF;
  v_face := public.cctv_jsonb_to_vector(p_face_embedding, 128);
  v_app := public.cctv_jsonb_to_vector(p_appearance_embedding, 256);
  v_plate := public.normalize_plate_number(p_plate);
  RETURN QUERY
  WITH face_hits AS (
    SELECT 'observation'::text AS match_kind, o.id AS match_id, o.id AS observation_id, o.portfolio_key,
           coalesce(pr.display_name, o.candidate_label)::text AS display_name,
           (1 - (o.face_vec <=> v_face))::real AS score, 'face'::text AS basis, o.observed_at AS last_seen_at,
           o.canonical_place_id, o.candidate_plate::text AS plate_number, o.person_record_id, o.canonical_vehicle_id,
           NULL::text AS thumbnail, o.evidence_item_id, o.cctv_import_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_face IS NOT NULL AND p_entity_kind = 'person'
      AND o.organization_id = p_organization_id AND o.entity_kind = 'person' AND o.face_vec IS NOT NULL
      AND o.review_state NOT IN ('rejected', 'superseded') AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.face_vec <=> v_face LIMIT v_n * 3
  ), identity_face_hits AS (
    SELECT 'person_record'::text, t.id, NULL::uuid, NULL::uuid, pr.display_name::text,
           (1 - (t.face_vec <=> v_face))::real, 'face_identity'::text, t.approved_at,
           NULL::uuid, NULL::text, t.person_record_id, NULL::uuid, NULL::text, d.evidence_item_id, NULL::uuid
    FROM public.person_face_templates t
    JOIN public.person_records pr ON pr.id = t.person_record_id AND pr.organization_id = t.organization_id
    JOIN public.person_identity_documents d ON d.id = t.identity_document_id
    WHERE v_face IS NOT NULL AND p_entity_kind = 'person' AND t.organization_id = p_organization_id
    ORDER BY t.face_vec <=> v_face LIMIT v_n * 3
  ), legacy_face_hits AS (
    SELECT 'person_record'::text, fo.person_record_id, NULL::uuid, NULL::uuid, pr.display_name::text,
           public.face_embedding_cosine(fo.metadata->'embedding', p_face_embedding)::real, 'face_legacy'::text, fo.created_at,
           NULL::uuid, NULL::text, fo.person_record_id, NULL::uuid, NULL::text, NULL::uuid, NULL::uuid
    FROM public.face_observations fo JOIN public.person_records pr ON pr.id = fo.person_record_id
    WHERE p_face_embedding IS NOT NULL AND p_entity_kind = 'person'
      AND fo.organization_id = p_organization_id AND fo.metadata ? 'embedding' AND fo.review_state = 'accepted'
  ), appearance_hits AS (
    SELECT 'observation'::text, o.id, o.id, o.portfolio_key,
           coalesce(cv.plate_number, pr.display_name, o.candidate_label)::text,
           (1 - (o.appearance_vec <=> v_app))::real, 'appearance'::text, o.observed_at,
           o.canonical_place_id, coalesce(cv.plate_number, o.candidate_plate)::text, o.person_record_id, o.canonical_vehicle_id,
           NULL::text, o.evidence_item_id, o.cctv_import_id
    FROM public.cctv_entity_observations o
    LEFT JOIN public.canonical_vehicles cv ON cv.id = o.canonical_vehicle_id
    LEFT JOIN public.person_records pr ON pr.id = o.person_record_id
    WHERE v_app IS NOT NULL AND o.organization_id = p_organization_id AND o.entity_kind = p_entity_kind AND o.appearance_vec IS NOT NULL
      AND o.review_state NOT IN ('rejected', 'superseded') AND (p_exclude_observation_id IS NULL OR o.id <> p_exclude_observation_id)
    ORDER BY o.appearance_vec <=> v_app LIMIT v_n * 3
  ), plate_hits AS (
    SELECT 'canonical_vehicle'::text, cv.id, NULL::uuid, NULL::uuid,
           concat_ws(' ', cv.plate_number, cv.make, cv.model, cv.colour)::text,
           (CASE WHEN cv.plate_number = v_plate THEN 1.0 ELSE extensions.similarity(cv.plate_number, v_plate) END)::real,
           (CASE WHEN cv.plate_number = v_plate THEN 'plate_exact' ELSE 'plate_similar' END)::text, cv.last_seen_at,
           NULL::uuid, cv.plate_number::text, NULL::uuid, cv.id, NULL::text, NULL::uuid, NULL::uuid
    FROM public.canonical_vehicles cv
    WHERE v_plate IS NOT NULL AND p_entity_kind = 'vehicle'
      AND (cv.plate_number = v_plate OR extensions.similarity(cv.plate_number, v_plate) >= 0.6)
    ORDER BY (cv.plate_number = v_plate) DESC, extensions.similarity(cv.plate_number, v_plate) DESC LIMIT v_n
  ), all_hits AS (
    SELECT * FROM face_hits UNION ALL SELECT * FROM identity_face_hits UNION ALL SELECT * FROM legacy_face_hits
    UNION ALL SELECT * FROM appearance_hits UNION ALL SELECT * FROM plate_hits
  )
  SELECT h.match_kind, h.match_id, h.observation_id, h.portfolio_key, h.display_name, h.score, h.basis,
         h.last_seen_at, h.canonical_place_id, h.plate_number, h.person_record_id, h.canonical_vehicle_id,
         h.thumbnail, h.evidence_item_id, h.cctv_import_id
  FROM all_hits h
  WHERE h.score >= CASE h.basis WHEN 'face' THEN 0.65 WHEN 'face_identity' THEN 0.65 WHEN 'face_legacy' THEN 0.65 WHEN 'appearance' THEN 0.70 ELSE 0.60 END
  ORDER BY h.score DESC, h.last_seen_at DESC NULLS LAST LIMIT v_n;
END;
$$;

DROP POLICY IF EXISTS person_identity_documents_select ON public.person_identity_documents;
DROP POLICY IF EXISTS bob_full_read ON public.person_identity_documents;
CREATE POLICY person_identity_documents_select ON public.person_identity_documents
FOR SELECT TO authenticated
USING (organization_id IS NOT NULL AND public.is_admin_for_org(organization_id));

CREATE OR REPLACE FUNCTION public.get_identity_registry(
  p_organization_id uuid,
  p_search text DEFAULT NULL,
  p_limit integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_search text := lower(trim(coalesce(p_search, '')));
  v_limit integer := greatest(1, least(coalesce(p_limit, 100), 250));
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN
    RAISE EXCEPTION 'Identity registry administrator access required';
  END IF;

  RETURN jsonb_build_object(
    'people', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'person_record_id', p.id,
        'canonical_person_id', l.canonical_person_id,
        'display_name', p.display_name,
        'review_state', p.review_state,
        'profile_details', coalesce(p.metadata->'profile_details', '{}'::jsonb),
        'date_of_birth', coalesce(p.metadata->'profile_details'->>'date_of_birth', c.date_of_birth::text),
        'canonical_review_state', c.review_state,
        'face_candidate_ready', EXISTS (
          SELECT 1 FROM public.person_face_templates f
          WHERE f.person_record_id = p.id AND f.organization_id = p.organization_id
        ),
        'document_count', (SELECT count(*) FROM public.person_identity_documents d WHERE d.person_record_id = p.id)
      ) ORDER BY lower(coalesce(p.display_name, '')), p.created_at)
      FROM (SELECT * FROM public.person_records
            WHERE organization_id = p_organization_id
              AND (v_search = '' OR lower(coalesce(display_name, '') || ' ' || coalesce(metadata::text, '')) LIKE '%' || v_search || '%')
            ORDER BY created_at DESC LIMIT v_limit) p
      LEFT JOIN public.canonical_person_links l ON l.source_table = 'person_records' AND l.source_id = p.id
      LEFT JOIN public.canonical_people c ON c.id = l.canonical_person_id
    ), '[]'::jsonb),
    'vehicles', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', v.id, 'plate_number', v.plate_number, 'make', v.make, 'model', v.model,
        'year', v.year, 'colour', v.colour, 'body_type', v.body_type,
        'rego_status', v.rego_status, 'rego_expiry', v.rego_expiry,
        'wof_status', v.wof_status, 'wof_expiry', v.wof_expiry,
        'cof_status', v.cof_status, 'cof_expiry', v.cof_expiry,
        'notes', v.org_notes->p_organization_id::text->>'text',
        'compliance_source', v.compliance_source, 'compliance_checked_at', v.compliance_checked_at
      ) ORDER BY v.plate_number)
      FROM (SELECT * FROM public.canonical_vehicles v
            WHERE (v.org_notes ? p_organization_id::text
              OR EXISTS (SELECT 1 FROM public.canonical_vehicle_links link
                         WHERE link.canonical_vehicle_id = v.id AND link.metadata->>'organization_id' = p_organization_id::text)
              OR EXISTS (SELECT 1 FROM public.cctv_entity_observations o
                         WHERE o.organization_id = p_organization_id AND o.canonical_vehicle_id = v.id))
              AND (v_search = '' OR lower(concat_ws(' ', v.plate_number, v.make, v.model, v.colour, v.body_type)) LIKE '%' || v_search || '%')
            ORDER BY v.updated_at DESC LIMIT v_limit) v
    ), '[]'::jsonb),
    'documents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'id', d.id, 'person_record_id', d.person_record_id, 'evidence_item_id', d.evidence_item_id,
        'attachment_id', d.attachment_id, 'document_kind', d.document_kind,
        'extracted_fields', d.extracted_fields, 'review_state', d.review_state,
        'review_notes', d.review_notes, 'created_at', d.created_at, 'reviewed_at', d.reviewed_at,
        'file_name', a.file_name, 'file_type', a.file_type,
        'storage_bucket', a.storage_bucket, 'storage_path', a.storage_path
      ) ORDER BY d.created_at DESC)
      FROM public.person_identity_documents d
      LEFT JOIN public.bob_attachments a ON a.id = d.attachment_id
      WHERE d.organization_id = p_organization_id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.manage_identity_person(
  p_organization_id uuid,
  p_person_record_id uuid,
  p_action text,
  p_fields jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_person public.person_records%rowtype;
  v_canonical_id uuid;
  v_name text := nullif(trim(p_fields->>'display_name'), '');
  v_dob date;
  v_details jsonb;
  v_canonical_updated boolean := false;
  v_removed integer := 0;
  v_pending_removed integer := 0;
  v_observations_cleared integer := 0;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  IF p_action NOT IN ('create', 'update', 'retire_faces') THEN RAISE EXCEPTION 'Unsupported person action'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF p_action = 'retire_faces' THEN
    IF NOT EXISTS (SELECT 1 FROM public.person_records WHERE id = p_person_record_id AND organization_id = p_organization_id) THEN
      RAISE EXCEPTION 'Person record not found in this organization';
    END IF;
    DELETE FROM public.person_face_templates WHERE organization_id = p_organization_id AND person_record_id = p_person_record_id;
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    DELETE FROM public.person_identity_face_proposals WHERE organization_id = p_organization_id AND person_record_id = p_person_record_id;
    GET DIAGNOSTICS v_pending_removed = ROW_COUNT;
    UPDATE public.cctv_entity_observations SET face_vec = NULL, appearance_vec = NULL,
      candidate_embedding = NULL, appearance_embedding = NULL
    WHERE organization_id = p_organization_id AND person_record_id = p_person_record_id
      AND (face_vec IS NOT NULL OR appearance_vec IS NOT NULL OR candidate_embedding IS NOT NULL OR appearance_embedding IS NOT NULL);
    GET DIAGNOSTICS v_observations_cleared = ROW_COUNT;
    UPDATE public.face_observations SET metadata = metadata - 'embedding'
    WHERE organization_id = p_organization_id AND person_record_id = p_person_record_id AND metadata ? 'embedding';
    UPDATE public.person_records SET metadata = metadata #- '{face_reference,embedding}'
    WHERE id = p_person_record_id AND organization_id = p_organization_id;
    UPDATE public.cctv_entity_observations observation
    SET portfolio_candidates = coalesce((
      SELECT jsonb_agg(candidate)
      FROM jsonb_array_elements(observation.portfolio_candidates) candidate
      WHERE candidate->>'person_record_id' IS DISTINCT FROM p_person_record_id::text
    ), '[]'::jsonb)
    WHERE observation.organization_id = p_organization_id
      AND observation.portfolio_candidates @> jsonb_build_array(jsonb_build_object('person_record_id', p_person_record_id));
    UPDATE public.face_observations observation
    SET metadata = jsonb_set(observation.metadata, '{candidates}', coalesce((
      SELECT jsonb_agg(candidate)
      FROM jsonb_array_elements(coalesce(observation.metadata->'candidates', '[]'::jsonb)) candidate
      WHERE candidate->>'person_record_id' IS DISTINCT FROM p_person_record_id::text
    ), '[]'::jsonb), true)
    WHERE observation.organization_id = p_organization_id
      AND observation.metadata->'candidates' @> jsonb_build_array(jsonb_build_object('person_record_id', p_person_record_id));
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (p_organization_id, v_actor, 'identity_face_candidates_retired', 'person_records', p_person_record_id,
      jsonb_build_object('reason', trim(p_reason), 'templates_removed', v_removed,
        'pending_proposals_removed', v_pending_removed, 'observations_cleared', v_observations_cleared));
    RETURN jsonb_build_object('person_record_id', p_person_record_id, 'face_candidates_removed', v_removed,
      'pending_proposals_removed', v_pending_removed, 'observations_cleared', v_observations_cleared);
  END IF;
  IF v_name IS NULL THEN RAISE EXCEPTION 'Person name is required'; END IF;
  IF nullif(p_fields->>'date_of_birth', '') IS NOT NULL THEN v_dob := (p_fields->>'date_of_birth')::date; END IF;
  v_details := jsonb_strip_nulls(jsonb_build_object(
    'category', nullif(trim(p_fields->>'category'), ''),
    'notes', nullif(trim(p_fields->>'notes'), ''),
    'email', nullif(trim(p_fields->>'email'), ''),
    'phone', nullif(trim(p_fields->>'phone'), ''),
    'address', nullif(trim(p_fields->>'address'), ''),
    'date_of_birth', v_dob,
    'driver_licence_number', nullif(trim(p_fields->>'driver_licence_number'), ''),
    'driver_licence_expiry', nullif(p_fields->>'driver_licence_expiry', '')::date,
    'firearms_licence_number', nullif(trim(p_fields->>'firearms_licence_number'), ''),
    'firearms_licence_expiry', nullif(p_fields->>'firearms_licence_expiry', '')::date
  ));

  IF p_action = 'create' THEN
    INSERT INTO public.person_records (organization_id, display_name, review_state, metadata)
    VALUES (p_organization_id, v_name, 'manual_review_required', jsonb_build_object('profile_details', v_details, 'created_from', 'identity_registry', 'created_by', v_actor))
    RETURNING * INTO v_person;
  ELSE
    SELECT * INTO v_person FROM public.person_records
    WHERE id = p_person_record_id AND organization_id = p_organization_id FOR UPDATE;
    IF v_person.id IS NULL THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
    UPDATE public.person_records SET display_name = v_name,
      metadata = metadata || jsonb_build_object('profile_details', coalesce(metadata->'profile_details', '{}'::jsonb) || v_details)
    WHERE id = v_person.id RETURNING * INTO v_person;
  END IF;

  v_canonical_id := public.ensure_canonical_person_for_record(v_person.id);
  IF NOT EXISTS (
    SELECT 1 FROM public.canonical_person_links
    WHERE canonical_person_id = v_canonical_id AND organization_id IS DISTINCT FROM p_organization_id
  ) THEN
    UPDATE public.canonical_people SET display_name = v_name,
      normalized_name = regexp_replace(lower(v_name), '[^a-z0-9]+', '', 'g'),
      date_of_birth = coalesce(v_dob, date_of_birth), updated_at = clock_timestamp()
    WHERE id = v_canonical_id;
    v_canonical_updated := true;
  END IF;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'identity_person_' || p_action, 'person_records', v_person.id,
    jsonb_build_object('canonical_person_id', v_canonical_id, 'reason', trim(p_reason), 'fields', array(SELECT jsonb_object_keys(p_fields))));
  RETURN jsonb_build_object('person_record_id', v_person.id, 'canonical_person_id', v_canonical_id,
    'display_name', v_name, 'canonical_updated', v_canonical_updated);
END;
$$;

CREATE OR REPLACE FUNCTION public.manage_identity_vehicle(
  p_organization_id uuid,
  p_vehicle_id uuid,
  p_plate text,
  p_fields jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_plate text := public.normalize_plate_number(p_plate);
  v_vehicle_id uuid := p_vehicle_id;
  v_year integer;
  v_note text := nullif(trim(p_fields->>'notes'), '');
  v_vehicle public.canonical_vehicles%rowtype;
  v_existing boolean := false;
  v_related boolean := false;
  v_shared boolean := false;
  v_changes_global_facts boolean := false;
BEGIN
  IF v_actor IS NULL OR NOT public.is_admin_for_org(p_organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  IF coalesce(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required for the identity audit trail'; END IF;
  IF v_plate IS NULL OR length(v_plate) > 10 THEN RAISE EXCEPTION 'Enter a valid plate'; END IF;
  IF nullif(p_fields->>'year', '') IS NOT NULL THEN
    v_year := (p_fields->>'year')::integer;
    IF v_year NOT BETWEEN 1886 AND extract(year FROM current_date)::integer + 1 THEN RAISE EXCEPTION 'Enter a valid vehicle year'; END IF;
  END IF;
  IF v_vehicle_id IS NULL THEN
    SELECT * INTO v_vehicle FROM public.canonical_vehicles WHERE plate_number = v_plate FOR UPDATE;
    v_existing := v_vehicle.id IS NOT NULL;
    IF NOT v_existing THEN
      v_vehicle_id := public.ensure_canonical_vehicle(v_plate, p_fields->>'make', p_fields->>'model', p_fields->>'colour',
        'organization_identity_registry', p_organization_id::text || ':' || v_plate, clock_timestamp());
      SELECT * INTO v_vehicle FROM public.canonical_vehicles WHERE id = v_vehicle_id FOR UPDATE;
    ELSE
      v_vehicle_id := v_vehicle.id;
    END IF;
  ELSE
    SELECT * INTO v_vehicle FROM public.canonical_vehicles WHERE id = v_vehicle_id AND plate_number = v_plate FOR UPDATE;
    v_existing := true;
  END IF;
  IF v_vehicle.id IS NULL THEN
    RAISE EXCEPTION 'Canonical vehicle does not match this plate';
  END IF;
  v_related := v_vehicle.org_notes ? p_organization_id::text
    OR EXISTS (SELECT 1 FROM public.canonical_vehicle_links link WHERE link.canonical_vehicle_id = v_vehicle_id AND link.metadata->>'organization_id' = p_organization_id::text)
    OR EXISTS (SELECT 1 FROM public.cctv_entity_observations observation WHERE observation.canonical_vehicle_id = v_vehicle_id AND observation.organization_id = p_organization_id);
  IF p_vehicle_id IS NOT NULL AND NOT v_related AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Vehicle is outside this organization';
  END IF;
  v_shared := jsonb_object_length(v_vehicle.org_notes - p_organization_id::text) > 0
    OR EXISTS (SELECT 1 FROM public.canonical_vehicle_links link WHERE link.canonical_vehicle_id = v_vehicle_id
      AND link.metadata ? 'organization_id' AND link.metadata->>'organization_id' <> p_organization_id::text)
    OR EXISTS (SELECT 1 FROM public.cctv_entity_observations observation WHERE observation.canonical_vehicle_id = v_vehicle_id AND observation.organization_id <> p_organization_id);
  v_changes_global_facts :=
    (nullif(trim(p_fields->>'make'), '') IS NOT NULL AND nullif(trim(p_fields->>'make'), '') IS DISTINCT FROM v_vehicle.make)
    OR (nullif(trim(p_fields->>'model'), '') IS NOT NULL AND nullif(trim(p_fields->>'model'), '') IS DISTINCT FROM v_vehicle.model)
    OR (v_year IS NOT NULL AND v_year IS DISTINCT FROM v_vehicle.year)
    OR (nullif(trim(p_fields->>'colour'), '') IS NOT NULL AND nullif(trim(p_fields->>'colour'), '') IS DISTINCT FROM v_vehicle.colour)
    OR (nullif(trim(p_fields->>'body_type'), '') IS NOT NULL AND nullif(trim(p_fields->>'body_type'), '') IS DISTINCT FROM v_vehicle.body_type)
    OR (nullif(p_fields->>'rego_expiry', '') IS NOT NULL AND (p_fields->>'rego_expiry')::date IS DISTINCT FROM v_vehicle.rego_expiry)
    OR (nullif(p_fields->>'wof_expiry', '') IS NOT NULL AND (p_fields->>'wof_expiry')::date IS DISTINCT FROM v_vehicle.wof_expiry)
    OR (nullif(p_fields->>'cof_expiry', '') IS NOT NULL AND (p_fields->>'cof_expiry')::date IS DISTINCT FROM v_vehicle.cof_expiry);
  IF v_existing AND (v_shared OR NOT v_related) AND v_changes_global_facts AND NOT public.is_grand_master() THEN
    RAISE EXCEPTION 'Shared canonical vehicle facts require grand master review; organization notes can still be updated';
  END IF;
  UPDATE public.canonical_vehicles SET
    make = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'make'), ''), make) ELSE make END,
    model = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'model'), ''), model) ELSE model END,
    year = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(v_year, year) ELSE year END,
    colour = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'colour'), ''), colour) ELSE colour END,
    body_type = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(trim(p_fields->>'body_type'), ''), body_type) ELSE body_type END,
    rego_expiry = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(p_fields->>'rego_expiry', '')::date, rego_expiry) ELSE rego_expiry END,
    wof_expiry = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(p_fields->>'wof_expiry', '')::date, wof_expiry) ELSE wof_expiry END,
    cof_expiry = CASE WHEN NOT v_existing OR public.is_grand_master() OR (v_related AND NOT v_shared) THEN coalesce(nullif(p_fields->>'cof_expiry', '')::date, cof_expiry) ELSE cof_expiry END,
    org_notes = CASE WHEN v_note IS NULL THEN org_notes - p_organization_id::text
      ELSE jsonb_set(org_notes, ARRAY[p_organization_id::text], jsonb_build_object('text', v_note, 'updated_at', clock_timestamp(), 'updated_by', v_actor), true) END,
    compliance_source = CASE WHEN NOT v_existing OR (v_changes_global_facts AND (public.is_grand_master() OR (v_related AND NOT v_shared))) THEN 'manual' ELSE compliance_source END,
    compliance_checked_at = CASE WHEN NOT v_existing OR (v_changes_global_facts AND (public.is_grand_master() OR (v_related AND NOT v_shared))) THEN clock_timestamp() ELSE compliance_checked_at END,
    updated_at = clock_timestamp()
  WHERE id = v_vehicle_id;
  INSERT INTO public.canonical_vehicle_links (canonical_vehicle_id, source_system, source_table, source_key, metadata)
  VALUES (v_vehicle_id, 'manual_identity_registry', 'organizations', p_organization_id::text || ':' || v_plate,
    jsonb_build_object('organization_id', p_organization_id, 'updated_by', v_actor))
  ON CONFLICT (source_system, source_table, source_key) DO UPDATE SET metadata = excluded.metadata;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'identity_vehicle_upserted', 'canonical_vehicles', v_vehicle_id,
    jsonb_build_object('plate', v_plate, 'reason', trim(p_reason), 'fields', array(SELECT jsonb_object_keys(p_fields))));
  RETURN jsonb_build_object('vehicle_id', v_vehicle_id, 'plate_number', v_plate);
END;
$$;

CREATE OR REPLACE FUNCTION public.identity_actor_can_admin(p_actor_user_id uuid, p_organization_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles profile
    WHERE profile.id = p_actor_user_id
      AND profile.deactivated_at IS NULL
      AND profile.role IN ('grand_master','master','admin')
      AND (
        profile.role = 'grand_master'
        OR (profile.role = 'master' AND (
          p_organization_id = ANY (public.get_descendant_organizations(profile.employer_organization_id))
          OR p_organization_id = ANY (public.get_descendant_organizations(profile.organization_id))
          OR EXISTS (
            SELECT 1 FROM public.service_agreements agreement
            WHERE agreement.agreement_type = 'operational'
              AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
              AND agreement.client_organization_id = p_organization_id
              AND (profile.organization_id = agreement.provider_organization_id OR profile.employer_organization_id = agreement.provider_organization_id)
          )
        ))
        OR (profile.role = 'admin' AND (
          profile.organization_id = p_organization_id
          OR p_organization_id = ANY (public.get_descendant_organizations(profile.organization_id))
          OR EXISTS (
            SELECT 1 FROM public.service_agreements agreement
            WHERE agreement.agreement_type = 'operational'
              AND (agreement.ends_on IS NULL OR agreement.ends_on >= current_date)
              AND agreement.client_organization_id = p_organization_id
              AND (profile.organization_id = agreement.provider_organization_id OR profile.employer_organization_id = agreement.provider_organization_id)
          )
        ))
      )
  )
$$;
REVOKE ALL ON FUNCTION public.identity_actor_can_admin(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.identity_actor_can_admin(uuid,uuid) TO postgres,service_role;

CREATE OR REPLACE FUNCTION public.register_identity_document_proposal(
  p_actor_user_id uuid,
  p_organization_id uuid,
  p_person_record_id uuid,
  p_attachment_id uuid,
  p_document_kind text,
  p_sha256 text,
  p_proposed_fields jsonb,
  p_face_embedding jsonb DEFAULT NULL,
  p_face_confidence real DEFAULT NULL,
  p_face_count integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := p_actor_user_id;
  v_attachment public.bob_attachments%rowtype;
  v_evidence_id uuid;
  v_document_id uuid;
  v_candidate_matches jsonb := '[]'::jsonb;
  v_face_vec vector(128);
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'Service identity required for identity extraction registration';
  END IF;
  IF v_actor IS NULL OR NOT public.identity_actor_can_admin(v_actor, p_organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  IF p_document_kind NOT IN ('driver_licence','firearms_licence','passport','national_id','person_photo','other_identity') THEN RAISE EXCEPTION 'Unsupported identity document kind'; END IF;
  IF p_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Identity document SHA-256 is required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.person_records WHERE id = p_person_record_id AND organization_id = p_organization_id) THEN RAISE EXCEPTION 'Person record not found in this organization'; END IF;
  SELECT * INTO v_attachment FROM public.bob_attachments
  WHERE id = p_attachment_id AND organization_id = p_organization_id AND uploaded_by = v_actor;
  IF v_attachment.id IS NULL THEN RAISE EXCEPTION 'Identity attachment not found for this administrator'; END IF;
    IF v_attachment.purpose <> 'identity_document' OR v_attachment.storage_bucket <> 'identity-evidence'
      OR v_attachment.storage_path NOT LIKE 'org/' || p_organization_id::text || '/identity/' || v_actor::text || '/%' THEN
    RAISE EXCEPTION 'Identity attachment is outside the governed private intake path';
  END IF;
  SELECT id INTO v_document_id FROM public.person_identity_documents WHERE attachment_id = p_attachment_id;
  IF v_document_id IS NOT NULL THEN RETURN jsonb_build_object('identity_document_id', v_document_id, 'duplicate', true); END IF;

  INSERT INTO public.evidence_items (organization_id, module_key, evidence_kind, storage_path, captured_by_user_id, captured_at, sha256_hash, metadata)
  VALUES (p_organization_id, 'identity_registry', 'document', v_attachment.storage_path, v_actor, v_attachment.created_at, p_sha256,
    jsonb_build_object('storage_bucket', v_attachment.storage_bucket, 'file_name', v_attachment.file_name,
      'file_type', v_attachment.file_type, 'file_size_bytes', v_attachment.file_size_bytes,
      'attachment_id', v_attachment.id, 'document_kind', p_document_kind,
      'authority', 'source_document', 'human_review_required', true))
  RETURNING id INTO v_evidence_id;

  IF p_face_count = 1 AND jsonb_typeof(p_face_embedding) = 'array' AND jsonb_array_length(p_face_embedding) = 128 THEN
    v_face_vec := public.cctv_jsonb_to_vector(p_face_embedding, 128);
  END IF;
  IF v_face_vec IS NOT NULL THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'match_kind', match_kind, 'match_id', match_id, 'observation_id', observation_id,
      'display_name', display_name, 'score', score, 'basis', basis, 'last_seen_at', last_seen_at
    ) ORDER BY score DESC), '[]'::jsonb)
    INTO v_candidate_matches
    FROM public.find_cctv_portfolio_matches(p_organization_id, 'person', p_face_embedding, NULL, NULL, NULL, 10);
  END IF;

  INSERT INTO public.person_identity_documents (organization_id, person_record_id, evidence_item_id, attachment_id,
    document_kind, extracted_fields, id_photo_storage_path, review_state, created_by, face_confidence, face_count)
  VALUES (p_organization_id, p_person_record_id, v_evidence_id, p_attachment_id, p_document_kind,
    jsonb_build_object('proposed', coalesce(p_proposed_fields, '{}'::jsonb), 'face_count', greatest(coalesce(p_face_count, 0), 0),
      'candidate_matches', v_candidate_matches, 'ocr_authority', 'advisory', 'review_required', true),
    CASE WHEN v_attachment.file_type LIKE 'image/%' THEN v_attachment.storage_path ELSE NULL END,
    'manual_review_required', v_actor, CASE WHEN v_face_vec IS NOT NULL THEN p_face_confidence ELSE NULL END,
    greatest(coalesce(p_face_count, 0), 0))
  RETURNING id INTO v_document_id;
  IF v_face_vec IS NOT NULL THEN
    INSERT INTO public.person_identity_face_proposals (identity_document_id, organization_id, person_record_id, face_vec, confidence)
    VALUES (v_document_id, p_organization_id, p_person_record_id, v_face_vec, p_face_confidence);
  END IF;
  UPDATE public.bob_attachments SET processing_state = 'manual_review_required', extraction_payload = jsonb_build_object(
    'identity_document_id', v_document_id, 'document_kind', p_document_kind, 'proposed_fields', coalesce(p_proposed_fields, '{}'::jsonb),
    'face_count', greatest(coalesce(p_face_count, 0), 0)), confidence = p_face_confidence WHERE id = p_attachment_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, v_actor, 'identity_document_proposed', 'person_identity_documents', v_document_id,
    jsonb_build_object('person_record_id', p_person_record_id, 'document_kind', p_document_kind, 'attachment_id', p_attachment_id,
      'evidence_item_id', v_evidence_id, 'face_count', greatest(coalesce(p_face_count, 0), 0)));
  RETURN jsonb_build_object('identity_document_id', v_document_id, 'evidence_item_id', v_evidence_id,
    'face_candidate_pending', v_face_vec IS NOT NULL,
    'candidate_matches', v_candidate_matches, 'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.review_identity_document(
  p_identity_document_id uuid,
  p_action text,
  p_approved_fields jsonb DEFAULT '{}'::jsonb,
  p_review_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_document public.person_identity_documents%rowtype;
  v_person public.person_records%rowtype;
  v_canonical_id uuid;
  v_name text;
  v_dob date;
  v_details jsonb;
  v_approved_fields jsonb;
  v_face_proposal public.person_identity_face_proposals%rowtype;
  v_can_verify_identity boolean := false;
  v_canonical_updated boolean := false;
BEGIN
  SELECT * INTO v_document FROM public.person_identity_documents WHERE id = p_identity_document_id FOR UPDATE;
  IF v_document.id IS NULL THEN RAISE EXCEPTION 'Identity document not found'; END IF;
  IF v_actor IS NULL OR NOT public.is_admin_for_org(v_document.organization_id) THEN RAISE EXCEPTION 'Identity registry administrator access required'; END IF;
  IF p_action NOT IN ('approve','reject') THEN RAISE EXCEPTION 'Unsupported identity document review action'; END IF;
  IF v_document.review_state <> 'manual_review_required' THEN RAISE EXCEPTION 'Identity document has already been reviewed'; END IF;
  IF coalesce(trim(p_review_notes), '') = '' THEN RAISE EXCEPTION 'Review notes are required'; END IF;
  SELECT * INTO v_person FROM public.person_records WHERE id = v_document.person_record_id AND organization_id = v_document.organization_id FOR UPDATE;
  IF v_person.id IS NULL THEN RAISE EXCEPTION 'Linked person record not found'; END IF;
  SELECT * INTO v_face_proposal FROM public.person_identity_face_proposals
  WHERE identity_document_id = v_document.id FOR UPDATE;

  IF p_action = 'reject' THEN
    DELETE FROM public.person_identity_face_proposals WHERE identity_document_id = v_document.id;
    UPDATE public.person_identity_documents SET review_state = 'rejected', extracted_fields = extracted_fields - 'candidate_matches', reviewed_by = v_actor,
      reviewed_at = clock_timestamp(), review_notes = trim(p_review_notes), updated_at = clock_timestamp() WHERE id = v_document.id;
  ELSE
    v_name := coalesce(nullif(trim(p_approved_fields->>'display_name'), ''), v_person.display_name);
    IF nullif(p_approved_fields->>'date_of_birth', '') IS NOT NULL THEN v_dob := (p_approved_fields->>'date_of_birth')::date; END IF;
    v_details := jsonb_strip_nulls(jsonb_build_object(
      'category', nullif(trim(p_approved_fields->>'category'), ''),
      'notes', nullif(trim(p_approved_fields->>'notes'), ''),
      'email', nullif(trim(p_approved_fields->>'email'), ''),
      'phone', nullif(trim(p_approved_fields->>'phone'), ''),
      'address', nullif(trim(p_approved_fields->>'address'), ''),
      'date_of_birth', v_dob,
      'driver_licence_number', nullif(trim(p_approved_fields->>'driver_licence_number'), ''),
      'driver_licence_expiry', nullif(p_approved_fields->>'driver_licence_expiry', '')::date,
      'firearms_licence_number', nullif(trim(p_approved_fields->>'firearms_licence_number'), ''),
      'firearms_licence_expiry', nullif(p_approved_fields->>'firearms_licence_expiry', '')::date
    ));
    v_approved_fields := v_details || jsonb_strip_nulls(jsonb_build_object('display_name', v_name, 'date_of_birth', v_dob));
    v_can_verify_identity := v_document.document_kind IN ('driver_licence','firearms_licence','passport','national_id')
      AND (nullif(trim(p_approved_fields->>'display_name'), '') IS NOT NULL
        OR nullif(p_approved_fields->>'date_of_birth', '') IS NOT NULL
        OR nullif(trim(p_approved_fields->>'driver_licence_number'), '') IS NOT NULL
        OR nullif(trim(p_approved_fields->>'firearms_licence_number'), '') IS NOT NULL);
    UPDATE public.person_records SET display_name = v_name,
      review_state = CASE WHEN v_can_verify_identity THEN 'verified' ELSE review_state END,
      metadata = metadata || jsonb_build_object('profile_details', coalesce(metadata->'profile_details', '{}'::jsonb) || v_details,
        'last_identity_document_id', v_document.id, 'identity_evidence_approved_at', clock_timestamp(), 'identity_evidence_approved_by', v_actor)
        || CASE WHEN v_can_verify_identity THEN jsonb_build_object('identity_verified_at', clock_timestamp(), 'identity_verified_by', v_actor) ELSE '{}'::jsonb END
    WHERE id = v_person.id RETURNING * INTO v_person;
    v_canonical_id := public.ensure_canonical_person_for_record(v_person.id);
    IF NOT EXISTS (
      SELECT 1 FROM public.canonical_person_links
      WHERE canonical_person_id = v_canonical_id AND organization_id IS DISTINCT FROM v_document.organization_id
    ) THEN
      UPDATE public.canonical_people SET display_name = v_name,
        normalized_name = regexp_replace(lower(coalesce(v_name, '')), '[^a-z0-9]+', '', 'g'),
        date_of_birth = coalesce(v_dob, date_of_birth),
        review_state = CASE WHEN v_can_verify_identity THEN 'verified' ELSE review_state END,
        updated_at = clock_timestamp()
      WHERE id = v_canonical_id;
      v_canonical_updated := true;
    END IF;
    UPDATE public.person_identity_documents SET review_state = 'approved', extracted_fields = extracted_fields || jsonb_build_object('approved', v_approved_fields),
      reviewed_by = v_actor, reviewed_at = clock_timestamp(), review_notes = trim(p_review_notes), updated_at = clock_timestamp()
    WHERE id = v_document.id;
    IF v_face_proposal.identity_document_id IS NOT NULL THEN
      INSERT INTO public.person_face_templates (organization_id, person_record_id, identity_document_id, face_vec,
        confidence, model, source_kind, source_ref, retention_reason, approved_by)
      VALUES (v_document.organization_id, v_document.person_record_id, v_document.id, v_face_proposal.face_vec,
        v_face_proposal.confidence, 'sface', 'identity_document', v_document.id::text, trim(p_review_notes), v_actor);
      DELETE FROM public.person_identity_face_proposals WHERE identity_document_id = v_document.id;
    END IF;
  END IF;
  UPDATE public.bob_attachments SET processing_state = 'extracted',
    extraction_payload = coalesce(extraction_payload, '{}'::jsonb) || jsonb_build_object(
      'review_state', CASE WHEN p_action = 'approve' THEN 'approved' ELSE 'rejected' END,
      'reviewed_at', clock_timestamp(), 'reviewed_by', v_actor),
    updated_at = clock_timestamp() WHERE id = v_document.attachment_id;
  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_document.organization_id, v_actor, 'identity_document_' || p_action, 'person_identity_documents', v_document.id,
    jsonb_build_object('person_record_id', v_document.person_record_id, 'document_kind', v_document.document_kind, 'review_notes', trim(p_review_notes)));
  RETURN jsonb_build_object('identity_document_id', v_document.id, 'person_record_id', v_document.person_record_id,
    'canonical_person_id', v_canonical_id, 'canonical_updated', v_canonical_updated,
    'identity_verified', v_can_verify_identity, 'face_candidate_enrolled', p_action = 'approve' AND v_face_proposal.identity_document_id IS NOT NULL,
    'review_state', CASE WHEN p_action='approve' THEN 'approved' ELSE 'rejected' END);
END;
$$;

REVOKE ALL ON FUNCTION public.get_identity_registry(uuid,text,integer) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.manage_identity_person(uuid,uuid,text,jsonb,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.manage_identity_vehicle(uuid,uuid,text,jsonb,text) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.register_identity_document_proposal(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,real,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.review_identity_document(uuid,text,jsonb,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_identity_registry(uuid,text,integer) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.manage_identity_person(uuid,uuid,text,jsonb,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.manage_identity_vehicle(uuid,uuid,text,jsonb,text) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.register_identity_document_proposal(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,real,integer) TO postgres,service_role;
GRANT EXECUTE ON FUNCTION public.review_identity_document(uuid,text,jsonb,text) TO authenticated,service_role;

COMMENT ON FUNCTION public.get_identity_registry(uuid,text,integer) IS 'Administrator-only tenant registry of non-staff people, relevant canonical vehicles, and identity-document proposals.';
COMMENT ON FUNCTION public.register_identity_document_proposal(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb,real,integer) IS 'Service-only registration of private identity evidence and provisional OCR/face candidates for an already-authorized administrator. Never updates canonical identity before review.';
COMMENT ON FUNCTION public.review_identity_document(uuid,text,jsonb,text) IS 'Explicit human approval/rejection boundary for identity-document fields and face candidate enrollment.';