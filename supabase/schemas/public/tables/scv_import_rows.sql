create table "public"."scv_import_rows" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "batch_id"           uuid                     not null,
  "row_number"         integer                  not null,
  "raw_row"            jsonb                    not null default '{}'::jsonb,
  "normalized_plate"   text,
  "certificate_number" text,
  "certificate_status" text,
  "issued_date"        date,
  "expiry_date"        date,
  "vehicle_make"       text,
  "vehicle_model"      text,
  "vehicle_year"       integer,
  "row_status"         text                     not null default 'pending'::text,
  "error_message"      text,
  "created_at"         timestamp with time zone not null default now(),
  constraint "scv_import_rows_batch_id_fkey" foreign key (batch_id) references public.scv_import_batches(id) on delete cascade,
  constraint "scv_import_rows_batch_id_row_number_key" unique (batch_id, row_number),
  constraint "scv_import_rows_certificate_status_check" check ((certificate_status = ANY (ARRAY['active'::text, 'expired'::text, 'suspended'::text, 'cancelled'::text]))),
  constraint "scv_import_rows_pkey" primary key (id),
  constraint "scv_import_rows_row_status_check"
    check ((row_status = ANY (ARRAY['pending'::text, 'valid'::text, 'invalid'::text, 'inserted'::text, 'updated'::text, 'skipped'::text])))
);

alter table "public"."scv_import_rows"
  enable row level security;

create index idx_scv_import_rows_batch_status on public.scv_import_rows using btree (batch_id, row_status, row_number);

create index idx_scv_import_rows_plate on public.scv_import_rows using btree (normalized_plate);

create policy "bob_full_read" on "public"."scv_import_rows"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "scv_import_rows_insert" on "public"."scv_import_rows"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.scv_import_batches b
  WHERE ((b.id = scv_import_rows.batch_id) AND ((b.organization_id IS NULL) OR public.is_admin_for_org(b.organization_id))))));

create policy "scv_import_rows_select" on "public"."scv_import_rows"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.scv_import_batches b
  where ((b.id = scv_import_rows.batch_id) AND ((b.organization_id is null) or public.org_access_allowed(b.organization_id))))));

create policy "scv_import_rows_update" on "public"."scv_import_rows"
  for update
  to PUBLIC
  using ((exists ( select 1
   from public.scv_import_batches b
  where ((b.id = scv_import_rows.batch_id) AND ((b.organization_id is null) or public.is_admin_for_org(b.organization_id))))))
  with check ((EXISTS ( SELECT 1
   FROM public.scv_import_batches b
  WHERE ((b.id = scv_import_rows.batch_id) AND ((b.organization_id IS NULL) OR public.is_admin_for_org(b.organization_id))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."scv_import_rows" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."scv_import_rows" is 'Per-row staging and validation result for canonical SCV CSV imports.';
