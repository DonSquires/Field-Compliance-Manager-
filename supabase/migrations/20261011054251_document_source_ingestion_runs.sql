CREATE TABLE public.document_source_ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.document_reference_sources(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE RESTRICT,
  client_request_id uuid NOT NULL,
  mode text NOT NULL DEFAULT 'inventory'
    CHECK (mode IN ('inventory')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'cancel_requested', 'cancelled', 'completed', 'failed')),
  phase text NOT NULL DEFAULT 'enumeration'
    CHECK (phase IN ('enumeration', 'hashing', 'classification', 'extraction', 'comparison', 'promotion')),
  worker_id text,
  lease_token uuid,
  lease_expires_at timestamptz,
  cursor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_count bigint NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  hashed_count bigint NOT NULL DEFAULT 0 CHECK (hashed_count >= 0),
  duplicate_count bigint NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  supported_count bigint NOT NULL DEFAULT 0 CHECK (supported_count >= 0),
  partial_count bigint NOT NULL DEFAULT 0 CHECK (partial_count >= 0),
  gap_count bigint NOT NULL DEFAULT 0 CHECK (gap_count >= 0),
  excluded_count bigint NOT NULL DEFAULT 0 CHECK (excluded_count >= 0),
  quarantined_count bigint NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
  failed_count bigint NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_code text,
  error_detail_redacted text,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (organization_id, requested_by, client_request_id)
);

COMMENT ON TABLE public.document_source_ingestion_runs IS
  'Durable, resumable jobs for approved document_reference_sources. A run starts read-only and records inventory/checkpoint receipts before any extraction or governed promotion.';

CREATE TABLE public.document_source_manifest_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.document_source_ingestion_runs(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.document_reference_sources(id) ON DELETE RESTRICT,
  relative_path text NOT NULL,
  file_name text NOT NULL,
  extension text,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  modified_at timestamptz,
  sha256 text,
  capability_status text NOT NULL DEFAULT 'pending'
    CHECK (capability_status IN ('pending', 'supported', 'partial', 'gap', 'exclude')),
  sensitivity text NOT NULL DEFAULT 'unclassified'
    CHECK (sensitivity IN ('unclassified', 'public', 'internal_non_sensitive', 'tenant_sensitive', 'restricted')),
  disposition text NOT NULL DEFAULT 'pending'
    CHECK (disposition IN ('pending', 'inventory_only', 'ready_for_extraction', 'quarantined', 'excluded', 'failed')),
  extraction_status text NOT NULL DEFAULT 'not_started'
    CHECK (extraction_status IN ('not_started', 'queued', 'running', 'completed', 'failed', 'not_applicable')),
  document_id uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  duplicate_of_entry_id bigint REFERENCES public.document_source_manifest_entries(id) ON DELETE SET NULL,
  error_code text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (run_id, relative_path)
);

COMMENT ON TABLE public.document_source_manifest_entries IS
  'Tenant-scoped metadata manifest for a source run. Paths are relative to the approved source alias; source bytes and absolute workstation paths never enter this table.';

CREATE TABLE public.document_source_run_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.document_source_ingestion_runs(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  phase text,
  counts_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  message_redacted text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.document_source_run_events IS
  'Append-only before/during/after receipts for document source ingestion runs. Messages must not contain credentials, absolute paths, or extracted private content.';

CREATE INDEX document_source_ingestion_runs_queue_idx
  ON public.document_source_ingestion_runs (status, requested_at)
  WHERE status IN ('queued', 'running', 'cancel_requested');
CREATE INDEX document_source_ingestion_runs_org_source_idx
  ON public.document_source_ingestion_runs (organization_id, source_id, requested_at DESC);
CREATE UNIQUE INDEX document_source_ingestion_runs_one_active_source_idx
  ON public.document_source_ingestion_runs (source_id)
  WHERE status IN ('queued', 'running', 'cancel_requested');
CREATE INDEX document_source_manifest_entries_run_status_idx
  ON public.document_source_manifest_entries (run_id, disposition, id);
CREATE INDEX document_source_manifest_entries_org_hash_idx
  ON public.document_source_manifest_entries (organization_id, sha256)
  WHERE sha256 IS NOT NULL;
CREATE INDEX document_source_manifest_entries_source_idx
  ON public.document_source_manifest_entries (source_id, id);
CREATE INDEX document_source_manifest_entries_document_idx
  ON public.document_source_manifest_entries (document_id)
  WHERE document_id IS NOT NULL;
CREATE INDEX document_source_manifest_entries_duplicate_idx
  ON public.document_source_manifest_entries (duplicate_of_entry_id)
  WHERE duplicate_of_entry_id IS NOT NULL;
CREATE INDEX document_source_run_events_run_idx
  ON public.document_source_run_events (run_id, id);
CREATE UNIQUE INDEX document_source_run_events_inventory_requested_idx
  ON public.document_source_run_events (run_id, event_type)
  WHERE event_type = 'inventory_requested';

CREATE TRIGGER document_source_ingestion_runs_touch
  BEFORE UPDATE ON public.document_source_ingestion_runs
  FOR EACH ROW EXECUTE FUNCTION public.bob_documents_touch_updated_at();
CREATE TRIGGER document_source_manifest_entries_touch
  BEFORE UPDATE ON public.document_source_manifest_entries
  FOR EACH ROW EXECUTE FUNCTION public.bob_documents_touch_updated_at();

ALTER TABLE public.document_source_ingestion_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_source_manifest_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_source_run_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY document_source_ingestion_runs_select
  ON public.document_source_ingestion_runs
  FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());

