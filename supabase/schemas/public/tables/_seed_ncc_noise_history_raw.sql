create table "public"."_seed_ncc_noise_history_raw" (
  "dispatch_id"          text                     not null,
  "bureau_id"            text,
  "bureau_name"          text,
  "client_id"            text,
  "client_name"          text,
  "client_address"       text,
  "client_suburb"        text,
  "client_postcode"      text,
  "alarm_response_dt"    text,
  "onsite_dt"            text,
  "offsite_dt"           text,
  "shift"                text,
  "time_to_respond_mins" text,
  "time_onsite_mins"     text,
  "despatch_comments"    text,
  "followup_info"        text,
  "charge_total"         text,
  "despatch_zone"        text,
  "docket_no"            text,
  "organization_id"      uuid,
  "agreement_id"         uuid,
  "noise_assessment_id"  uuid,
  "received_at"          timestamp with time zone,
  "arrived_at"           timestamp with time zone,
  "departed_at"          timestamp with time zone,
  "processed_at"         timestamp with time zone,
  "error"                text,
  "created_at"           timestamp with time zone not null default now(),
  constraint "_seed_ncc_noise_history_raw_pkey" primary key (dispatch_id)
);

alter table "public"."_seed_ncc_noise_history_raw"
  enable row level security;

create index idx_seed_ncc_noise_unprocessed on public._seed_ncc_noise_history_raw using btree (processed_at)
  where (processed_at is null);

create policy "bob_full_read" on "public"."_seed_ncc_noise_history_raw"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."_seed_ncc_noise_history_raw" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."_seed_ncc_noise_history_raw" is 'Raw staging table for NCC Wilsar historic noise CSV import (#164). CSV mirror + per-row import status. Service-role only; no anon/authenticated policies.';
