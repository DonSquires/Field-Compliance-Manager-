create table "public"."location_events" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "client_site_id"       uuid,
  "zone_id"              uuid,
  "checkpoint_id"        uuid,
  "event_type"           text                     not null,
  "module_key"           text,
  "occurred_at"          timestamp with time zone not null default now(),
  "status"               text,
  "source"               text,
  "external_ref"         text,
  "payload"              jsonb                    not null default '{}'::jsonb,
  "created_by"           uuid,
  "created_at"           timestamp with time zone not null default now(),
  "observed_entity_type" text,
  "observed_entity_id"   uuid,
  constraint "location_events_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id) on delete cascade,
  constraint "location_events_observed_entity_type_check" check ((observed_entity_type = ANY (ARRAY['vehicle'::text, 'person'::text, 'place'::text, 'staff'::text]))),
  constraint "location_events_pkey" primary key (id),
  constraint "location_events_place_xor" check ((((client_site_id IS NOT NULL) AND (zone_id IS NULL)) OR ((client_site_id IS NULL) AND (zone_id IS NOT NULL)))),
  constraint "location_events_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "location_events_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "location_events_checkpoint_id_fkey" foreign key (checkpoint_id) references public.patrol_checkpoints(id) on delete set null,
  constraint "location_events_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."location_events"
  enable row level security;

create index idx_location_events_entity on public.location_events using btree (observed_entity_type, observed_entity_id, occurred_at desc);

create index idx_location_events_org_type on public.location_events using btree (organization_id, event_type);

create index idx_location_events_payload_gin on public.location_events using gin (payload);

create index idx_location_events_site_time on public.location_events using btree (client_site_id, occurred_at desc);

create index idx_location_events_zone_time on public.location_events using btree (zone_id, occurred_at desc);

create unique index uq_location_events_source_ref on public.location_events using btree (organization_id, event_type, external_ref)
  where (external_ref is not null);

create policy "bob_full_read" on "public"."location_events"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "loc_events_insert" on "public"."location_events"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "loc_events_select" on "public"."location_events"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "loc_events_update" on "public"."location_events"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "location_events_client_select" on "public"."location_events"
  for select
  to PUBLIC
  using (public.has_location_access(client_site_id, zone_id, 'client_reads_provider'::text));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."location_events" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."location_events"."observed_entity_id" is 'Id of the observed entity, interpreted per observed_entity_type. Polymorphic (no FK) so one stream serves all entity kinds; integrity is by convention + Bob reasoning.';

comment on column "public"."location_events"."observed_entity_type" is 'What/who this event is about: vehicle (canonical_vehicles) | person (persons) | place (client_sites/location_zones) | staff (user_profiles). NULL = a pure place event. Detail lives in payload.';

comment on table "public"."location_events" is 'Unified per-place event stream. Every module writes typed events against a Site (client_site_id) XOR Zone (zone_id), optional checkpoint. Detail may stay in module tables (dual-write) referenced via external_ref/payload.';
