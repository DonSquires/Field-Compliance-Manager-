-- Routine self-heal dedupe. Monitored packets that share a failure signature with an open routine
-- repair are covered by that one Builder job instead of opening a job per page (live 2026-11:
-- `_leaflet_pos` opened and failed separate jobs for /admin/hub and /admin/module-subscriptions).
-- builder_job_id stays the unique owning link; covered_by_job_id is the non-unique covering link and
-- the control plane keeps a covered packet's automation_status in step with that job.

ALTER TABLE public.bob_friction_packets
  ADD COLUMN IF NOT EXISTS covered_by_job_id uuid REFERENCES public.builder_jobs(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bob_friction_packets.covered_by_job_id IS
  'Open routine Builder job repairing the same failure signature; set by the control plane at intake. The packet status follows that job.';

CREATE INDEX IF NOT EXISTS bob_friction_packets_covered_by_job_idx
  ON public.bob_friction_packets (covered_by_job_id)
  WHERE covered_by_job_id IS NOT NULL;
