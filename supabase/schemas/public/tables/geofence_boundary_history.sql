create table "public"."geofence_boundary_history" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "entity_type"        text                     not null,
  "entity_id"          uuid                     not null,
  "boundary"           public.geometry,
  "boundary_source"    text,
  "verification_state" text,
  "verified_by"        uuid,
  "verified_at"        timestamp with time zone,
  "changed_by"         uuid,
  "changed_via"        text                     not null,
  "change_reason"      text,
  "version"            integer                  not null default 1,
  "created_at"         timestamp with time zone not null default now(),
  constraint "geofence_boundary_history_changed_via_check"
    check ((changed_via = ANY (ARRAY['governed_proposal'::text, 'direct_edit'::text, 'reconciliation'::text, 'refresh'::text, 'verification'::text, 'backfill'::text]))),
  constraint "geofence_boundary_history_entity_type_check" check ((entity_type = ANY (ARRAY['organization'::text, 'location_zone'::text, 'client_site'::text]))),
  constraint "geofence_boundary_history_pkey" primary key (id)
);

alter table "public"."geofence_boundary_history"
  enable row level security;

create index idx_gbh_changed_by on public.geofence_boundary_history using btree (changed_by)
  where (changed_by is not null);

create index idx_gbh_entity_type_id_created on public.geofence_boundary_history using btree (entity_type, entity_id, created_at desc);

create policy "bob_full_read" on "public"."geofence_boundary_history"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gbh_select" on "public"."geofence_boundary_history"
  for select
  to PUBLIC
  using (
CASE entity_type
    when 'organization'::text THEN public.org_access_allowed(entity_id)
    when 'location_zone'::text THEN public.org_access_allowed(( select location_zones.organization_id
       from public.location_zones
      where (location_zones.id = geofence_boundary_history.entity_id)))
    when 'client_site'::text THEN public.org_access_allowed(( select client_sites.client_organization_id
       from public.client_sites
      where (client_sites.id = geofence_boundary_history.entity_id)))
    ELSE false
end);

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."geofence_boundary_history" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."geofence_boundary_history" is 'Boundary versioning history for all geofence-bearing entities (org jurisdiction, zone, site). Q4 ruling: ALL boundaries versioned uniformly, any origin. Records verification state, boundary source, and actor. Phase 4 geofence redesign (#226).';
