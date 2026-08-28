create table "public"."patrol_checkpoints" (
  "id"                      uuid                     not null default gen_random_uuid(),
  "organization_id"         uuid                     not null,
  "location_id"             uuid,
  "name"                    text                     not null,
  "description"             text,
  "gps_lat"                 double precision,
  "gps_lng"                 double precision,
  "qr_code"                 text,
  "active"                  boolean                  not null default true,
  "created_at"              timestamp with time zone not null default now(),
  "client_site_id"          uuid,
  "radius_meters"           integer                  not null default 5,
  "checkpoint_verification" text                     not null default 'unverified'::text,
  "checkpoint_verified_by"  uuid,
  "checkpoint_verified_at"  timestamp with time zone,
  "zone_id"                 uuid,
  constraint "patrol_checkpoints_checkpoint_verification_check" check ((checkpoint_verification = ANY (ARRAY['unverified'::text, 'verified'::text]))),
  constraint "patrol_checkpoints_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id) on delete set null,
  constraint "patrol_checkpoints_one_anchor_chk" check ((num_nonnulls(client_site_id, zone_id) = 1)),
  constraint "patrol_checkpoints_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "patrol_checkpoints_pkey" primary key (id),
  constraint "patrol_checkpoints_qr_code_key" unique (qr_code),
  constraint "patrol_checkpoints_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "patrol_checkpoints_checkpoint_verified_by_fkey" foreign key (checkpoint_verified_by) references public.user_profiles(id)
);

alter table "public"."patrol_checkpoints"
  enable row level security;

create index idx_patrol_checkpoints_client_site on public.patrol_checkpoints using btree (client_site_id);

create policy "bob_full_read" on "public"."patrol_checkpoints"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "patrol_checkpoints_delete" on "public"."patrol_checkpoints"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "patrol_checkpoints_insert" on "public"."patrol_checkpoints"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "patrol_checkpoints_select" on "public"."patrol_checkpoints"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "patrol_checkpoints_update" on "public"."patrol_checkpoints"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_checkpoints" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."patrol_checkpoints"."client_site_id" is 'The site this checkpoint belongs to (Tier 3 of the geofence hierarchy). Anchor for geofence nesting AND per-site KPI/reporting rollups (checkpoint -> site -> client org -> provider branch). Nullable + ON DELETE SET NULL so deleting a site preserves checkpoint history.';

comment on column "public"."patrol_checkpoints"."radius_meters" is 'Radius (metres) of the small on-checkpoint proximity zone (Tier 4). Owner default 5 m. An officer within this radius of the checkpoint point registers the checkpoint.';

comment on table "public"."patrol_checkpoints" is 'QR checkpoint definitions. Officers scan these to prove attendance at patrol route stops.';
