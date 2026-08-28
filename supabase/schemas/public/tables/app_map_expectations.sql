create table "public"."app_map_expectations" (
  "id"             uuid                     not null default gen_random_uuid(),
  "spine"          text                     not null,
  "from_type"      text                     not null,
  "from_name"      text                     not null,
  "to_type"        text                     not null,
  "to_name"        text                     not null,
  "assertion_kind" text                     not null,
  "via_type"       text,
  "via_name"       text,
  "evidence_class" text                     not null default 'authored-expectation'::text,
  "signal_weight"  numeric(3,2)             not null default 1.00,
  "rationale"      text,
  "authored_by"    text,
  "authored_at"    timestamp with time zone not null default now(),
  "status"         text                     not null default 'active'::text,
  "created_at"     timestamp with time zone not null default now(),
  "updated_at"     timestamp with time zone not null default now(),
  constraint "app_map_expectations_assertion_kind_check" check ((assertion_kind = ANY (ARRAY['must_reach'::text, 'must_not_reach'::text, 'must_pass_through'::text]))),
  constraint "app_map_expectations_evidence_class_check" check ((evidence_class = 'authored-expectation'::text)),
  constraint "app_map_expectations_from_type_check"
    check ((from_type = ANY (ARRAY['table'::text, 'column'::text, 'rpc'::text, 'edge_function'::text, 'feature'::text, 'route'::text, 'component'::text]))),
  constraint "app_map_expectations_pkey" primary key (id),
  constraint "app_map_expectations_signal_weight_check" check (((signal_weight >= (0)::numeric) AND (signal_weight <= (1)::numeric))),
  constraint "app_map_expectations_status_check" check ((status = ANY (ARRAY['active'::text, 'retired'::text, 'proposed'::text]))),
  constraint "app_map_expectations_to_type_check"
    check ((to_type = ANY (ARRAY['table'::text, 'column'::text, 'rpc'::text, 'edge_function'::text, 'feature'::text, 'route'::text, 'component'::text])))
);

alter table "public"."app_map_expectations"
  enable row level security;

create index idx_app_map_expectations_active on public.app_map_expectations using btree (status)
  where (status = 'active'::text);

create index idx_app_map_expectations_spine on public.app_map_expectations using btree (spine);

create unique index uniq_app_map_expectations_path on public.app_map_expectations using btree (spine, from_type, from_name, to_type, to_name, assertion_kind);

create policy "app_map_expectations_select" on "public"."app_map_expectations"
  for select
  to PUBLIC
  using (true);

create policy "bob_full_read" on "public"."app_map_expectations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."app_map_expectations" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."app_map_expectations" is 'App Atlas intent layer: human-authored path-assertions for expected operational flows. "Touching X must reach Y." Structured, not prose (distinct from bob_owner_rulings). The gap engine compares these against terrain edges (bob_app_map_edges) to detect misroute/bypass/broken-reach. NEVER machine-generated — intent must be authored. Issue #231, epic #228.';
