-- Keep governed biosecurity receipts compatible with persisted Bob inference.
alter table public.biosecurity_assessments
  add column if not exists bob_classification text,
  add column if not exists bob_confidence real;