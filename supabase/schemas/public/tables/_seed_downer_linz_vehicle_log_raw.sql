create table "public"."_seed_downer_linz_vehicle_log_raw" (
  "source_id"            text                     not null,
  "title"                text,
  "recorded_date"        text,
  "rego"                 text,
  "note"                 text,
  "attachments"          text,
  "modified"             text,
  "normalized_plate"     text,
  "resolved_zone_id"     uuid,
  "canonical_vehicle_id" uuid,
  "observation_id"       uuid,
  "processed_at"         timestamp with time zone,
  "error"                text,
  "created_at"           timestamp with time zone not null default now(),
  constraint "_seed_downer_linz_vehicle_log_raw_pkey" primary key (source_id)
);

alter table "public"."_seed_downer_linz_vehicle_log_raw"
  enable row level security;

create index idx_seed_downer_vehicle_log_unprocessed on public._seed_downer_linz_vehicle_log_raw using btree (processed_at)
  where (processed_at is null);

create policy "bob_full_read" on "public"."_seed_downer_linz_vehicle_log_raw"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."_seed_downer_linz_vehicle_log_raw"
  to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."_seed_downer_linz_vehicle_log_raw" is 'Raw staging table for Downer/LINZ historical vehicle log import (#163). CSV mirror + per-row import status. Service-role only; no anon/authenticated policies.';
