-- ============================================================
-- Migration 20260903170000 — Add updated_at column to shifts
-- ============================================================
-- Fixes PostgREST error "column shifts.updated_at does not exist" when querying active shift.

alter table public.shifts
  add column if not exists updated_at timestamptz not null default now();

comment on column public.shifts.updated_at is
  'Timestamp when the shift record was last updated.';
