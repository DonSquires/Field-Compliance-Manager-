CREATE TABLE public.person_record_document_types (
  code text PRIMARY KEY, label text NOT NULL, notice_type text,
  CHECK (notice_type IS NULL OR notice_type IN ('trespass', 'warning'))
);
INSERT INTO public.person_record_document_types VALUES
  ('trespass', 'Existing trespass notice', 'trespass'),
  ('warning', 'Existing warning notice', 'warning'),
  ('other', 'Supporting document', NULL);
ALTER TABLE public.person_record_document_types ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.person_record_document_types FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.person_record_document_types TO authenticated;
CREATE POLICY person_document_types_read ON public.person_record_document_types
  FOR SELECT TO authenticated USING (true);

CREATE TABLE public.person_housing_status_definitions (
  code text PRIMARY KEY, label text NOT NULL, requires_verified_identity boolean NOT NULL DEFAULT false
);
INSERT INTO public.person_housing_status_definitions VALUES
  ('none', 'No current homelessness recorded', false),
  ('claiming', 'Person reports homelessness', false),
  ('investigating', 'Welfare circumstances under review', false),
  ('confirmed', 'Homelessness confirmed by reviewer', true);
ALTER TABLE public.person_housing_status_definitions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.person_housing_status_definitions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.person_housing_status_definitions TO authenticated;
CREATE POLICY person_housing_states_read ON public.person_housing_status_definitions
  FOR SELECT TO authenticated USING (true);

