create table "public"."canonical_ta_names" (
  "id"                uuid                     not null default gen_random_uuid(),
  "ta_name"           text                     not null,
  "source"            text                     not null default 'nzta_featureserver'::text,
  "last_refreshed_at" timestamp with time zone not null default now(),
  "created_at"        timestamp with time zone not null default now(),
  constraint "canonical_ta_names_pkey" primary key (id),
  constraint "canonical_ta_names_ta_name_key" unique (ta_name)
);

alter table "public"."canonical_ta_names"
  enable row level security;

alter table "public"."canonical_ta_names"
  add column "ta_name_upper" text generated always as (upper(ta_name)) stored not null;

create index idx_canonical_ta_names_upper on public.canonical_ta_names using btree (upper(ta_name));

create policy "bob_full_read" on "public"."canonical_ta_names"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "canonical_ta_names_select_authenticated" on "public"."canonical_ta_names"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."canonical_ta_names" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."canonical_ta_names" is 'Canonical NZ Territorial Authority names. Populated from the LIVE NZTA FeatureServer (Q1 ruling: never a hardcoded list). Used for proposal-time validation of district_names in set_org_jurisdiction and create_patrol_route_service_area. Phase 2 of the geofence redesign (epic #226).';
