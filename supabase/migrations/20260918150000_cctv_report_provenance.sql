-- CCTV report provenance: a receipt records what the database knew at the moment of issue, not just what the
-- browser composed; receipts are immutable; anyone in the organisation can verify a printed report against it.
--
-- Before this migration the receipt hashed a browser-built payload and nothing else. It did not carry the
-- source recording's integrity hash or lock state, the camera and place the footage came from, the analysis
-- result it summarised, or the review decisions as the database held them — so a printed report could say
-- "Approved identity" with nothing on the server to contradict it, and the printed page did not even name
-- its receipt. Receipt rows could also be edited or deleted by any service path.
--
-- What changes (existing spines only):
--   * issue_cctv_report_receipt is re-issued with the same arguments and one extra output column, provenance.
--     The server appends a provenance block to the payload before hashing: evidence hash / lock / integrity,
--     import camera and place, job and latest inference result (with the classification policy), review
--     counts from cctv_entity_observations and the legacy decision table, any earlier receipts for the same
--     evidence (superseded), and a review_consistency verdict when the client claims review_ready but the
--     database still holds unreviewed sightings. The verdict is recorded, not enforced, because two review
--     surfaces coexist until the legacy one retires.
--   * verify_cctv_report_receipt(receipt, sha256?) — org-scoped: recomputes the stored payload hash, compares
--     the caller's hash, and reports the evidence's current integrity state next to the one sealed at issue.
--   * zz_cctv_report_receipts_immutable — receipts cannot be updated or deleted (test purge via the same GUC
--     as evidence, app.evidence_delete_scope = 'test_dataset_purge').

