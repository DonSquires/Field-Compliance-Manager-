create table "public"."entity_links" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "from_type"       text                     not null,
  "from_id"         uuid                     not null,
  "to_type"         text                     not null,
  "to_id"           uuid                     not null,
  "relationship"    text                     not null,
  "evidence"        jsonb                    not null default '{}'::jsonb,
  "active"          boolean                  not null default true,
  "starts_at"       timestamp with time zone,
  "ends_at"         timestamp with time zone,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "entity_links_from_type_check" check ((from_type = ANY (ARRAY['vehicle'::text, 'person'::text, 'place'::text, 'staff'::text]))),
  constraint "entity_links_pkey" primary key (id),
  constraint "entity_links_to_type_check" check ((to_type = ANY (ARRAY['vehicle'::text, 'person'::text, 'place'::text, 'staff'::text]))),
  constraint "entity_links_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "entity_links_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."entity_links"
  enable row level security;

create index idx_entity_links_from on public.entity_links using btree (from_type, from_id)
  where active;

create index idx_entity_links_org on public.entity_links using btree (organization_id);

create index idx_entity_links_to on public.entity_links using btree (to_type, to_id)
  where active;

create unique index uq_entity_links_edge on public.entity_links using btree (organization_id, from_type, from_id, to_type, to_id, relationship)
  where active;

create policy "bob_full_read" on "public"."entity_links"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "entity_links_select" on "public"."entity_links"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "entity_links_write" on "public"."entity_links"
  for all
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."entity_links" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."entity_links" is 'Polymorphic relationship graph between canonical entities (vehicle/person/place/staff). Org-scoped. Generalises person_vehicle_links. Enables cross-entity intelligence (driver of a vehicle, trespass from a site, POI<->staff match) without merging records.';
