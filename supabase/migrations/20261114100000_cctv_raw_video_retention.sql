-- Raw CCTV video retention (owner decision 2026-11-14: keep raw video 90 days after import).
-- The evidence row, hashes, frames, observations and review decisions stay; only the original
-- recording and its playback copy leave storage. Purge execution lives in
-- scripts/custodian-raw-video-purge.js, which records each purge here before deleting through
-- the Storage API, so a failed delete is retried and never leaves an unaudited removal.

ALTER TABLE public.retention_policies
  DROP CONSTRAINT IF EXISTS retention_policies_category_check;
ALTER TABLE public.retention_policies
  ADD CONSTRAINT retention_policies_category_check CHECK (
    category IN (
      'infringement',
      'non_infringement',
      'hold_default',
      'interaction_permanent',
      'observation_30_day',
      'canonical_indefinite',
      'legal_hold',
      'website_analytics',
      'scheduler_run_history',
      'cctv_raw_video'
    )
  );

-- Platform default; an organisation-specific active row overrides it.
INSERT INTO public.retention_policies (
  organization_id,
  module_key,
  category,
  retention_days,
  is_permanent,
  legal_basis
)
SELECT
  NULL,
  'cctv_review',
  'cctv_raw_video',
  90,
  false,
  'Owner decision 2026-11-14: raw CCTV recordings are kept 90 days after import unless sealed, court-ready, held or given a later retention date.'
WHERE NOT EXISTS (
  SELECT 1
    FROM public.retention_policies AS rp
   WHERE rp.organization_id IS NULL
     AND rp.category = 'cctv_raw_video'
     AND rp.is_active
);

-- Returns the applicable retention days when the evidence item's raw video has expired, else NULL.
CREATE OR REPLACE FUNCTION private.cctv_raw_video_expired_days(p_evidence_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT pol.retention_days
    FROM public.evidence_items AS e
    JOIN public.cctv_imports AS i
      ON i.id = e.cctv_import_id
    CROSS JOIN LATERAL (
      SELECT rp.retention_days, rp.is_permanent
        FROM public.retention_policies AS rp
       WHERE rp.category = 'cctv_raw_video'
         AND rp.is_active
         AND (rp.organization_id = e.organization_id OR rp.organization_id IS NULL)
       ORDER BY (rp.organization_id IS NULL), rp.effective_from DESC
       LIMIT 1
    ) AS pol
   WHERE e.id = p_evidence_id
     AND e.module_key = 'cctv_review'
     AND e.evidence_kind = 'video'
     AND e.locked_at IS NULL
     AND NOT e.is_court_ready
     AND NOT e.retention_hold
     AND (e.retention_until IS NULL OR e.retention_until <= pg_catalog.now())
     AND NOT pol.is_permanent
     AND pol.retention_days > 0
     AND i.created_at < pg_catalog.now() - pg_catalog.make_interval(days => pol.retention_days)
     AND NOT EXISTS (
       SELECT 1
         FROM public.custodian_legal_holds AS h
        WHERE h.organization_id = e.organization_id
          AND h.status = 'active'
          AND (h.scope = '{}'::jsonb OR e.metadata @> h.scope)
     );
$function$;

REVOKE ALL ON FUNCTION private.cctv_raw_video_expired_days(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.custodian_raw_video_purge_candidates(integer);
CREATE FUNCTION public.custodian_raw_video_purge_candidates(p_limit integer DEFAULT 100)
RETURNS TABLE (
  evidence_id uuid,
  organization_id uuid,
  storage_bucket text,
  storage_paths text[],
  imported_at timestamptz,
  retention_days integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  RETURN QUERY
  SELECT e.id,
         e.organization_id,
         b.bucket,
         p.paths,
         i.created_at,
         x.days
    FROM public.evidence_items AS e
    JOIN public.cctv_imports AS i
      ON i.id = e.cctv_import_id
    CROSS JOIN LATERAL (SELECT coalesce(e.metadata->>'storage_bucket', 'bob-uploads') AS bucket) AS b
    CROSS JOIN LATERAL (SELECT private.cctv_raw_video_expired_days(e.id) AS days) AS x
    CROSS JOIN LATERAL (
      SELECT array_agg(o.name ORDER BY o.name) AS paths
        FROM storage.objects AS o
       WHERE o.bucket_id = b.bucket
         AND o.name IN (e.storage_path, e.metadata->>'playback_storage_path')
    ) AS p
   WHERE e.module_key = 'cctv_review'
     AND e.evidence_kind = 'video'
     AND x.days IS NOT NULL
     AND p.paths IS NOT NULL
   ORDER BY i.created_at, e.id
   LIMIT greatest(least(coalesce(p_limit, 100), 500), 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.custodian_raw_video_purge_candidates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custodian_raw_video_purge_candidates(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.custodian_record_raw_video_purge(p_evidence_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_days integer;
  v_evidence public.evidence_items%ROWTYPE;
  v_bucket text;
  v_paths text[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;

  SELECT * INTO v_evidence FROM public.evidence_items WHERE id = p_evidence_id FOR UPDATE;
  v_days := private.cctv_raw_video_expired_days(p_evidence_id);
  IF v_evidence.id IS NULL OR v_days IS NULL THEN
    RAISE EXCEPTION 'Evidence % is not eligible for raw-video retention purge', p_evidence_id;
  END IF;

  v_bucket := coalesce(v_evidence.metadata->>'storage_bucket', 'bob-uploads');
  SELECT array_agg(p ORDER BY p) INTO v_paths
    FROM unnest(ARRAY[v_evidence.storage_path, v_evidence.metadata->>'playback_storage_path']) AS p
   WHERE p IS NOT NULL;

  IF NOT (v_evidence.metadata ? 'raw_video_purged_at') THEN
    UPDATE public.evidence_items
       SET metadata = metadata || jsonb_build_object(
             'raw_video_purged_at', pg_catalog.now(),
             'raw_video_retention_days', v_days)
     WHERE id = p_evidence_id;

    INSERT INTO public.custodian_actions (organization_id, actor_user_id, action, target_table, target_id, reason, metadata)
    VALUES (
      v_evidence.organization_id,
      NULL,
      'raw_video_retention_purged',
      'evidence_items',
      p_evidence_id,
      format('Raw recording expired under the cctv_raw_video retention policy (%s days after import).', v_days),
      jsonb_build_object('storage_bucket', v_bucket, 'storage_paths', to_jsonb(v_paths), 'retention_days', v_days)
    );
  END IF;

  RETURN jsonb_build_object(
    'evidence_id', p_evidence_id,
    'storage_bucket', v_bucket,
    'storage_paths', to_jsonb(v_paths),
    'retention_days', v_days
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.custodian_record_raw_video_purge(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.custodian_record_raw_video_purge(uuid) TO service_role;
