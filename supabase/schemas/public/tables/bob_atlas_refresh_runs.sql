create table "public"."bob_atlas_refresh_runs" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "source_commit"      text,
  "source_branch"      text,
  "generated_at"       timestamp with time zone not null default now(),
  "refreshed_at"       timestamp with time zone not null default now(),
  "capability_total"   integer                  not null default 0,
  "edge_total"         integer                  not null default 0,
  "capability_upserts" integer                  not null default 0,
  "edge_upserts"       integer                  not null default 0,
  "retired_total"      integer                  not null default 0,
  "refresh_source"     text                     not null default 'ci_generator'::text,
  "created_at"         timestamp with time zone not null default now(),
  constraint "bob_atlas_refresh_runs_pkey" primary key (id),
  constraint "bob_atlas_refresh_runs_refresh_source_check"
    check ((refresh_source = ANY (ARRAY['ci_generator'::text, 'manual_seed'::text])))
);

alter table "public"."bob_atlas_refresh_runs"
  enable row level security;

create index idx_bob_atlas_refresh_runs_refreshed_at
  on public.bob_atlas_refresh_runs using btree (refreshed_at desc);

create policy "bob_atlas_refresh_runs_select" on "public"."bob_atlas_refresh_runs"
  for select
  to "authenticated"
  using (true);

grant select on table "public"."bob_atlas_refresh_runs" to "authenticated";

grant delete, insert, references, select, trigger, truncate, update
  on table "public"."bob_atlas_refresh_runs" to "service_role";

comment on table "public"."bob_atlas_refresh_runs" is
  'Provenance ledger for Atlas map refreshes. Records the source commit the capability map and edge graph were generated from so Bob can tell a current map from a stale one. Written only by scripts/atlas-refresh.js --apply; never hand-edited.';

comment on column "public"."bob_atlas_refresh_runs"."source_commit" is
  'Git commit of the repository the manifest was generated from. Null means provenance was unavailable at refresh time and the map must be treated as unverified.';
