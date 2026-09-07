-- Keep governed biosecurity receipts compatible with shift-scoped officer work.
alter table public.biosecurity_assessments
  add column if not exists shift_id uuid references public.shifts(id) on delete set null;

create index if not exists idx_biosecurity_assessments_shift
  on public.biosecurity_assessments (shift_id)
  where shift_id is not null;