CREATE FUNCTION public.person_record_admin_allowed(p_organization_id uuid, p_person_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND public.is_admin_for_org(p_organization_id) AND EXISTS (
    SELECT 1 FROM public.canonical_people cp
    JOIN public.canonical_person_links link ON link.canonical_person_id = cp.id
    JOIN public.person_records pr ON pr.id = link.source_id AND pr.organization_id = link.organization_id
    WHERE cp.id = p_person_id AND cp.status = 'active'
      AND link.source_table = 'person_records' AND link.organization_id = p_organization_id
  )
$$;
REVOKE ALL ON FUNCTION public.person_record_admin_allowed(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.person_record_admin_allowed(uuid, uuid) TO authenticated;

CREATE TABLE public.person_record_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  canonical_person_id uuid NOT NULL REFERENCES public.canonical_people(id),
  document_type text NOT NULL REFERENCES public.person_record_document_types(code),
  file_name text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL,
  file_size_bytes bigint NOT NULL CHECK (file_size_bytes BETWEEN 1 AND 10485760),
  notice_id uuid REFERENCES public.notices(id),
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  client_request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  UNIQUE (organization_id, client_request_id)
);
CREATE INDEX person_record_documents_person_idx
  ON public.person_record_documents(organization_id, canonical_person_id, created_at DESC);
CREATE INDEX person_record_documents_notice_idx ON public.person_record_documents(notice_id) WHERE notice_id IS NOT NULL;
ALTER TABLE public.person_record_documents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.person_record_documents FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.person_record_documents TO authenticated;
CREATE POLICY person_record_documents_read ON public.person_record_documents
  FOR SELECT TO authenticated USING (public.person_record_admin_allowed(organization_id, canonical_person_id));

INSERT INTO storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
VALUES ('person-documents', 'person-documents', false, 10485760,
  ARRAY['application/pdf','image/jpeg','image/png','image/webp'])
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE FUNCTION public.person_document_upload_allowed(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN p_path ~ '^[0-9a-f-]{36}/person/[0-9a-f-]{36}/[0-9a-f-]{36}/source$'
    AND split_part(p_path, '/', 1) ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND split_part(p_path, '/', 3) ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    AND split_part(p_path, '/', 4) ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    THEN public.person_record_admin_allowed(split_part(p_path, '/', 1)::uuid, split_part(p_path, '/', 3)::uuid)
    ELSE false END
$$;
REVOKE ALL ON FUNCTION public.person_document_upload_allowed(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.person_document_upload_allowed(text) TO authenticated, anon;

CREATE FUNCTION public.person_document_read_allowed(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.person_record_documents d WHERE d.storage_path = p_path
    AND public.person_record_admin_allowed(d.organization_id, d.canonical_person_id))
$$;
CREATE FUNCTION public.person_document_orphan_allowed(p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT public.person_document_upload_allowed(p_path)
    AND NOT EXISTS (SELECT 1 FROM public.person_record_documents d WHERE d.storage_path = p_path)
$$;
REVOKE ALL ON FUNCTION public.person_document_read_allowed(text), public.person_document_orphan_allowed(text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.person_document_read_allowed(text), public.person_document_orphan_allowed(text) TO authenticated, anon;

CREATE POLICY person_document_select ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'person-documents' AND public.person_document_read_allowed(name));
CREATE POLICY person_document_select_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (
  bucket_id <> 'person-documents' OR public.person_document_read_allowed(name));
CREATE POLICY person_document_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'person-documents' AND public.person_document_upload_allowed(name));
CREATE POLICY person_document_insert_guard ON storage.objects AS RESTRICTIVE FOR INSERT TO authenticated, anon
  WITH CHECK (bucket_id <> 'person-documents' OR public.person_document_upload_allowed(name));
CREATE POLICY person_document_update_guard ON storage.objects AS RESTRICTIVE FOR UPDATE TO authenticated, anon
  USING (bucket_id <> 'person-documents') WITH CHECK (bucket_id <> 'person-documents');
CREATE POLICY person_document_delete_orphan ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'person-documents' AND public.person_document_orphan_allowed(name));
CREATE POLICY person_document_delete_guard ON storage.objects AS RESTRICTIVE FOR DELETE TO authenticated, anon USING (
  bucket_id <> 'person-documents' OR public.person_document_orphan_allowed(name));

CREATE FUNCTION public.get_person_record_operations(p_organization_id uuid, p_person_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.person_record_admin_allowed(p_organization_id, p_person_id) THEN
    RAISE EXCEPTION 'Person record not found or administrator access denied';
  END IF;
  RETURN jsonb_build_object(
    'verified', EXISTS (
      SELECT 1 FROM public.canonical_people cp
      JOIN public.canonical_person_links link ON link.canonical_person_id = cp.id
      JOIN public.person_records pr ON pr.id = link.source_id AND pr.organization_id = link.organization_id
      WHERE cp.id = p_person_id AND cp.review_state = 'verified' AND pr.review_state = 'verified'
        AND link.organization_id = p_organization_id AND link.source_table = 'person_records'),
    'housing', (SELECT jsonb_build_object('status', cp.homeless_status, 'notes', cp.homeless_notes,
      'verified_at', cp.homeless_verified_at, 'version', cp.updated_at) FROM public.canonical_people cp WHERE cp.id = p_person_id),
    'housing_states', (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.code) FROM public.person_housing_status_definitions s),
    'document_types', (SELECT jsonb_agg(to_jsonb(t) ORDER BY t.code) FROM public.person_record_document_types t),
    'flags', coalesce((SELECT jsonb_agg(jsonb_build_object('id', f.id, 'alert_level', f.alert_level,
      'reason', f.reason, 'raised_at', f.raised_at) ORDER BY f.raised_at DESC)
      FROM public.entity_flags f WHERE f.organization_id = p_organization_id AND f.entity_type = 'person'
        AND f.entity_id = p_person_id AND f.flag_type = 'poi' AND f.hazard_class IS NULL AND f.active), '[]'::jsonb),
    'documents', coalesce((SELECT jsonb_agg(to_jsonb(d) - 'request_payload' ORDER BY d.created_at DESC)
      FROM (SELECT * FROM public.person_record_documents d WHERE d.organization_id = p_organization_id
        AND d.canonical_person_id = p_person_id ORDER BY d.created_at DESC LIMIT 100) d), '[]'::jsonb),
    'document_total', (SELECT count(*) FROM public.person_record_documents d
      WHERE d.organization_id = p_organization_id AND d.canonical_person_id = p_person_id),
    'clients', coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name) ORDER BY o.name)
      FROM public.organizations o WHERE public.org_access_allowed(o.id) AND EXISTS (
        SELECT 1 FROM public.service_agreements a WHERE a.client_organization_id = o.id
          AND a.provider_organization_id = p_organization_id AND a.agreement_type = 'operational'
          AND (a.starts_on IS NULL OR a.starts_on <= current_date) AND (a.ends_on IS NULL OR a.ends_on >= current_date))), '[]'::jsonb)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_person_record_operations(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_person_record_operations(uuid, uuid) TO authenticated;

CREATE FUNCTION public.get_person_interest_summary(p_person_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NOT public.can_search_people() THEN RAISE EXCEPTION 'Person-search authorization required'; END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object('alert_level', f.alert_level, 'organization_name', o.name) ORDER BY f.raised_at DESC)
    FROM public.entity_flags f JOIN public.organizations o ON o.id = f.organization_id
    JOIN public.canonical_people cp ON cp.id = f.entity_id AND cp.status = 'active'
    WHERE f.entity_id = p_person_id AND f.entity_type = 'person' AND f.flag_type = 'poi'
      AND f.hazard_class IS NULL AND f.active AND public.can_search_people(f.organization_id)
  ), '[]'::jsonb);
