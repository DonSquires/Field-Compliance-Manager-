create table "public"."access_presets" (
  "id"              uuid                     not null default gen_random_uuid(),
  "key"             text                     not null,
  "name"            text                     not null,
  "description"     text,
  "role"            text,
  "grants"          jsonb                    not null default '{}'::jsonb,
  "module_access"   text[]                   not null default '{}'::text[],
  "permissions"     jsonb                    not null default '{}'::jsonb,
  "organization_id" uuid,
  "is_system"       boolean                  not null default false,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "access_presets_pkey" primary key (id),
  constraint "access_presets_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "access_presets_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."access_presets"
  enable row level security;

create index idx_access_presets_org on public.access_presets using btree (organization_id);

create unique index uq_access_presets_key_global on public.access_presets using btree (key)
  where (organization_id is null);

create unique index uq_access_presets_key_org on public.access_presets using btree (key, organization_id)
  where (organization_id is not null);

create trigger trg_touch_access_presets
  before update on public.access_presets
  for each row
  execute function public.tg_touch_updated_at();

create policy "access_presets_select" on "public"."access_presets"
  for select
  to PUBLIC
  using (((organization_id is null) or public.is_grand_master() or (organization_id = ANY (public.get_descendant_organizations(( select user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid())))))));

create policy "access_presets_write" on "public"."access_presets"
  for all
  to PUBLIC
  using (public.is_master_or_above())
  with check (public.is_master_or_above());

create policy "bob_full_read" on "public"."access_presets"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."access_presets"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."access_presets" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."access_presets"."grants" is 'jsonb map of functional_area -> level (view|verify|approve|adjust|manage).';

comment on table "public"."access_presets" is 'Runtime-editable named roles: a bundle of functional-area:level grants. Global (organization_id null) or org-custom. Editable by master/grand_master - this is what enables new roles without a schema change (issue #3).';
