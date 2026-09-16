-- Reconcile imports that completed before 20260916130000 introduced the completion transition.
-- Only all-terminal video imports move to review_ready; archived imports remain immutable.

WITH ready_imports AS (
  SELECT
    import_row.id AS import_id,
    import_row.organization_id,
    count(*) AS completed_video_jobs
  FROM public.cctv_imports AS import_row
  JOIN public.evidence_items AS evidence
    ON evidence.cctv_import_id = import_row.id
  JOIN public.inference_jobs AS job
    ON job.evidence_item_id = evidence.id
  WHERE import_row.status IN ('registered', 'processing')
    AND evidence.evidence_kind = 'video'
    AND job.domain = 'video_motion'
  GROUP BY import_row.id, import_row.organization_id
  HAVING bool_and(job.status IN ('complete', 'inconclusive', 'manual_review_required'))
), transitioned AS (
  UPDATE public.cctv_imports AS import_row
     SET status = 'review_ready',
         updated_at = clock_timestamp()
    FROM ready_imports
   WHERE import_row.id = ready_imports.import_id
  RETURNING import_row.id, import_row.organization_id, ready_imports.completed_video_jobs
)
INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
SELECT
  organization_id,
  NULL,
  'cctv_import_review_ready',
  'cctv_imports',
  id,
  jsonb_build_object('backfill', true, 'completed_video_jobs', completed_video_jobs)
FROM transitioned;
