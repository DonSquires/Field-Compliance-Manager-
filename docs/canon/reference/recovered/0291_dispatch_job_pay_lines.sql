-- Recovered reference source (NOT compiled or applied here). Origin: GitLab don-squires1/field-compliance-manager
-- supabase/migrations/0291_dispatch_job_pay_lines.sql @ Main, read 2026-09-14 via scripts/gitlab-read.mjs. Re-implement against the live schema with tests before use.

-- ============================================================
-- Migration 0291 -- dispatch_job_pay_lines (pay/cost sink)
-- ============================================================
-- Closes the PAY side of the dispatch->cost->charge loop.
--
-- The billing side (invoice_line_items with source_dispatch_id, migration
-- 0269) already captures what we CHARGE. This table captures what we PAY
-- the performing officer per completed dispatch job -- the resolved output
-- of resolvePayLines() from rateEngine.ts.
--
-- One row per resolved pay line per job (base + allowance + EMS + on-call
-- + travel etc.). Keyed by (organization_id, source_dispatch_id, pay_code)
-- for idempotency -- mirrors the invoice_line_items partial-unique pattern
-- from 0269.
--
-- Also adds a source_dispatch_id column to quote_lines so the Layer-2
-- on-charge pipeline can write idempotent per-job on-charge lines.
--
-- Ledger tip was 0290 (0290_role_aware_resolution_slice, merged via !1092).
-- This is 0291. Renumbered from 0290 to avoid a parallel-agent ledger collision.
-- ADDITIVE ONLY. No drops, no renames. ASCII-only.
-- ============================================================

-- 1. dispatch_job_pay_lines -- the pay/cost sink
create table if not exists public.dispatch_job_pay_lines (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  source_dispatch_id   uuid not null references public.dispatch_jobs(id) on delete cascade,
  -- The officer who performed the work
  officer_user_id      uuid references public.user_profiles(id) on delete set null,

  -- Rate rule that resolved this line
  rate_rule_id         uuid references public.rate_rules(id) on delete set null,
  pay_code             text,          -- ORD|E1|EA|ON|31|38|HD|OD etc.
  rate_type            text not null,  -- hourly|flat|per_km|per_hour_travel|...
  description          text not null,

  -- Money
  quantity             numeric(12,4) not null default 1,
  unit_rate            numeric(12,4) not null default 0,
  multiplier           numeric(6,4) not null default 1,  -- overtime/double/1x
  line_total           numeric(12,2) not null default 0,

  -- Travel audit
  distance_km          numeric(10,3),
  distance_reason      text,          -- null = computed OK; non-null = why NULL

  -- Context snapshot for audit
  role_code            text,
  region_code          text,
  service_type         text,
  day_category         text,

  created_at           timestamptz not null default now()
);

comment on table public.dispatch_job_pay_lines is
  'Resolved pay/cost lines per completed dispatch job. One row per pay_code per job. '
  'Output of resolvePayLines() from rateEngine.ts. Idempotent via partial unique index '
  'on (organization_id, source_dispatch_id, pay_code).';

-- Idempotency: one line per pay_code per job per org (mirrors 0269 pattern)
create unique index if not exists idx_djpl_idempotent
  on public.dispatch_job_pay_lines (organization_id, source_dispatch_id, pay_code)
  where pay_code is not null;

-- For jobs with no pay_code (base lines keyed as __base__), use a separate
-- partial unique index to prevent duplicates
create unique index if not exists idx_djpl_idempotent_base
  on public.dispatch_job_pay_lines (organization_id, source_dispatch_id)
  where pay_code is null;

-- Lookup indexes
create index if not exists idx_djpl_dispatch on public.dispatch_job_pay_lines(source_dispatch_id);
create index if not exists idx_djpl_officer  on public.dispatch_job_pay_lines(officer_user_id);
create index if not exists idx_djpl_org      on public.dispatch_job_pay_lines(organization_id);

-- RLS
alter table public.dispatch_job_pay_lines enable row level security;

drop policy if exists djpl_select on public.dispatch_job_pay_lines;
create policy djpl_select on public.dispatch_job_pay_lines
  for select using (
    public.is_grand_master()
    or organization_id in (
      select up.organization_id from public.user_profiles up where up.id = auth.uid()
    )
  );

drop policy if exists djpl_write on public.dispatch_job_pay_lines;
create policy djpl_write on public.dispatch_job_pay_lines
  for all using (
    public.is_grand_master()
    or (
      organization_id in (
        select up.organization_id from public.user_profiles up where up.id = auth.uid()
      )
      and (select role from public.user_profiles where id = auth.uid())
          in ('grand_master','master','admin','admin_officer')
    )
  ) with check (
    public.is_grand_master()
    or (
      organization_id in (
        select up.organization_id from public.user_profiles up where up.id = auth.uid()
      )
      and (select role from public.user_profiles where id = auth.uid())
          in ('grand_master','master','admin','admin_officer')
    )
  );

-- GM full access (mirrors 0076/0079/0253 pattern)
drop policy if exists gm_full_access on public.dispatch_job_pay_lines;
create policy gm_full_access on public.dispatch_job_pay_lines for all to authenticated
  using (public.is_grand_master()) with check (public.is_grand_master());

-- 2. PostGIS helper RPC for travel distance computation
-- Returns distance in km between two lat/lng points using ST_Distance on
-- geography. Called by invoicePipeline.ts computeTravelDistanceKm().
-- Falls back gracefully if PostGIS is not available (the JS code has a
-- Haversine fallback).
create or replace function public.compute_point_distance_km(
  lat1 double precision,
  lng1 double precision,
  lat2 double precision,
  lng2 double precision
)
returns numeric
language sql
stable
as $$
  select round(
    (st_distance(
      st_setsrid(st_makepoint(lng1, lat1), 4326)::geography,
      st_setsrid(st_makepoint(lng2, lat2), 4326)::geography
    ) / 1000.0)::numeric,
    3
  );
$$;

comment on function public.compute_point_distance_km is
  'Returns the geodesic distance in km between two lat/lng points. '
  'Uses ST_Distance on geography (metres) / 1000. Called by the completion '
  'pipeline for travel distance computation.';

grant execute on function public.compute_point_distance_km to authenticated;

-- 3. quote_lines: add source_dispatch_id for on-charge idempotency
alter table public.quote_lines
  add column if not exists source_dispatch_id uuid;

create unique index if not exists idx_quote_lines_source_dispatch
  on public.quote_lines (quote_id, source_dispatch_id)
  where source_dispatch_id is not null;

comment on column public.quote_lines.source_dispatch_id is
  'FK to dispatch_jobs.id for on-charge lines auto-created by the completion pipeline. '
  'Partial unique index prevents duplicate on-charge lines per job per quote.';
