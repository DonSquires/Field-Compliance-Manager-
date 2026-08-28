create table "public"."fs_nelson_clients_clean" (
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

alter table "public"."fs_nelson_clients_clean"
  enable row level security;

create policy "bob_full_read" on "public"."fs_nelson_clients_clean"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."fs_nelson_clients_clean" to "anon", "authenticated", "postgres", "service_role";
