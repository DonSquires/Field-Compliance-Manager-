ALTER TABLE public.inference_jobs
  ADD COLUMN IF NOT EXISTS progress_percent integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_current integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_total integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_label text;

COMMENT ON COLUMN public.inference_jobs.progress_percent IS 'Best-effort operator-facing CCTV progress percentage; status and stage remain authoritative.';
COMMENT ON COLUMN public.inference_jobs.progress_current IS 'Current CCTV processing iteration, such as the selected frame or inference batch.';
COMMENT ON COLUMN public.inference_jobs.progress_total IS 'Total CCTV processing iterations in the current progress plan.';
COMMENT ON COLUMN public.inference_jobs.progress_label IS 'Operator-facing description of the current CCTV processing stage.';