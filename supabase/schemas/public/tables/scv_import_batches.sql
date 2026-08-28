create table "public"."scv_import_batches" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid,
  "source_name"     text                     not null default 'canonical_scv_csv'::text,
  "file_name"       text,
  "status"          text                     not null default 'draft'::text,
  "total_rows"      integer                  not null default 0,
  "valid_rows"      integer                  not null default 0,
  "inserted_rows"   integer                  not null default 0,
  "updated_rows"    integer                  not null default 0,
  "skipped_rows"    integer                  not null default 0,
  "invalid_rows"    integer                  not null default 0,
  "error_summary"   text,
  "imported_by"     uuid,
  "started_at"      timestamp with time zone,
  "completed_at"    timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "scv_import_batches_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "scv_import_batches_pkey" primary key (id),
  constraint "scv_import_batches_status_check"
    check ((status = ANY (ARRAY['draft'::text, 'validating'::text, 'validated'::text, 'importing'::text, 'completed'::text, 'failed'::text, 'cancelled'::text]))),
  constraint "scv_import_batches_imported_by_fkey" foreign key (imported_by) references public.user_profiles(id)
);

alter table "public"."scv_import_batches"
  enable row level security;

create index idx_scv_import_batches_status on public.scv_import_batches using btree (status, created_at desc);

create policy "bob_full_read" on "public"."scv_import_batches"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "scv_import_batches_insert" on "public"."scv_import_batches"
  for insert
  to PUBLIC
  with check (((organization_id IS NULL) OR public.is_admin_for_org(organization_id)));

create policy "scv_import_batches_select" on "public"."scv_import_batches"
  for select
  to PUBLIC
  using (((organization_id is null) or public.org_access_allowed(organization_id)));

create policy "scv_import_batches_update" on "public"."scv_import_batches"
  for update
  to PUBLIC
  using (((organization_id is null) or public.is_admin_for_org(organization_id)))
  with check (((organization_id IS NULL) OR public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."scv_import_batches" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."scv_import_batches" is 'Audit records for canonical SCV CSV imports. CSV import is the primary SCV lookup source before NZSCV API fallback.';