DROP FUNCTION IF EXISTS public.issue_cctv_report_receipt(uuid, uuid, uuid, text, jsonb);
CREATE FUNCTION public.issue_cctv_report_receipt(p_job_id uuid, p_evidence_id uuid, p_organization_id uuid, p_batch_id text, p_payload jsonb)
RETURNS TABLE(report_id uuid, generated_at timestamptz, observation_count integer, sha256 text, provenance jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  actor_id uuid := auth.uid();
  generated timestamptz := clock_timestamp();
  receipt_id uuid := gen_random_uuid();
  v_evidence public.evidence_items%rowtype;
  v_job public.inference_jobs%rowtype;
  v_import public.cctv_imports%rowtype;
  v_place record;
  v_result record;
  v_review record;
  v_legacy record;
  v_prior record;
  v_provenance jsonb;
  v_payload jsonb;
  payload_hash text;
  count_observations integer;
  v_claimed_status text := p_payload->>'report_status';
BEGIN
  IF actor_id IS NULL OR NOT public.org_access_allowed(p_organization_id) THEN RAISE EXCEPTION 'CCTV report access denied'; END IF;
  IF jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'CCTV report payload must be an object'; END IF;

  SELECT * INTO v_job FROM public.inference_jobs
   WHERE id = p_job_id AND evidence_item_id = p_evidence_id AND organization_id = p_organization_id AND domain IN ('video_motion', 'vehicle', 'face');
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'CCTV job or evidence is missing or outside the organization'; END IF;
  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = p_evidence_id AND organization_id = p_organization_id;
  IF v_evidence.id IS NULL THEN RAISE EXCEPTION 'CCTV job or evidence is missing or outside the organization'; END IF;
  IF v_evidence.cctv_import_id IS NOT NULL THEN
    SELECT * INTO v_import FROM public.cctv_imports WHERE id = v_evidence.cctv_import_id;
    SELECT l.name, l.address INTO v_place FROM public.locations l WHERE l.id = v_import.location_id;
  END IF;
  SELECT r.id, r.status, r.created_at, r.result->'classification_plan' AS classification_plan,
         r.result->>'worker_version' AS worker_version, r.result->>'model_version' AS model_version
    INTO v_result
    FROM public.inference_results r WHERE r.inference_job_id = v_job.id ORDER BY r.created_at DESC LIMIT 1;
  SELECT count(*) AS total,
         count(*) FILTER (WHERE o.review_state = 'accepted') AS accepted,
         count(*) FILTER (WHERE o.review_state = 'rejected') AS rejected,
         count(*) FILTER (WHERE o.review_state = 'unreviewed') AS unreviewed,
         count(*) FILTER (WHERE o.review_state IN ('uncertain', 'needs_more_context')) AS undecided,
         max(o.reviewed_at) AS last_reviewed_at
    INTO v_review
    FROM public.cctv_entity_observations o WHERE o.evidence_item_id = v_evidence.id;
  SELECT count(*) AS decisions, max(d.decided_at) AS last_decided_at INTO v_legacy
    FROM public.cctv_review_decisions d WHERE d.evidence_item_id = v_evidence.id;
  SELECT count(*) AS receipts, max(r.generated_at) AS latest_at,
         (array_agg(r.id ORDER BY r.generated_at DESC))[1] AS latest_id
    INTO v_prior
    FROM public.cctv_report_receipts r WHERE r.evidence_item_id = v_evidence.id;

  count_observations := jsonb_array_length(CASE WHEN jsonb_typeof(p_payload->'observations') = 'array' THEN p_payload->'observations' ELSE '[]'::jsonb END);

  v_provenance := jsonb_strip_nulls(jsonb_build_object(
    'receipt_id', receipt_id,
    'issued_at', generated,
    'issued_by', actor_id,
    'claimed_report_status', v_claimed_status,
    'evidence', jsonb_build_object(
      'id', v_evidence.id, 'storage_path', v_evidence.storage_path, 'captured_at', v_evidence.captured_at,
      'sha256_hash', v_evidence.sha256_hash, 'source_size_bytes', (v_evidence.metadata->>'source_size_bytes')::bigint,
      'is_court_ready', v_evidence.is_court_ready, 'locked_at', v_evidence.locked_at, 'retention_hold', v_evidence.retention_hold,
      'integrity_state', v_evidence.metadata->'integrity'->>'state', 'integrity_checked_at', v_evidence.metadata->'integrity'->>'checked_at'),
    'import', CASE WHEN v_import.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_import.id, 'camera_label', v_import.camera_label, 'camera_key', v_import.camera_key,
      'source_device_kind', v_import.source_device_kind, 'source_timezone', v_import.source_timezone,
      'location_id', v_import.location_id, 'canonical_place_id', v_import.canonical_place_id,
      'place_name', v_place.name, 'place_address', v_place.address) END,
    'job', jsonb_build_object('id', v_job.id, 'domain', v_job.domain, 'status', v_job.status, 'completed_at', v_job.completed_at, 'attempt_count', v_job.attempt_count),
    'result', CASE WHEN v_result.id IS NULL THEN NULL ELSE jsonb_build_object(
      'inference_result_id', v_result.id, 'status', v_result.status, 'created_at', v_result.created_at,
      'classification_plan', v_result.classification_plan, 'worker_version', v_result.worker_version, 'model_version', v_result.model_version) END,
    'review', jsonb_build_object(
      'observations_total', v_review.total, 'accepted', v_review.accepted, 'rejected', v_review.rejected,
      'unreviewed', v_review.unreviewed, 'undecided', v_review.undecided, 'last_reviewed_at', v_review.last_reviewed_at,
      'legacy_decisions', v_legacy.decisions, 'legacy_last_decided_at', v_legacy.last_decided_at),
    'review_consistency', CASE
      WHEN v_claimed_status = 'review_ready' AND (v_review.unreviewed + v_review.undecided) > 0 THEN 'client_claims_review_ready_but_database_holds_undecided_sightings'
      WHEN v_claimed_status = 'review_ready' THEN 'consistent'
      ELSE 'draft' END,
    'supersedes', CASE WHEN v_prior.receipts > 0 THEN jsonb_build_object('receipt_id', v_prior.latest_id, 'issued_at', v_prior.latest_at, 'earlier_receipts', v_prior.receipts) ELSE NULL END
  ));

  v_payload := p_payload || jsonb_build_object('provenance', v_provenance);
  payload_hash := encode(digest(convert_to(v_payload::text, 'UTF8'), 'sha256'), 'hex');

  INSERT INTO public.cctv_report_receipts (id, organization_id, inference_job_id, evidence_item_id, batch_id, generated_by, generated_at, observation_count, payload, sha256)
  VALUES (receipt_id, p_organization_id, p_job_id, p_evidence_id, NULLIF(trim(p_batch_id), ''), actor_id, generated, count_observations, v_payload, payload_hash);

  INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
  VALUES (p_organization_id, actor_id, 'cctv_report_receipt_issued', 'cctv_report_receipts', receipt_id,
          jsonb_strip_nulls(jsonb_build_object('inference_job_id', p_job_id, 'evidence_item_id', p_evidence_id, 'batch_id', p_batch_id,
            'observation_count', count_observations, 'sha256', payload_hash, 'evidence_sha256', v_evidence.sha256_hash,
            'claimed_report_status', v_claimed_status, 'review_consistency', v_provenance->>'review_consistency',
            'supersedes_receipt_id', v_provenance->'supersedes'->>'receipt_id')));

  RETURN QUERY SELECT receipt_id, generated, count_observations, payload_hash, v_provenance;
