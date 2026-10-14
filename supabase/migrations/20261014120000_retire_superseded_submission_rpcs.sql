-- Retire three SECURITY DEFINER submission RPCs that were superseded but left
-- granted to "authenticated", so each remained a second, unaudited writer for a
-- table that already has a governed authority.
--
--   submit_officer_timesheet  -> superseded by submit_officer_timesheet_from_work
--     The retired function accepted typed p_actual_hours (up to 744) and inserted
--     a 'submitted' timesheet with no timesheet_work_entries provenance, which
--     bypassed the derive-hours-from-completed-work rule the successor exists to
--     enforce. No caller has existed since commit 633c5b9f.
--
--   submit_noise_assessment   -> superseded by submit_officer_noise_assessment_v2
--   submit_smoke_assessment   -> superseded by submit_smoke_assessment_receipt_v2
--     Both successors are reached only through the submit-noise-assessment and
--     submit-smoke-assessment Edge Functions, which run the evidence upload,
--     classification and geofence pipeline before the receipt is written. The
--     retired functions let a client write an assessment row directly, skipping
--     that pipeline. Neither has ever had an application caller.
--
-- Verified before drop: no application caller, no Edge Function caller, and no
-- other database function references these names.

DROP FUNCTION IF EXISTS public.submit_officer_timesheet(
  uuid,
  date,
  date,
  numeric,
  numeric,
  text
);

DROP FUNCTION IF EXISTS public.submit_noise_assessment(
  uuid,
  jsonb
);

DROP FUNCTION IF EXISTS public.submit_smoke_assessment(
  uuid,
  jsonb
);