END;
$$;
REVOKE ALL ON FUNCTION public.get_person_interest_summary(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_person_interest_summary(uuid) TO authenticated;

CREATE INDEX audit_log_person_housing_request_idx
  ON public.audit_log(organization_id, (metadata->>'client_request_id'))
  WHERE action = 'person_housing_status_updated';

CREATE FUNCTION public.update_person_housing_status(
  p_organization_id uuid, p_person_id uuid, p_client_request_id uuid,
  p_expected_version timestamptz, p_status text, p_notes text, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_person public.canonical_people%rowtype;
  v_request jsonb := jsonb_build_object('person_id', p_person_id, 'expected_version', p_expected_version,
    'status', p_status, 'notes', nullif(btrim(p_notes), ''), 'reason', btrim(p_reason));
  v_audit public.audit_log%rowtype;
  v_requires_verified boolean;
  v_previous jsonb;
  v_result jsonb;
BEGIN
  IF NOT public.person_record_admin_allowed(p_organization_id, p_person_id) THEN
    RAISE EXCEPTION 'Person record not found or administrator access denied';
  END IF;
  IF p_client_request_id IS NULL THEN RAISE EXCEPTION 'A request ID is required'; END IF;
  IF coalesce(length(btrim(p_reason)), 0) NOT BETWEEN 5 AND 1000 OR coalesce(length(p_notes), 0) > 2000 THEN
    RAISE EXCEPTION 'Give a reason of 5 to 1000 characters and notes of up to 2000 characters';
  END IF;
  SELECT requires_verified_identity INTO v_requires_verified FROM public.person_housing_status_definitions WHERE code = p_status;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select a configured housing status'; END IF;
  IF v_requires_verified AND NOT (public.get_person_record_operations(p_organization_id, p_person_id)->>'verified')::boolean THEN
    RAISE EXCEPTION 'Verify the person identity before confirming homelessness';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':housing:' || p_client_request_id, 0));
  SELECT * INTO v_audit FROM public.audit_log WHERE organization_id = p_organization_id
    AND action = 'person_housing_status_updated' AND metadata->>'client_request_id' = p_client_request_id::text LIMIT 1;
  IF FOUND THEN
    IF v_audit.metadata->'request' IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'Request ID already used for a different housing update'; END IF;
    RETURN v_audit.metadata->'resulting';
  END IF;
  SELECT * INTO v_person FROM public.canonical_people WHERE id = p_person_id FOR UPDATE;
  IF v_person.updated_at IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'Person record changed; reload before saving'; END IF;
  v_previous := jsonb_build_object('status', v_person.homeless_status, 'notes', v_person.homeless_notes,
    'verified_at', v_person.homeless_verified_at, 'version', v_person.updated_at);
  UPDATE public.canonical_people SET homeless_status = p_status, homeless_notes = nullif(btrim(p_notes), ''),
    homeless_verified_at = CASE WHEN p_status = 'confirmed' THEN clock_timestamp() ELSE NULL END,
    updated_at = clock_timestamp() WHERE id = p_person_id RETURNING * INTO v_person;
  v_result := jsonb_build_object('status', v_person.homeless_status, 'notes', v_person.homeless_notes,
    'verified_at', v_person.homeless_verified_at, 'version', v_person.updated_at);
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, auth.uid(), 'person_housing_status_updated', 'canonical_people', p_person_id,
    jsonb_build_object('client_request_id', p_client_request_id, 'request', v_request, 'previous', v_previous, 'resulting', v_result));
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.update_person_housing_status(uuid, uuid, uuid, timestamptz, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_person_housing_status(uuid, uuid, uuid, timestamptz, text, text, text) TO authenticated;

CREATE FUNCTION public.record_person_document(
  p_organization_id uuid, p_person_id uuid, p_client_request_id uuid, p_document_type text,
  p_file_name text, p_storage_path text, p_sha256 text, p_reason text, p_notice jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_existing public.person_record_documents%rowtype;
  v_type public.person_record_document_types%rowtype;
  v_notice_id uuid;
  v_receipt jsonb;
  v_request jsonb := jsonb_build_object('person_id', p_person_id, 'document_type', p_document_type,
    'file_name', p_file_name, 'storage_path', p_storage_path, 'sha256', p_sha256, 'reason', btrim(p_reason), 'notice', p_notice);
  v_size bigint;
  v_mime text;
  v_owner text;
  v_hash text;
  v_client uuid;
  v_issued timestamptz;
  v_expires timestamptz;
BEGIN
  IF NOT public.person_record_admin_allowed(p_organization_id, p_person_id) THEN
    RAISE EXCEPTION 'Person record not found or administrator access denied';
  END IF;
  IF p_client_request_id IS NULL OR p_storage_path IS DISTINCT FROM
    p_organization_id::text || '/person/' || p_person_id::text || '/' || p_client_request_id::text || '/source' THEN
    RAISE EXCEPTION 'Upload path must match this organisation, person and request';
  END IF;
  IF coalesce(length(p_file_name), 0) NOT BETWEEN 1 AND 255 OR p_file_name ~ '[/\\]'
    OR coalesce(p_sha256, '') !~ '^[0-9a-f]{64}$' OR coalesce(length(btrim(p_reason)), 0) NOT BETWEEN 5 AND 1000 THEN
    RAISE EXCEPTION 'A valid source name, SHA-256 and reason of 5 to 1000 characters are required';
  END IF;
  SELECT * INTO v_type FROM public.person_record_document_types WHERE code = p_document_type;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select a configured document type'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':person-document:' || p_client_request_id, 0));
  SELECT * INTO v_existing FROM public.person_record_documents
    WHERE organization_id = p_organization_id AND client_request_id = p_client_request_id;
  IF FOUND THEN
    IF v_existing.request_payload IS DISTINCT FROM v_request THEN RAISE EXCEPTION 'Request ID already used for a different document'; END IF;
    RETURN to_jsonb(v_existing) - 'request_payload';
  END IF;
  SELECT (o.metadata->>'size')::bigint, o.metadata->>'mimetype', o.owner_id, o.user_metadata->>'sha256'
    INTO v_size, v_mime, v_owner, v_hash FROM storage.objects o
    WHERE o.bucket_id = 'person-documents' AND o.name = p_storage_path;
  IF NOT FOUND OR v_size IS NULL OR v_size NOT BETWEEN 1 AND 10485760
    OR v_mime IS NULL OR v_mime NOT IN ('application/pdf','image/jpeg','image/png','image/webp')
    OR v_owner IS DISTINCT FROM auth.uid()::text OR v_hash IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'Source upload is missing, invalid, or does not match your file';
  END IF;
  IF v_type.notice_type IS NOT NULL THEN
    IF jsonb_typeof(p_notice) IS DISTINCT FROM 'object' OR p_notice->'confirmed' IS DISTINCT FROM 'true'::jsonb
      OR coalesce(p_notice->>'issued_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      OR coalesce(length(btrim(p_notice->>'area')), 0) NOT BETWEEN 1 AND 500
      OR coalesce(length(p_notice->>'notice_number'), 0) > 100
      OR coalesce(length(p_notice->>'source_author'), 0) > 200 THEN
      RAISE EXCEPTION 'Review the existing issued notice, its client, issue date and affected place';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_notice) field
      WHERE field NOT IN ('confirmed','client_organization_id','issued_date','expires_date','notice_number','area','source_author')) THEN
      RAISE EXCEPTION 'Unsupported notice field';
    END IF;
    v_client := (p_notice->>'client_organization_id')::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.service_agreements a WHERE a.provider_organization_id = p_organization_id
      AND a.client_organization_id = v_client AND a.agreement_type = 'operational'
      AND (a.starts_on IS NULL OR a.starts_on <= current_date) AND (a.ends_on IS NULL OR a.ends_on >= current_date)) THEN
      RAISE EXCEPTION 'Select a client with a current operational agreement';
    END IF;
    v_issued := (p_notice->>'issued_date')::date::timestamp AT TIME ZONE 'Pacific/Auckland';
    IF v_issued > clock_timestamp() THEN RAISE EXCEPTION 'The source notice cannot be issued in the future'; END IF;
    IF nullif(p_notice->>'expires_date', '') IS NOT NULL THEN
      v_expires := (p_notice->>'expires_date')::date::timestamp AT TIME ZONE 'Pacific/Auckland';
    END IF;
    SELECT public.import_person_notice(
      p_organization_id => v_client, p_notice_type => v_type.notice_type, p_status => 'issued',
      p_issued_at => v_issued, p_subject_display_name => (SELECT display_name FROM public.canonical_people WHERE id = p_person_id),
      p_source_document_name => p_file_name, p_source_reference => 'storage://person-documents/' || p_storage_path,
      p_source_sha256 => p_sha256, p_import_key => 'person-document:' || p_client_request_id,
      p_expires_at => v_expires, p_canonical_person_id => p_person_id,
      p_notice_number => p_notice->>'notice_number', p_area => p_notice->>'area',
      p_source_author => p_notice->>'source_author') INTO v_receipt;
    v_notice_id := (v_receipt->>'notice_id')::uuid;
    IF v_notice_id IS NULL THEN RAISE EXCEPTION 'No notice receipt returned; document was not recorded'; END IF;
  ELSIF p_notice IS NOT NULL THEN
    RAISE EXCEPTION 'Supporting documents do not issue notices';
  END IF;
  INSERT INTO public.person_record_documents(organization_id, canonical_person_id, document_type, file_name,
    storage_path, sha256, mime_type, file_size_bytes, notice_id, uploaded_by, client_request_id, request_payload)
  VALUES (p_organization_id, p_person_id, p_document_type, p_file_name, p_storage_path, p_sha256,
    v_mime, v_size, v_notice_id, auth.uid(), p_client_request_id, v_request) RETURNING * INTO v_existing;
  INSERT INTO public.audit_log(organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES(p_organization_id, auth.uid(), 'person_document_recorded', 'person_record_documents', v_existing.id,
    jsonb_build_object('client_request_id', p_client_request_id, 'canonical_person_id', p_person_id,
      'notice_id', v_notice_id, 'sha256', p_sha256, 'reason', btrim(p_reason)));
  RETURN to_jsonb(v_existing) - 'request_payload';
END;
$$;
REVOKE ALL ON FUNCTION public.record_person_document(uuid, uuid, uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_person_document(uuid, uuid, uuid, text, text, text, text, text, jsonb) TO authenticated;