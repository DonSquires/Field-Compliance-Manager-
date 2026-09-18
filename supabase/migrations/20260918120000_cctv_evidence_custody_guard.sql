-- CCTV chain of custody: the database refuses to let sealed evidence change, verifies the stored bytes
-- against the sealed hash, and tells a reviewer the custody story of a recording.
--
-- Before this migration a lock (lock_cctv_evidence) was a promise held only by convention: RLS stopped the
-- browser, but any service-role path could still rewrite sha256_hash / storage_path / locked_at or delete
-- the row, nobody ever re-hashed the stored object to prove it still matched, and the worker's playback
-- write replaced the whole metadata document from a stale read — dropping the hash provenance
-- (source_sha256 / source_size_bytes / source_hashed_at) that record_cctv_source_hash had just written.
--
-- What this adds, on the existing spines (no new tables):
--   * zz_evidence_items_custody_guard — BEFORE UPDATE OR DELETE trigger. While a row is sealed (locked_at
--     set): DELETE is refused; the custody fields (locked_at, sha256_hash, storage_path, captured_at,
--     organization_id, cctv_import_id, evidence_kind, is_court_ready, retention_hold) and the provenance
--     metadata keys may not change. On any row, sha256_hash is write-once and a lock transition needs a
--     hash. Test datasets are purged under GUC app.evidence_delete_scope = 'test_dataset_purge', the same
--     convention as zz_place_permanence.
--   * set_cctv_playback_copy (service) — merges the playback keys into metadata atomically.
--   * record_cctv_integrity_check (service) — compares a freshly computed hash of the stored bytes with the
--     sealed hash; records metadata.integrity and an audit_log row (verified / mismatch / unanchored).
--   * cctv_evidence_custody (authenticated, org-scoped) — the custody record: hash, lock, integrity state,
--     and the ordered trail of lock / bookmark / integrity / export events for one recording.

