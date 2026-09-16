-- CCTV review console: bookmarks that become incidents, and an evidence lock that overrides retention.
--
-- Bookmarks (the XProtect "Incident Manager" idea, on this schema's own spines): a reviewer marks an instant
-- or range on a recording; the mark is an incidents row anchored to the import's place, with the recording
-- attached through incident_attachments. Nothing is written to evidence_items.
--
-- Evidence lock (the XProtect "Evidence Lock" idea): the reviewer seals a recording so retention cannot
-- purge it. It reuses the existing court-ready columns (sha256_hash, is_court_ready, locked_at) and the
-- retention_hold flag. Note: custodian_retention_candidates() currently lists only observations; there is
-- no live evidence_items purge yet, so these columns ARE the hold, and any future purge must test
-- locked_at IS NULL AND NOT retention_hold before deleting. Locking is admin-only and irreversible from
-- the browser; it is refused when the worker has not yet recorded the source hash, because a lock
-- without an integrity hash would be a promise the record cannot keep.

CREATE OR REPLACE FUNCTION public.create_cctv_bookmark(
  p_evidence_id uuid,
  p_at timestamptz,
  p_title text,
  p_notes text DEFAULT NULL,
  p_until timestamptz DEFAULT NULL,
  p_severity text DEFAULT 'standard',
  p_observation_id uuid DEFAULT NULL,
  p_client_request_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_evidence public.evidence_items%rowtype;
  v_import public.cctv_imports%rowtype;
  v_incident uuid;
  v_title text := nullif(trim(coalesce(p_title, '')), '');
  v_severity text := lower(coalesce(nullif(trim(p_severity), ''), 'standard'));
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'A bookmark title is required'; END IF;
  IF p_at IS NULL THEN RAISE EXCEPTION 'A bookmark instant is required'; END IF;
  IF p_until IS NOT NULL AND p_until < p_at THEN RAISE EXCEPTION 'Bookmark end must not precede its start'; END IF;
  IF v_severity NOT IN ('low', 'standard', 'high', 'critical') THEN RAISE EXCEPTION 'Unknown bookmark severity %', p_severity; END IF;

  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = p_evidence_id;
  IF v_evidence.id IS NULL THEN RAISE EXCEPTION 'Recording not found'; END IF;
  IF NOT public.org_access_allowed(v_evidence.organization_id) THEN RAISE EXCEPTION 'CCTV bookmark access denied'; END IF;
  IF v_evidence.cctv_import_id IS NOT NULL THEN
    SELECT * INTO v_import FROM public.cctv_imports WHERE id = v_evidence.cctv_import_id;
  END IF;
  IF p_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cctv_entity_observations o WHERE o.id = p_observation_id AND o.evidence_item_id = v_evidence.id
  ) THEN RAISE EXCEPTION 'Observation does not belong to this recording'; END IF;
  -- incidents_place_anchor_present_chk: an incident is anchored to a place or it is not an incident.
  IF v_import.location_id IS NULL AND v_import.site_id IS NULL AND v_import.zone_id IS NULL THEN
    RAISE EXCEPTION 'This recording is not anchored to a place; import it against a location before bookmarking';
  END IF;

  -- Idempotent on the caller's request id so a retried click cannot double-book.
  IF p_client_request_id IS NOT NULL THEN
    SELECT (a.metadata->>'incident_id')::uuid INTO v_incident
      FROM public.audit_log a
     WHERE a.action = 'cctv_bookmark_created' AND a.metadata->>'client_request_id' = p_client_request_id::text
     LIMIT 1;
    IF v_incident IS NOT NULL THEN
      RETURN jsonb_build_object('incident_id', v_incident, 'deduped', true);
    END IF;
  END IF;

  INSERT INTO public.incidents (organization_id, officer_user_id, location_id, client_site_id, zone_id, canonical_place_id,
                                incident_type, severity, description, status, occurred_at)
  VALUES (v_evidence.organization_id, v_actor, v_import.location_id, v_import.site_id, v_import.zone_id, v_import.canonical_place_id,
          'cctv_bookmark', v_severity,
          v_title || CASE WHEN nullif(trim(coalesce(p_notes, '')), '') IS NULL THEN '' ELSE E'\n\n' || trim(p_notes) END,
          'open', p_at)
  RETURNING id INTO v_incident;

  -- incident_attachments_attachment_kind_check allows photo|video|audio|document|note.
  INSERT INTO public.incident_attachments (organization_id, incident_id, evidence_item_id, attachment_kind)
  VALUES (v_evidence.organization_id, v_incident, v_evidence.id, 'video');

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_evidence.organization_id, v_actor, 'cctv_bookmark_created', 'incidents', v_incident,
          jsonb_strip_nulls(jsonb_build_object(
            'incident_id', v_incident, 'evidence_item_id', v_evidence.id, 'cctv_import_id', v_evidence.cctv_import_id,
            'camera_label', v_import.camera_label, 'bookmark_at', p_at, 'bookmark_until', p_until, 'severity', v_severity,
            'observation_id', p_observation_id, 'client_request_id', p_client_request_id)));

  RETURN jsonb_build_object('incident_id', v_incident, 'deduped', false);
