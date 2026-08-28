create table "public"."locations" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "name"              text                     not null,
  "address"           text,
  "address_match_key" text,
  "suburb"            text,
  "postcode"          text,
  "notes"             text,
  "created_by"        uuid,
  "created_at"        timestamp with time zone not null default now(),
  "updated_at"        timestamp with time zone not null default now(),
  constraint "locations_pkey" primary key (id),
  constraint "locations_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "locations_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."locations"
  enable row level security;

create index idx_locations_org_match_key on public.locations using btree (organization_id, address_match_key);

create index idx_locations_org on public.locations using btree (organization_id);

create policy "bob_full_read" on "public"."locations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "locations_delete" on "public"."locations"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "locations_insert" on "public"."locations"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "locations_select" on "public"."locations"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "locations_update" on "public"."locations"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."locations" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."locations"."address" is 'Full street address of the location.';

comment on column "public"."locations"."address_match_key" is 'Normalised address key for deduplication and import matching (lowercase, stripped punctuation).';

comment on column "public"."locations"."created_by" is 'User who created this location record.';

comment on column "public"."locations"."name" is 'Human-readable name for the house / location (e.g. "12 Lowburn Terrace").';

comment on column "public"."locations"."notes" is 'Free-text notes about the location (access instructions, hazards, etc.).';

comment on column "public"."locations"."organization_id" is 'The CLIENT org that owns this physical place (place-axis ownership). A provider may patrol this place only when an active service_agreement authorises the cross-org link.';

comment on column "public"."locations"."postcode" is 'NZ postcode.';

comment on column "public"."locations"."suburb" is 'Suburb or locality name.';

comment on table "public"."locations" is 'A Location ("house") is the physical place, CLIENT-OWNED. It groups the Site facet (client_sites = addressed point) and Zone facet(s) (location_zones = area) as siblings via location_id. House-level details (address, suburb, postcode, notes) live here; finance is LINKED to the location, not duplicated per facet. Two-axis ownership: the client owns the place (this table); the provider owns the patrol scheduling (patrol_routes / client_site_patrol_config); the two are bridged by an ACTIVE service agreement that authorises the cross-org link (never by org equality).';
