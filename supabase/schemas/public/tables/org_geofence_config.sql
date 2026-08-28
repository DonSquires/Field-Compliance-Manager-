create table "public"."org_geofence_config" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "config_key"      text                     not null,
  "config_value"    integer                  not null,
  "zone_type"       text,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "org_geofence_config_organization_id_config_key_zone_type_key" unique (organization_id, config_key, zone_type),
  constraint "org_geofence_config_pkey" primary key (id),
  constraint "org_geofence_config_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."org_geofence_config"
  enable row level security;

create policy "bob_full_read" on "public"."org_geofence_config"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ogc_delete" on "public"."org_geofence_config"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "ogc_insert" on "public"."org_geofence_config"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "ogc_select" on "public"."org_geofence_config"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ogc_update" on "public"."org_geofence_config"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."org_geofence_config" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."org_geofence_config" is 'Per-org geofence configuration (Q8 ruling). Keys: site_provisional_radius_m (default 50), zone_provisional_radius_m (default 100), checkpoint_radius_m (default 5). Optional zone_type for per-zone-type overrides.';