CREATE POLICY document_source_manifest_entries_select
  ON public.document_source_manifest_entries
  FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());

CREATE POLICY document_source_run_events_select
  ON public.document_source_run_events
  FOR SELECT TO authenticated
  USING (public.is_admin_for_org(organization_id) OR public.is_grand_master());

CREATE OR REPLACE FUNCTION public.request_document_source_ingestion(
  p_source_id uuid,
  p_client_request_id uuid,
  p_mode text DEFAULT 'inventory'
)
RETURNS public.document_source_ingestion_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_source public.document_reference_sources%ROWTYPE;
  v_run public.document_source_ingestion_runs%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_client_request_id IS NULL THEN
    RAISE EXCEPTION 'client_request_id is required';
  END IF;
  IF p_mode <> 'inventory' THEN
    RAISE EXCEPTION 'Only read-only inventory is available';
  END IF;

  SELECT * INTO v_source
  FROM public.document_reference_sources
  WHERE id = p_source_id
    AND source_kind = 'local_folder'
    AND approval_status = 'approved'
    AND is_active
  FOR UPDATE;

  IF NOT FOUND OR v_source.organization_id IS NULL THEN
    RAISE EXCEPTION 'Approved tenant local-folder source not found';
  END IF;
  IF NOT (public.is_admin_for_org(v_source.organization_id) OR public.is_grand_master()) THEN
    RAISE EXCEPTION 'Not authorized for this document source';
  END IF;

  SELECT * INTO v_run
  FROM public.document_source_ingestion_runs
  WHERE source_id = v_source.id
    AND status IN ('queued', 'running', 'cancel_requested')
  ORDER BY requested_at
  LIMIT 1;

  IF FOUND THEN
    RETURN v_run;
  END IF;

  INSERT INTO public.document_source_ingestion_runs (
    organization_id,
    source_id,
    requested_by,
    client_request_id,
    mode
  )
  VALUES (
    v_source.organization_id,
    v_source.id,
    v_actor,
    p_client_request_id,
    p_mode
  )
  ON CONFLICT (organization_id, requested_by, client_request_id)
  DO UPDATE SET client_request_id = EXCLUDED.client_request_id
  RETURNING * INTO v_run;

  INSERT INTO public.document_source_run_events (
    organization_id,
    run_id,
    event_type,
    phase,
    message_redacted
  )
  VALUES (
    v_run.organization_id,
    v_run.id,
    'inventory_requested',
    v_run.phase,
    'Read-only source inventory requested.'
  )
  ON CONFLICT (run_id, event_type)
    WHERE event_type = 'inventory_requested'
  DO NOTHING;

  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_document_source_ingestion(
  p_run_id uuid
)
RETURNS public.document_source_ingestion_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.document_source_ingestion_runs%ROWTYPE;
BEGIN
  SELECT * INTO v_run
  FROM public.document_source_ingestion_runs
  WHERE id = p_run_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Document source run not found';
  END IF;
  IF NOT (public.is_admin_for_org(v_run.organization_id) OR public.is_grand_master()) THEN
    RAISE EXCEPTION 'Not authorized for this document source run';
  END IF;
  IF v_run.status IN ('completed', 'failed', 'cancelled') THEN
    RETURN v_run;
  END IF;

  UPDATE public.document_source_ingestion_runs
  SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
      completed_at = CASE WHEN status = 'queued' THEN clock_timestamp() ELSE completed_at END
  WHERE id = p_run_id
  RETURNING * INTO v_run;

  INSERT INTO public.document_source_run_events (
    organization_id,
    run_id,
    event_type,
    phase,
    message_redacted
  )
  VALUES (
    v_run.organization_id,
    v_run.id,
    'cancellation_requested',
    v_run.phase,
    'Document source run cancellation requested.'
  );

  RETURN v_run;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_document_source_ingestion(
  p_worker_id text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS public.document_source_ingestion_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.document_source_ingestion_runs%ROWTYPE;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker_id is required';
  END IF;
  IF p_lease_seconds < 30 OR p_lease_seconds > 600 THEN
    RAISE EXCEPTION 'lease_seconds must be between 30 and 600';
  END IF;

  SELECT * INTO v_run
  FROM public.document_source_ingestion_runs
  WHERE status = 'queued'
     OR (status = 'running' AND lease_expires_at < clock_timestamp())
  ORDER BY requested_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.document_source_ingestion_runs
  SET status = 'running',
      worker_id = p_worker_id,
      lease_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
      started_at = COALESCE(started_at, clock_timestamp()),
      heartbeat_at = clock_timestamp()
  WHERE id = v_run.id
  RETURNING * INTO v_run;

  RETURN v_run;
END;
$$;

REVOKE ALL ON FUNCTION public.request_document_source_ingestion(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.cancel_document_source_ingestion(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_document_source_ingestion(text, integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_document_source_ingestion(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_document_source_ingestion(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_document_source_ingestion(text, integer) TO service_role;

REVOKE ALL ON TABLE public.document_source_ingestion_runs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.document_source_manifest_entries FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.document_source_run_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.document_source_ingestion_runs TO authenticated;
GRANT SELECT ON TABLE public.document_source_manifest_entries TO authenticated;
GRANT SELECT ON TABLE public.document_source_run_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_source_ingestion_runs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.document_source_manifest_entries TO service_role;
GRANT SELECT, INSERT ON TABLE public.document_source_run_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.document_source_manifest_entries_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.document_source_run_events_id_seq TO service_role;