END $$;
REVOKE ALL ON FUNCTION public.issue_cctv_report_receipt(uuid, uuid, uuid, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_cctv_report_receipt(uuid, uuid, uuid, text, jsonb) TO authenticated, service_role;
COMMENT ON FUNCTION public.issue_cctv_report_receipt(uuid, uuid, uuid, text, jsonb) IS
  'Issues an immutable receipt for a CCTV report. The server appends a provenance block (evidence hash/lock/integrity, camera and place, job and inference result, database review counts, superseded receipts, review_consistency) before hashing. Returns the hash and the provenance for printing.';

-- ── verification ──
CREATE OR REPLACE FUNCTION public.verify_cctv_report_receipt(p_receipt_id uuid, p_sha256 text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_receipt public.cctv_report_receipts%rowtype;
  v_recomputed text;
  v_evidence public.evidence_items%rowtype;
  v_claimed text := lower(nullif(trim(coalesce(p_sha256, '')), ''));
BEGIN
  IF auth.uid() IS NULL AND auth.role() <> 'service_role' AND session_user NOT IN ('postgres', 'supabase_admin') THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_receipt FROM public.cctv_report_receipts WHERE id = p_receipt_id;
  IF v_receipt.id IS NULL THEN RETURN jsonb_build_object('receipt_id', p_receipt_id, 'found', false); END IF;
  IF NOT public.org_access_allowed(v_receipt.organization_id) THEN RAISE EXCEPTION 'CCTV report access denied'; END IF;
  v_recomputed := encode(digest(convert_to(v_receipt.payload::text, 'UTF8'), 'sha256'), 'hex');
  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = v_receipt.evidence_item_id;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'receipt_id', v_receipt.id,
    'found', true,
    'issued_at', v_receipt.generated_at,
    'issued_by', v_receipt.generated_by,
    'observation_count', v_receipt.observation_count,
    'stored_sha256', v_receipt.sha256,
    'receipt_intact', v_recomputed = v_receipt.sha256,
    'presented_sha256', v_claimed,
    'presented_matches', CASE WHEN v_claimed IS NULL THEN NULL ELSE v_claimed = v_receipt.sha256 END,
    'evidence_sha256_at_issue', v_receipt.payload->'provenance'->'evidence'->>'sha256_hash',
    'evidence_sha256_now', v_evidence.sha256_hash,
    'evidence_integrity_now', v_evidence.metadata->'integrity'->>'state',
    'evidence_locked_at', v_evidence.locked_at,
    'review_consistency_at_issue', v_receipt.payload->'provenance'->>'review_consistency',
    'superseded_by', (SELECT r.id FROM public.cctv_report_receipts r WHERE r.evidence_item_id = v_receipt.evidence_item_id AND r.generated_at > v_receipt.generated_at ORDER BY r.generated_at ASC LIMIT 1)
  ));
END $$;
REVOKE ALL ON FUNCTION public.verify_cctv_report_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_cctv_report_receipt(uuid, text) TO authenticated, service_role;
COMMENT ON FUNCTION public.verify_cctv_report_receipt(uuid, text) IS
  'Org-scoped: recomputes the stored receipt hash (receipt_intact), compares a presented hash, and reports the evidence integrity now against the hash sealed at issue, plus any later receipt that supersedes it.';

-- ── receipts are records ──
CREATE OR REPLACE FUNCTION public.tg_cctv_report_receipts_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.evidence_delete_scope', true) = 'test_dataset_purge' THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'CCTV report receipt % is a record and cannot be % . Issue a new receipt instead.', OLD.id, lower(TG_OP) || 'd' USING ERRCODE = 'P0001';
END $$;
REVOKE ALL ON FUNCTION public.tg_cctv_report_receipts_immutable() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_cctv_report_receipts_immutable ON public.cctv_report_receipts;
CREATE TRIGGER zz_cctv_report_receipts_immutable
  BEFORE UPDATE OR DELETE ON public.cctv_report_receipts
  FOR EACH ROW EXECUTE FUNCTION public.tg_cctv_report_receipts_immutable();
