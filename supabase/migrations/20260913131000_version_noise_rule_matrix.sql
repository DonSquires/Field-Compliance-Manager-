-- Noise matrix settings were configurable but not versioned/effective-dated,
-- unlike freedom_camping_org_settings and zone_compliance_matrix. Add the
-- same provenance spine without changing the existing score semantics.
ALTER TABLE public.noise_module_config
  ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS effective_from date NOT NULL DEFAULT current_date,
  ADD COLUMN IF NOT EXISTS effective_to date,
  ADD COLUMN IF NOT EXISTS source_document_url text,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES public.user_profiles(id);

ALTER TABLE public.noise_module_config
  DROP CONSTRAINT IF EXISTS noise_module_config_dates_check;
ALTER TABLE public.noise_module_config
  ADD CONSTRAINT noise_module_config_dates_check
  CHECK (effective_to IS NULL OR effective_to >= effective_from);

CREATE INDEX IF NOT EXISTS idx_noise_module_config_current
  ON public.noise_module_config (organization_id, is_current, effective_from DESC);

COMMENT ON COLUMN public.noise_module_config.excessive_threshold IS
  'Organization triage threshold for the configurable volume/time/tone matrix. It is not a replacement for the RMA 1991 s.326 enforcement-officer opinion that noise is excessive.';
COMMENT ON COLUMN public.noise_module_config.legislative_text IS
  'Organization document wording/reference. Default cites RMA 1991 ss.326-328; verify current wording against official legislation before issuing a notice.';
