-- pg_cron keeps every run in cron.job_run_details forever (~2,000 rows/day here).
-- Prune finished runs older than the platform's scheduler_run_history policy.

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
      'scheduler_run_history'
    )
  );

INSERT INTO public.retention_policies (
  organization_id,
  module_key,
  category,
  retention_days,
  is_permanent,
  legal_basis
)
SELECT
  t.service_provider_organization_id,
  'platform',
  'scheduler_run_history',
  14,
  false,
  'Owner request 2026-11-14: reduce storage bloat. Scheduler run logs are operational diagnostics, not evidence; keep 14 days.'
FROM private.platform_tenancy AS t
WHERE t.singleton
  AND t.service_provider_organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM public.retention_policies AS rp
     WHERE rp.organization_id = t.service_provider_organization_id
       AND rp.category = 'scheduler_run_history'
       AND rp.is_active
  );

CREATE OR REPLACE FUNCTION private.purge_cron_run_history()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_retention_days integer;
  v_deleted bigint;
BEGIN
  SELECT rp.retention_days
    INTO v_retention_days
    FROM private.platform_tenancy AS t
    JOIN public.retention_policies AS rp
      ON rp.organization_id = t.service_provider_organization_id
   WHERE t.singleton
     AND rp.category = 'scheduler_run_history'
     AND rp.is_active
     AND NOT rp.is_permanent
   ORDER BY rp.effective_from DESC
   LIMIT 1;

  IF NOT FOUND OR v_retention_days IS NULL OR v_retention_days <= 0 THEN
    RAISE EXCEPTION 'Scheduler run-history retention configuration is unavailable';
  END IF;

  -- Unfinished runs (no end_time) are never removed.
  DELETE FROM cron.job_run_details AS d
   WHERE d.end_time IS NOT NULL
     AND d.end_time < pg_catalog.now() - pg_catalog.make_interval(days => v_retention_days);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;

REVOKE ALL ON FUNCTION private.purge_cron_run_history()
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.purge_cron_run_history()
  TO postgres;

DO $schedule$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT j.jobid
    INTO v_job_id
    FROM cron.job AS j
   WHERE j.jobname = 'cron-run-history-retention-daily'
   LIMIT 1;

  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule_in_database(
    'cron-run-history-retention-daily',
    '37 3 * * *',
    'select private.purge_cron_run_history();',
    'postgres',
    NULL,
    TRUE
  );
END;
$schedule$;
