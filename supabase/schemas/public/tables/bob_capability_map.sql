create table "public"."bob_capability_map" (
  "id"                uuid                     not null default gen_random_uuid(),
  "entity_type"       text                     not null,
  "entity_name"       text                     not null,
  "present"           boolean                  not null default false,
  "wired"             boolean                  not null default false,
  "exercised"         boolean,
  "caller_summary"    text,
  "notes"             text,
  "last_refreshed_at" timestamp with time zone not null default now(),
  "refresh_source"    text,
  "created_at"        timestamp with time zone not null default now(),
  "updated_at"        timestamp with time zone not null default now(),
  "retirement_status" text                     not null default 'live'::text,
  constraint "bob_capability_map_entity_type_check" check ((entity_type = ANY (ARRAY['table'::text, 'column'::text, 'rpc'::text, 'edge_function'::text, 'feature'::text]))),
  constraint "bob_capability_map_pkey" primary key (id)
);

alter table "public"."bob_capability_map"
  enable row level security;

create index idx_bob_capability_map_type on public.bob_capability_map using btree (entity_type);

create index idx_bob_capability_map_unwired on public.bob_capability_map using btree (entity_type)
  where ((present = true) AND (wired = false));

create unique index uniq_bob_capability_map_entity on public.bob_capability_map using btree (entity_type, entity_name);

create policy "bob_capability_map_select" on "public"."bob_capability_map"
  for select
  to PUBLIC
  using (true);

create policy "bob_full_read" on "public"."bob_capability_map"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."bob_capability_map" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."bob_capability_map"."retirement_status" is 'Compatibility column for Atlas/Bob queries; canonical retirement state is tracked at edge level in public.bob_app_map_edges.retirement_status.';

comment on table "public"."bob_capability_map" is 'Truth Protocol capability map: classifies schema entities as present/wired/exercised. Bob queries this via sql_read to distinguish schema-presence from live-wiring. Populated by the CI generator job (bob:refresh-capability-map). Issue #231, epic #228 (Bob reconstitution).';