END $$;
REVOKE ALL ON FUNCTION public.create_cctv_bookmark(uuid, timestamptz, text, text, timestamptz, text, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_cctv_bookmark(uuid, timestamptz, text, text, timestamptz, text, uuid, uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.create_cctv_bookmark(uuid, timestamptz, text, text, timestamptz, text, uuid, uuid) IS
  'Reviewer bookmark on a CCTV recording: an incidents row (incident_type cctv_bookmark) anchored to the import place, with the recording attached. Idempotent on p_client_request_id. Audited.';

CREATE OR REPLACE FUNCTION public.lock_cctv_evidence(p_evidence_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_evidence public.evidence_items%rowtype;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF v_reason IS NULL OR char_length(v_reason) < 5 THEN RAISE EXCEPTION 'An evidence lock needs a stated reason (at least 5 characters)'; END IF;

  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = p_evidence_id FOR UPDATE;
  IF v_evidence.id IS NULL THEN RAISE EXCEPTION 'Recording not found'; END IF;
  IF NOT public.is_admin_for_org(v_evidence.organization_id) THEN RAISE EXCEPTION 'Only an administrator of the custodian organisation can lock evidence'; END IF;
  IF v_evidence.locked_at IS NOT NULL THEN
    RETURN jsonb_build_object('evidence_item_id', v_evidence.id, 'locked_at', v_evidence.locked_at, 'already_locked', true);
  END IF;
  IF nullif(trim(coalesce(v_evidence.sha256_hash, '')), '') IS NULL THEN
    RAISE EXCEPTION 'This recording has no integrity hash yet; wait for analysis to record it before locking';
  END IF;

  UPDATE public.evidence_items
     SET is_court_ready = true,
         locked_at = clock_timestamp(),
         retention_hold = true,
         retention_reason = 'evidence_lock: ' || v_reason,
         metadata = metadata || jsonb_build_object('evidence_lock', jsonb_build_object('locked_by', v_actor, 'reason', v_reason, 'locked_at', clock_timestamp()))
   WHERE id = v_evidence.id
   RETURNING * INTO v_evidence;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_evidence.organization_id, v_actor, 'cctv_evidence_locked', 'evidence_items', v_evidence.id,
          jsonb_build_object('reason', v_reason, 'sha256_hash', v_evidence.sha256_hash, 'locked_at', v_evidence.locked_at, 'cctv_import_id', v_evidence.cctv_import_id));

  RETURN jsonb_build_object('evidence_item_id', v_evidence.id, 'locked_at', v_evidence.locked_at, 'already_locked', false);
END $$;
REVOKE ALL ON FUNCTION public.lock_cctv_evidence(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_cctv_evidence(uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.lock_cctv_evidence(uuid, text) IS
  'Admin-only evidence lock for a CCTV recording: sets is_court_ready, locked_at and retention_hold so retention cannot purge it. Refused without a recorded sha256_hash. Audited; not reversible from the browser.';

-- The worker measures the source file; record its hash so locks have an integrity anchor.
CREATE OR REPLACE FUNCTION public.record_cctv_source_hash(p_evidence_id uuid, p_sha256 text, p_size_bytes bigint DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hash text := lower(nullif(trim(coalesce(p_sha256, '')), ''));
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A 64-character hex sha256 is required'; END IF;
  UPDATE public.evidence_items
     SET sha256_hash = coalesce(sha256_hash, v_hash),
         metadata = metadata || jsonb_strip_nulls(jsonb_build_object('source_sha256', v_hash, 'source_size_bytes', p_size_bytes, 'source_hashed_at', clock_timestamp()))
   WHERE id = p_evidence_id AND locked_at IS NULL;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.record_cctv_source_hash(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_source_hash(uuid, text, bigint) TO service_role;
