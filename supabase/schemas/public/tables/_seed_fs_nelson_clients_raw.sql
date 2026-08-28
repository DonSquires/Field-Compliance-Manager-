create table "public"."_seed_fs_nelson_clients_raw" (
  "bureau_id"                  text,
  "bureau_name"                text,
  "client_id"                  text,
  "client_name"                text,
  "client_address"             text,
  "client_suburb"              text,
  "client_postcode"            text,
  "client_state"               text,
  "patrol_type"                text,
  "onsite_datetime"            text,
  "offsite_datetime"           text,
  "comments"                   text,
  "is_incident_report"         text,
  "patrol_complete_status"     text,
  "visit_charge_ex_gst"        text,
  "despatch_zone"              text,
  "subcontractor"              text,
  "onsite_distance_from_site"  text,
  "time_onsite_variation_mins" text,
  "despatch_datetime"          text,
  "internal_clientid"          text,
  "internal_despatchid"        text
);

alter table "public"."_seed_fs_nelson_clients_raw"
  enable row level security;

create policy "bob_full_read" on "public"."_seed_fs_nelson_clients_raw"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."_seed_fs_nelson_clients_raw" to "anon", "authenticated", "postgres", "service_role";
