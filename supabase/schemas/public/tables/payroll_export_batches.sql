create table "public"."payroll_export_batches" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "exported_by"     uuid,
  "period_from"     date                     not null,
  "period_to"       date                     not null,
  "format"          text                     not null default 'csv'::text,
  "timesheet_count" integer                  not null default 0,
  "total_hours"     numeric                  not null default 0,
  "notes"           text,
  "exported_at"     timestamp with time zone not null default now(),
  constraint "payroll_export_batches_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "payroll_export_batches_pkey" primary key (id),
  constraint "payroll_export_batches_exported_by_fkey" foreign key (exported_by) references public.user_profiles(id) on delete set null
);

alter table "public"."payroll_export_batches"
  enable row level security;

create index idx_payroll_export_batches_org on public.payroll_export_batches using btree (organization_id);

create policy "bob_full_read" on "public"."payroll_export_batches"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."payroll_export_batches"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "payroll_export_batches_org_select" on "public"."payroll_export_batches"
  for select
  to PUBLIC
  using ((organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))));

create policy "payroll_export_batches_org_write" on "public"."payroll_export_batches"
  for all
  to PUBLIC
  using ((organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))))
  with check ((organization_id IN ( SELECT up.organization_id
   FROM public.user_profiles up
  WHERE (up.id = auth.uid()))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."payroll_export_batches" to "anon", "authenticated", "postgres", "service_role";
