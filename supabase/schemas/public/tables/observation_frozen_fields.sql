create table "public"."observation_frozen_fields" (
  "id"          bigint                   generated always as identity not null,
  "table_name"  text                     not null,
  "column_name" text                     not null,
  "reason"      text                     not null,
  "ratified_at" timestamp with time zone not null default now(),
  "ratified_by" text                     not null,
  constraint "observation_frozen_fields_pkey" primary key (id),
  constraint "observation_frozen_fields_unique" unique (table_name, column_name)
);

alter table "public"."observation_frozen_fields"
  enable row level security;

create policy "bob_full_read" on "public"."observation_frozen_fields"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "observation_frozen_fields_select" on "public"."observation_frozen_fields"
  for select
  to "authenticated"
  using (true);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."observation_frozen_fields" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."observation_frozen_fields"."column_name" is 'Column name as it appears in information_schema.columns.';

comment on column "public"."observation_frozen_fields"."ratified_at" is 'Timestamp of the owner ruling that added this row.';

comment on column "public"."observation_frozen_fields"."ratified_by" is 'Name of the person who ratified this row (owner-authored). Plain text — not a FK to user_profiles (owner may not be a platform user).';

comment on column "public"."observation_frozen_fields"."reason" is 'Why this field is frozen — the evidential or legal basis.';

comment on column "public"."observation_frozen_fields"."table_name" is 'Plain table name (e.g. ''observations''). No schema prefix.';

comment on table "public"."observation_frozen_fields" is 'Canonical contract: columns frozen at observation lock. Authoritative for Bob queries, Atlas drift-check, and trigger generation. Append-only by governance rule — no UPDATE/DELETE. A new Part 0 ruling is required to add or remove a row. Issue #315.';
