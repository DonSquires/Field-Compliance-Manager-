ALTER TABLE public.monthly_report_packs
  ADD COLUMN IF NOT EXISTS pdf_mime_type text,
  ADD COLUMN IF NOT EXISTS pdf_sha256 text,
  ADD COLUMN IF NOT EXISTS pdf_renderer_version text;

COMMENT ON COLUMN public.monthly_report_packs.pdf_path IS
  'Private bob-uploads storage path for the generated client report pack PDF.';
COMMENT ON COLUMN public.monthly_report_packs.pdf_sha256 IS
  'SHA-256 checksum of the generated report pack PDF bytes.';
COMMENT ON COLUMN public.monthly_report_packs.pdf_renderer_version IS
  'Renderer identifier used to produce the report pack PDF.';

ALTER TABLE public.monthly_report_packs
  DROP CONSTRAINT IF EXISTS monthly_report_packs_pdf_sha256_check;
ALTER TABLE public.monthly_report_packs
  ADD CONSTRAINT monthly_report_packs_pdf_sha256_check
  CHECK (pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$');
