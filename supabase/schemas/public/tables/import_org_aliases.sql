create table "public"."import_org_aliases" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "alias_kind"      text                     not null,
  "alias_value"     text                     not null,
  "alias_norm"      text                     not null,
  "resolution"      text                     not null default 'client'::text,
  "confidence"      numeric,
  "source"          text,
  "notes"           text,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "import_org_aliases_pkey" primary key (id),
  constraint "import_org_aliases_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "import_org_aliases_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."import_org_aliases"
  enable row level security;

create index idx_import_org_aliases_org on public.import_org_aliases using btree (organization_id);

create unique index uq_import_org_aliases_norm on public.import_org_aliases using btree (alias_kind, alias_norm);

create policy "bob_full_read" on "public"."import_org_aliases"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "import_org_aliases_select" on "public"."import_org_aliases"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "import_org_aliases_write" on "public"."import_org_aliases"
  for all
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."import_org_aliases" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."import_org_aliases" is 'Learned import resolutions: a source identifier (bureau id/name, branch code, pay center) -> a real organization. Filled by Bob on human approval; starts empty. Never hardcode client mappings here in a migration.';
