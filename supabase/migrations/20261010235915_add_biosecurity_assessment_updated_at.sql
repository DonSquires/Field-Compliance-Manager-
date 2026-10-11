ALTER TABLE public.biosecurity_assessments
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.biosecurity_assessments.updated_at IS
  'Timestamp of the latest governed assessment, evidence, or review state change.';