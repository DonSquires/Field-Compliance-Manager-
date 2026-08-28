create table "public"."client_site_zones" (
  "id"                       uuid  not null default gen_random_uuid(),
  "site_id"                  uuid,
  "organization_id"          uuid  not null,
  "name"                     text  not null,
  "module_key"               text  not null,
  "jurisdiction_rule_set_id" uuid,
  "metadata"                 jsonb not null default '{}'::jsonb,
  constraint "client_site_zones_pkey" primary key (id),
  constraint "client_site_zones_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "client_site_zones_jurisdiction_rule_set_id_fkey" foreign key (jurisdiction_rule_set_id) references public.jurisdiction_rule_sets(id),
  constraint "client_site_zones_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."client_site_zones"
  enable row level security;

create policy "bob_full_read" on "public"."client_site_zones"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "client_site_zones_select" on "public"."client_site_zones"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."client_site_zones" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."client_site_zones" is 'Patrol, enforcement, noise, biosecurity, or access-control areas within a client site.';
