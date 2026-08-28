create table "public"."import_place_aliases" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "alias_kind"      text                     not null,
  "alias_value"     text                     not null,
  "alias_norm"      text                     not null,
  "place_type"      text                     not null,
  "client_site_id"  uuid,
  "zone_id"         uuid,
  "confidence"      numeric,
  "source"          text,
  "notes"           text,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "import_place_aliases_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id) on delete cascade,
  constraint "import_place_aliases_pkey" primary key (id),
  constraint "import_place_aliases_place_xor" check ((((place_type = 'site'::text) AND (client_site_id IS
    NOT NULL) AND (zone_id IS NULL)) OR ((place_type = 'zone'::text) AND (zone_id IS NOT NULL) AND (client_site_id IS NULL)))),
  constraint "import_place_aliases_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "import_place_aliases_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "import_place_aliases_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."import_place_aliases"
  enable row level security;

create index idx_import_place_aliases_site on public.import_place_aliases using btree (client_site_id);

create index idx_import_place_aliases_zone on public.import_place_aliases using btree (zone_id);

create unique index uq_import_place_aliases_norm on public.import_place_aliases using btree (organization_id, alias_kind, alias_norm);

create policy "bob_full_read" on "public"."import_place_aliases"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "import_place_aliases_select" on "public"."import_place_aliases"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "import_place_aliases_write" on "public"."import_place_aliases"
  for all
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."import_place_aliases" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."import_place_aliases" is 'Learned import resolutions: a source place identifier (Client ID, location code/name) -> a Site (client_sites) XOR Zone (location_zones). Filled by Bob on human approval; starts empty.';