-- ── guard ──
CREATE OR REPLACE FUNCTION public.tg_evidence_items_custody_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_protected_keys text[] := ARRAY['source_sha256', 'source_size_bytes', 'source_hashed_at', 'evidence_lock', 'raw_sha256', 'watermarked_sha256'];
  v_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NULL THEN RETURN OLD; END IF;
    IF current_setting('app.evidence_delete_scope', true) = 'test_dataset_purge' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Evidence % is sealed (locked_at %) and cannot be deleted. Sealed evidence is retained until the lock is released through the custody workflow.', OLD.id, OLD.locked_at
      USING ERRCODE = 'P0001', HINT = 'lock_cctv_evidence sealed this recording; there is no browser path to release it.';
  END IF;

  -- Write-once integrity hash: once any path has measured the bytes, no path may report different bytes.
  IF OLD.sha256_hash IS NOT NULL AND NEW.sha256_hash IS DISTINCT FROM OLD.sha256_hash THEN
    RAISE EXCEPTION 'Evidence % already carries integrity hash %; it cannot be replaced with %. A differing hash is an integrity finding, not a correction.', OLD.id, OLD.sha256_hash, coalesce(NEW.sha256_hash, '<null>')
      USING ERRCODE = 'P0001';
  END IF;

  -- A lock without a hash would be a promise the record cannot keep.
  IF OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL AND nullif(trim(coalesce(NEW.sha256_hash, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Evidence % cannot be sealed without an integrity hash.', OLD.id USING ERRCODE = 'P0001';
  END IF;

  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;

  -- Sealed: the custody fields are frozen.
  IF NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
    RAISE EXCEPTION 'Evidence % is sealed; locked_at may not be cleared or moved.', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF NEW.sha256_hash IS DISTINCT FROM OLD.sha256_hash
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.captured_at IS DISTINCT FROM OLD.captured_at
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.cctv_import_id IS DISTINCT FROM OLD.cctv_import_id
     OR NEW.evidence_kind IS DISTINCT FROM OLD.evidence_kind THEN
    RAISE EXCEPTION 'Evidence % is sealed; its hash, storage path, capture time, organisation, import and kind are frozen.', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.is_court_ready AND NOT NEW.is_court_ready THEN
    RAISE EXCEPTION 'Evidence % is sealed; court-ready status cannot be withdrawn.', OLD.id USING ERRCODE = 'P0001';
  END IF;
  IF OLD.retention_hold AND NOT NEW.retention_hold THEN
    RAISE EXCEPTION 'Evidence % is sealed; the retention hold cannot be released while the evidence lock stands.', OLD.id USING ERRCODE = 'P0001';
  END IF;
  FOREACH v_key IN ARRAY v_protected_keys LOOP
    IF (NEW.metadata -> v_key) IS DISTINCT FROM (OLD.metadata -> v_key) THEN
      RAISE EXCEPTION 'Evidence % is sealed; provenance metadata "%" is frozen.', OLD.id, v_key USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.tg_evidence_items_custody_guard() FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.tg_evidence_items_custody_guard() IS
  'Chain-of-custody guard for evidence_items: sealed rows (locked_at set) cannot be deleted or have custody fields/provenance changed; sha256_hash is write-once; a lock needs a hash. Test purge via app.evidence_delete_scope = test_dataset_purge.';

DROP TRIGGER IF EXISTS zz_evidence_items_custody_guard ON public.evidence_items;
CREATE TRIGGER zz_evidence_items_custody_guard
  BEFORE UPDATE OR DELETE ON public.evidence_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_evidence_items_custody_guard();

-- ── playback copy: merge, never replace ──
CREATE OR REPLACE FUNCTION public.set_cctv_playback_copy(p_evidence_id uuid, p_playback jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_allowed jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF p_playback IS NULL OR jsonb_typeof(p_playback) <> 'object' THEN RAISE EXCEPTION 'Playback details must be a JSON object'; END IF;
  -- Only the playback keys may arrive through this path; the source provenance is untouchable here.
  SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb) INTO v_allowed
    FROM jsonb_each(p_playback)
   WHERE key IN ('playback_storage_path', 'playback_content_type', 'playback_transcode_profile', 'playback_source_codec', 'playback_source_preserved', 'playback_prepared_at');
  IF v_allowed = '{}'::jsonb THEN RAISE EXCEPTION 'No playback keys supplied'; END IF;
  UPDATE public.evidence_items
     SET metadata = metadata || v_allowed || jsonb_build_object('playback_prepared_at', coalesce(v_allowed->>'playback_prepared_at', clock_timestamp()::text))
   WHERE id = p_evidence_id;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.set_cctv_playback_copy(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_cctv_playback_copy(uuid, jsonb) TO service_role;
COMMENT ON FUNCTION public.set_cctv_playback_copy(uuid, jsonb) IS
  'Service-only: merges the derived playback-copy keys into evidence_items.metadata (jsonb ||) so the source hash provenance recorded moments earlier is never overwritten by a stale read.';

-- ── integrity verification ──
CREATE OR REPLACE FUNCTION public.record_cctv_integrity_check(p_evidence_id uuid, p_sha256_observed text, p_size_bytes bigint DEFAULT NULL, p_checked_by text DEFAULT 'vision_worker')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_observed text := lower(nullif(trim(coalesce(p_sha256_observed, '')), ''));
  v_evidence public.evidence_items%rowtype;
  v_expected text;
  v_state text;
  v_checked_at timestamptz := clock_timestamp();
  v_record jsonb;
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF v_observed IS NULL OR v_observed !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A 64-character hex sha256 is required'; END IF;
  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = p_evidence_id FOR UPDATE;
  IF v_evidence.id IS NULL THEN RAISE EXCEPTION 'Recording not found'; END IF;

  v_expected := lower(coalesce(v_evidence.sha256_hash, v_evidence.metadata->>'source_sha256'));
  v_state := CASE WHEN v_expected IS NULL THEN 'unanchored' WHEN v_expected = v_observed THEN 'verified' ELSE 'mismatch' END;
  v_record := jsonb_strip_nulls(jsonb_build_object(
    'state', v_state, 'checked_at', v_checked_at, 'checked_by', p_checked_by,
    'observed_sha256', v_observed, 'expected_sha256', v_expected, 'observed_size_bytes', p_size_bytes,
    'check_count', coalesce((v_evidence.metadata->'integrity'->>'check_count')::int, 0) + 1,
    'first_verified_at', CASE WHEN v_state = 'verified' THEN coalesce((v_evidence.metadata->'integrity'->>'first_verified_at')::timestamptz, v_checked_at) ELSE (v_evidence.metadata->'integrity'->>'first_verified_at')::timestamptz END,
    'mismatch_count', coalesce((v_evidence.metadata->'integrity'->>'mismatch_count')::int, 0) + CASE WHEN v_state = 'mismatch' THEN 1 ELSE 0 END
  ));

  UPDATE public.evidence_items SET metadata = metadata || jsonb_build_object('integrity', v_record) WHERE id = v_evidence.id;

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (v_evidence.organization_id, NULL,
          CASE v_state WHEN 'verified' THEN 'cctv_evidence_integrity_verified' WHEN 'mismatch' THEN 'cctv_evidence_integrity_mismatch' ELSE 'cctv_evidence_integrity_unanchored' END,
          'evidence_items', v_evidence.id,
          v_record || jsonb_strip_nulls(jsonb_build_object('cctv_import_id', v_evidence.cctv_import_id, 'locked_at', v_evidence.locked_at, 'storage_path', v_evidence.storage_path)));

  RETURN jsonb_build_object('evidence_item_id', v_evidence.id, 'state', v_state, 'expected_sha256', v_expected, 'observed_sha256', v_observed, 'checked_at', v_checked_at);
END $$;
REVOKE ALL ON FUNCTION public.record_cctv_integrity_check(uuid, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_integrity_check(uuid, text, bigint, text) TO service_role;
COMMENT ON FUNCTION public.record_cctv_integrity_check(uuid, text, bigint, text) IS
  'Service-only: compares a fresh hash of the stored bytes with the sealed/recorded hash. Writes metadata.integrity (state verified|mismatch|unanchored, counts, timestamps) and an audit_log row. Never changes the sealed hash.';

-- ── source hash: genuinely write-once ──
-- The previous body kept the column with coalesce() but still rewrote metadata.source_sha256 with whatever
-- was passed, so a second measurement could leave the column and the provenance disagreeing. Now a repeat
-- of the same hash refreshes provenance, a different hash is refused (FOUND = false) for the caller to report
-- through record_cctv_integrity_check, and a sealed row is never touched.
CREATE OR REPLACE FUNCTION public.record_cctv_source_hash(p_evidence_id uuid, p_sha256 text, p_size_bytes bigint DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_hash text := lower(nullif(trim(coalesce(p_sha256, '')), ''));
BEGIN
  IF auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Service identity required'; END IF;
  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A 64-character hex sha256 is required'; END IF;
  UPDATE public.evidence_items
     SET sha256_hash = v_hash,
         metadata = metadata || jsonb_strip_nulls(jsonb_build_object('source_sha256', v_hash, 'source_size_bytes', p_size_bytes, 'source_hashed_at', clock_timestamp()))
   WHERE id = p_evidence_id AND locked_at IS NULL AND (sha256_hash IS NULL OR lower(sha256_hash) = v_hash);
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.record_cctv_source_hash(uuid, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cctv_source_hash(uuid, text, bigint) TO service_role;
COMMENT ON FUNCTION public.record_cctv_source_hash(uuid, text, bigint) IS
  'Service-only, write-once: records the sha256 (and size/time provenance) of the stored source bytes. Repeating the same hash refreshes provenance; a different hash or a sealed row changes nothing and returns false.';

-- ── custody record for the console ──
CREATE OR REPLACE FUNCTION public.cctv_evidence_custody(p_evidence_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_evidence public.evidence_items%rowtype;
  v_events jsonb;
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = p_evidence_id;
  IF v_evidence.id IS NULL THEN RAISE EXCEPTION 'Recording not found'; END IF;
  IF NOT public.org_access_allowed(v_evidence.organization_id) THEN RAISE EXCEPTION 'CCTV custody access denied'; END IF;

  SELECT coalesce(jsonb_agg(event ORDER BY (event->>'at')::timestamptz), '[]'::jsonb) INTO v_events
  FROM (
    SELECT jsonb_build_object('at', a.created_at, 'kind', a.action, 'actor_user_id', a.actor_user_id,
             'detail', CASE a.action
               WHEN 'cctv_evidence_locked' THEN jsonb_build_object('reason', a.metadata->>'reason', 'sha256_hash', a.metadata->>'sha256_hash')
               WHEN 'cctv_bookmark_created' THEN jsonb_build_object('incident_id', a.metadata->>'incident_id', 'bookmark_at', a.metadata->>'bookmark_at', 'severity', a.metadata->>'severity')
               WHEN 'cctv_evidence_integrity_verified' THEN jsonb_build_object('checked_by', a.metadata->>'checked_by', 'check_count', a.metadata->>'check_count')
               WHEN 'cctv_evidence_integrity_mismatch' THEN jsonb_build_object('checked_by', a.metadata->>'checked_by', 'observed_sha256', a.metadata->>'observed_sha256', 'expected_sha256', a.metadata->>'expected_sha256')
               ELSE '{}'::jsonb END) AS event
      FROM public.audit_log a
     WHERE a.organization_id = v_evidence.organization_id
       AND ((a.target_table = 'evidence_items' AND a.target_id = v_evidence.id)
            OR (a.action = 'cctv_bookmark_created' AND (a.metadata->>'evidence_item_id')::uuid = v_evidence.id))
    UNION ALL
    SELECT jsonb_build_object('at', r.generated_at, 'kind', 'cctv_report_issued', 'actor_user_id', r.generated_by,
             'detail', jsonb_build_object('receipt_id', r.id, 'batch_id', r.batch_id, 'observation_count', r.observation_count, 'sha256', r.sha256))
      FROM public.cctv_report_receipts r
     WHERE r.evidence_item_id = v_evidence.id
  ) trail;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'evidence_item_id', v_evidence.id,
    'storage_path', v_evidence.storage_path,
    'captured_at', v_evidence.captured_at,
    'sha256_hash', v_evidence.sha256_hash,
    'source_size_bytes', (v_evidence.metadata->>'source_size_bytes')::bigint,
    'source_hashed_at', v_evidence.metadata->>'source_hashed_at',
    'is_court_ready', v_evidence.is_court_ready,
    'locked_at', v_evidence.locked_at,
    'lock', v_evidence.metadata->'evidence_lock',
    'retention_hold', v_evidence.retention_hold,
    'retention_reason', v_evidence.retention_reason,
    'integrity', v_evidence.metadata->'integrity',
    'events', v_events
  ));
END $$;
REVOKE ALL ON FUNCTION public.cctv_evidence_custody(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cctv_evidence_custody(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.cctv_evidence_custody(uuid) IS
  'Org-scoped custody record for one CCTV recording: hash and provenance, lock, retention hold, latest integrity check, and the ordered trail of lock / bookmark / integrity / export events.';
