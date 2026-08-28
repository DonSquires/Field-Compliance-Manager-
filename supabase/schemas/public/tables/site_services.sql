create table "public"."site_services" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "site_id"              uuid,
  "organization_id"      uuid                     not null,
  "service_agreement_id" uuid,
  "module_key"           text                     not null,
  "service_hours"        jsonb                    not null default '{}'::jsonb,
  "response_sla_minutes" integer,
  "special_instructions" text,
  "active"               boolean                  not null default true,
  "created_at"           timestamp with time zone not null default now(),
  "zone_id"              uuid,
  "enabled"              boolean                  not null default true,
  "config"               jsonb                    not null default '{}'::jsonb,
  "created_by"           uuid,
  constraint "site_services_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "site_services_pkey" primary key (id),
  constraint "site_services_place_xor" check ((((site_id IS NOT NULL) AND (zone_id IS NULL)) OR ((site_id IS NULL) AND (zone_id IS NOT NULL)))),
  constraint "site_services_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id),
  constraint "site_services_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "site_services_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "site_services_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."site_services"
  enable row level security;

create index idx_site_services_org_module on public.site_services using btree (organization_id, module_key);

create index idx_site_services_site on public.site_services using btree (site_id);

create index idx_site_services_zone on public.site_services using btree (zone_id);

create policy "bob_full_read" on "public"."site_services"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "place_services_insert" on "public"."site_services"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "place_services_select" on "public"."site_services"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "place_services_update" on "public"."site_services"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "site_services_agreement_select" on "public"."site_services"
  for select
  to PUBLIC
  using ((public.has_location_access(site_id, zone_id, 'provider_reads_client'::text) or public.has_location_access(site_id, zone_id, 'client_reads_provider'::text)));

create policy "site_services_insert" on "public"."site_services"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "site_services_select" on "public"."site_services"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "site_services_update" on "public"."site_services"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."site_services" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."site_services" is 'Per-place service selection: which modules are active at a Site (site_id) XOR Zone (zone_id). Composes with organization_modules (org bought it) + access profiles (user may touch it).';
