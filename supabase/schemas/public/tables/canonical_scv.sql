create table "public"."canonical_scv" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "plate_number"       text                     not null,
  "certificate_number" text,
  "certificate_status" text                     not null default 'active'::text,
  "issued_date"        date,
  "expiry_date"        date,
  "vehicle_make"       text,
  "vehicle_model"      text,
  "vehicle_year"       integer,
  "nzscv_raw"          jsonb,
  "last_checked_at"    timestamp with time zone not null default now(),
  "created_at"         timestamp with time zone not null default now(),
  "updated_at"         timestamp with time zone not null default now(),
  "source"             text                     not null default 'csv_import'::text,
  "import_batch_id"    uuid,
  "imported_at"        timestamp with time zone,
  "raw_source_row"     jsonb                    not null default '{}'::jsonb,
  constraint "canonical_scv_certificate_status_check" check ((certificate_status = ANY (ARRAY['active'::text, 'expired'::text, 'suspended'::text, 'cancelled'::text]))),
  constraint "canonical_scv_pkey" primary key (id),
  constraint "canonical_scv_plate_number_key" unique (plate_number),
  constraint "canonical_scv_source_check" check ((source = ANY (ARRAY['csv_import'::text, 'nzscv_api'::text, 'manual'::text, 'legacy'::text])))
);

alter table "public"."canonical_scv"
  enable row level security;

create index idx_canonical_scv_expiry on public.canonical_scv using btree (expiry_date);

create index idx_canonical_scv_import_batch on public.canonical_scv using btree (import_batch_id);

create index idx_canonical_scv_plate on public.canonical_scv using btree (plate_number);

create policy "bob_full_read" on "public"."canonical_scv"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."canonical_scv" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."canonical_scv" is 'SCV certification per plate. Source of truth: NZSCV registry. Synced via proxy-server.';
