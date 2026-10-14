-- Retire the legacy direct SLA-clock mutation endpoint.
--
-- Dispatch arrivals now flow through arrive_at_dispatch_place or
-- advance_dispatch_job_status. Both stamp dispatch_jobs.on_scene_at, and
-- trg_dispatch_job_close_sla_clock then computes the matching clock verdict.
-- record_sla_arrival accepted a clock id directly, carried no attendance,
-- officer-command, geofence or GPS receipt, and remained granted to PUBLIC and
-- anon. Keeping it would preserve a second authority capable of closing a
-- response clock without recording the arrival that supposedly stopped it.

DROP FUNCTION IF EXISTS public.record_sla_arrival(
  uuid,
  timestamp with time zone
);