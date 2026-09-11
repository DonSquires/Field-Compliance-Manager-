CREATE INDEX IF NOT EXISTS inference_jobs_org_review_queue_idx
  ON public.inference_jobs (organization_id, domain, status, created_at DESC);

CREATE INDEX IF NOT EXISTS inference_results_job_created_idx
  ON public.inference_results (inference_job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS evidence_items_cctv_batch_idx
  ON public.evidence_items (organization_id, ((metadata->'desktop_review_batch'->>'batch_id')))
  WHERE metadata->'desktop_review_batch'->>'batch_id' IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_cctv_batch_report_data(
  p_organization_id uuid,
  p_batch_id text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH batch_evidence AS (
    SELECT
      evidence.id AS evidence_item_id,
      evidence.metadata,
      NULLIF(evidence.metadata->'desktop_review_batch'->>'clip_index', '')::integer AS clip_index
    FROM public.evidence_items evidence
    WHERE evidence.organization_id = p_organization_id
      AND evidence.metadata->'desktop_review_batch'->>'batch_id' = p_batch_id
      AND public.org_access_allowed(evidence.organization_id)
  ),
  batch_jobs AS (
    SELECT DISTINCT ON (job.evidence_item_id)
      job.id AS job_id,
      job.evidence_item_id,
      job.status,
      evidence.clip_index
    FROM public.inference_jobs job
    JOIN batch_evidence evidence ON evidence.evidence_item_id = job.evidence_item_id
    WHERE job.organization_id = p_organization_id
      AND job.domain IN ('video_motion', 'vehicle', 'face')
    ORDER BY job.evidence_item_id, job.created_at DESC
  ),
  latest_results AS (
    SELECT DISTINCT ON (result.inference_job_id)
      result.inference_job_id,
      result.result->'consolidated_events' AS consolidated,
      COALESCE((result.result->>'total_frames_parsed')::integer, 0) AS total_frames_parsed
    FROM public.inference_results result
    JOIN batch_jobs job ON job.job_id = result.inference_job_id
    ORDER BY result.inference_job_id, result.created_at DESC
  ),
  observations AS (
    SELECT
      job.job_id,
      job.clip_index,
      observation.kind,
      observation.value
    FROM batch_jobs job
    JOIN latest_results result ON result.inference_job_id = job.job_id
    CROSS JOIN LATERAL (
      SELECT 'Person'::text AS kind, value
      FROM jsonb_array_elements(COALESCE(result.consolidated->'person_events', '[]'::jsonb)) value
      UNION ALL
      SELECT 'Face'::text, value
      FROM jsonb_array_elements(COALESCE(result.consolidated->'face_events', '[]'::jsonb)) value
      UNION ALL
      SELECT 'Vehicle'::text, value
      FROM jsonb_array_elements(COALESCE(result.consolidated->'vehicle_events', '[]'::jsonb)) value
    ) observation
  ),
  image_candidates AS (
    SELECT
      observation.job_id,
      observation.clip_index,
      observation.kind,
      observation.value->>'thumbnail' AS src,
      COALESCE(observation.value->>'subject_label', observation.value->>'plate', observation.kind || ' observation') AS label,
      COALESCE((observation.value->>'first_seen_seconds')::numeric, 0) AS timestamp_seconds,
      observation.value->>'best_frame_hash' AS sha256_hash,
      row_number() OVER (ORDER BY observation.clip_index NULLS LAST, COALESCE((observation.value->>'first_seen_seconds')::numeric, 0)) AS image_rank
    FROM observations observation
    WHERE observation.value->>'thumbnail' LIKE 'data:image/%'
  )
  SELECT jsonb_build_object(
    'batch_id', p_batch_id,
    'clip_count', (SELECT count(*) FROM batch_evidence),
    'loaded_clip_count', (SELECT count(*) FROM batch_jobs),
    'complete', (SELECT count(*) FROM batch_evidence) = (SELECT count(*) FROM batch_jobs),
    'frame_count', COALESCE((SELECT sum(total_frames_parsed) FROM latest_results), 0),
    'observations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'job_id', job_id,
        'clip_index', clip_index,
        'kind', kind,
        'event_id', value->>'event_id',
        'label', COALESCE(value->>'subject_label', value->>'plate', kind || ' observation'),
        'confidence', value->'confidence',
        'start_seconds', value->'first_seen_seconds',
        'end_seconds', value->'last_seen_seconds',
        'best_frame_hash', value->>'best_frame_hash',
        'review_required', COALESCE((value->>'review_required')::boolean, true)
      ) ORDER BY clip_index NULLS LAST, COALESCE((value->>'first_seen_seconds')::numeric, 0))
      FROM observations
    ), '[]'::jsonb),
    'evidence_images', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'src', src,
        'label', label,
        'timestamp_seconds', timestamp_seconds,
        'sha256_hash', sha256_hash,
        'review_state', 'Review required'
      ) ORDER BY image_rank)
      FROM image_candidates
      WHERE image_rank <= 6
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.get_cctv_batch_report_data(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_cctv_batch_report_data(uuid, text) TO authenticated, service_role;
