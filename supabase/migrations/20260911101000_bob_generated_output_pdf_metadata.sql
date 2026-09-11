ALTER TABLE public.bob_generated_document_outputs
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS renderer_version text;

COMMENT ON COLUMN public.bob_generated_document_outputs.mime_type IS
  'Generated artifact MIME type, e.g. application/pdf. Kept explicit for safe downloads and client rendering.';
COMMENT ON COLUMN public.bob_generated_document_outputs.renderer_version IS
  'Deterministic renderer identifier/version used to produce the artifact.';
