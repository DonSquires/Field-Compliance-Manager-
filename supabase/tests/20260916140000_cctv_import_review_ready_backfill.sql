-- Truth table for 20260916140000; fixture runs before the candidate migration.
BEGIN;
SET LOCAL ROLE postgres;
SET LOCAL search_path TO public, extensions, pg_catalog;

CREATE OR REPLACE FUNCTION pg_temp.check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT coalesce(p_ok, false) THEN RAISE EXCEPTION 'FAIL [%]', p_label; END IF;
  RAISE NOTICE 'ok   [%]', p_label;
END $$;

SELECT pg_temp.check(
  'all terminal video jobs are backfilled to review ready',
  (SELECT status = 'review_ready' FROM public.cctv_imports WHERE id = 'a1400000-0000-4000-8000-000000000100')
);
SELECT pg_temp.check(
  'one processing video job leaves the import registered',
  (SELECT status = 'registered' FROM public.cctv_imports WHERE id = 'a1400000-0000-4000-8000-000000000101')
);
SELECT pg_temp.check(
  'archived import is never reopened by backfill',
  (SELECT status = 'archived' FROM public.cctv_imports WHERE id = 'a1400000-0000-4000-8000-000000000102')
);
SELECT pg_temp.check(
  'backfill audit records the terminal video count',
  EXISTS (
    SELECT 1 FROM public.audit_log
    WHERE action = 'cctv_import_review_ready'
      AND target_id = 'a1400000-0000-4000-8000-000000000100'
      AND metadata->>'backfill' = 'true'
      AND (metadata->>'completed_video_jobs')::integer = 2
  )
);
SELECT pg_temp.check(
  'mixed and archived imports have no backfill audit row',
  NOT EXISTS (
    SELECT 1 FROM public.audit_log
    WHERE action = 'cctv_import_review_ready'
      AND target_id IN ('a1400000-0000-4000-8000-000000000101', 'a1400000-0000-4000-8000-000000000102')
  )
);

ROLLBACK;
