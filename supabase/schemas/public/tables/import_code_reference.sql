create table "public"."import_code_reference" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid,
  "code_system"     text                     not null,
  "code_value"      text                     not null,
  "code_norm"       text                     not null,
  "meaning"         text                     not null,
  "maps_to_domain"  text,
  "maps_to_value"   text,
  "source"          text,
  "confidence"      numeric,
  "notes"           text,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "import_code_reference_pkey" primary key (id),
  constraint "import_code_reference_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "import_code_reference_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."import_code_reference"
  enable row level security;

create index idx_import_code_reference_system on public.import_code_reference using btree (code_system);

create unique index uq_import_code_reference_norm on public.import_code_reference
  using btree (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), code_system, code_norm);

create policy "bob_full_read" on "public"."import_code_reference"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "import_code_reference_select" on "public"."import_code_reference"
  for select
  to PUBLIC
  using (((organization_id is null) or public.org_access_allowed(organization_id)));

create policy "import_code_reference_write" on "public"."import_code_reference"
  for all
  to PUBLIC
  using (((organization_id is not null) AND public.is_admin_for_org(organization_id)))
  with check (((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."import_code_reference" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."import_code_reference" is 'Learnable decode table for coded values in imports (area/service/role/pay-centre/cost-centre/warden codes). organization_id null = platform-wide. Filled by Bob from reference documents on human approval; used to interpret tabular + document imports. Starts empty.';
