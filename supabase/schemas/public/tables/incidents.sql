create table "public"."incidents" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "organization_id"    uuid                     not null,
  "officer_user_id"    uuid,
  "patrol_id"          uuid,
  "dispatch_job_id"    uuid,
  "location_id"        uuid,
  "incident_type"      text                     not null,
  "severity"           text                     not null default 'standard'::text,
  "description"        text,
  "status"             text                     not null default 'open'::text,
  "occurred_at"        timestamp with time zone not null default now(),
  "resolved_at"        timestamp with time zone,
  "created_at"         timestamp with time zone not null default now(),
  "client_site_id"     uuid,
  "zone_id"            uuid,
  "location_event_id"  uuid,
  "is_staff_sensitive" boolean                  not null default false,
  constraint "incidents_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id) on delete set null,
  constraint "incidents_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id),
  constraint "incidents_pkey" primary key (id),
  constraint "incidents_place_anchor_present_chk" check (((location_id IS NOT NULL) OR (client_site_id IS NOT NULL) OR (zone_id IS NOT NULL))),
  constraint "incidents_severity_check" check ((severity = ANY (ARRAY['low'::text, 'standard'::text, 'high'::text, 'critical'::text]))),
  constraint "incidents_status_check" check ((status = ANY (ARRAY['open'::text, 'in_review'::text, 'resolved'::text, 'escalated'::text]))),
  constraint "incidents_location_event_id_fkey" foreign key (location_event_id) references public.location_events(id) on delete set null,
  constraint "incidents_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete set null,
  constraint "incidents_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "incidents_patrol_id_fkey" foreign key (patrol_id) references public.patrols(id),
  constraint "incidents_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."incidents"
  enable row level security;

create index idx_incidents_client_site on public.incidents using btree (client_site_id);

create index idx_incidents_location_event on public.incidents using btree (location_event_id);

create index idx_incidents_zone on public.incidents using btree (zone_id);

create policy "bob_full_read" on "public"."incidents"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "incidents_insert" on "public"."incidents"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "incidents_place_reachable_select" on "public"."incidents"
  for select
  to "authenticated"
  using (((is_staff_sensitive = false) AND public.has_location_access(client_site_id, zone_id, 'client_reads_provider'::text)));

create policy "incidents_select" on "public"."incidents"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "incidents_update" on "public"."incidents"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."incidents" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."incidents"."is_staff_sensitive" is 'W1 carve-out marker (#343): true = an internal officer H&S / disciplinary / otherwise staff-sensitive incident that must NOT be place-widened to the site/zone client org. The operator org still sees it via the preserved org gate. Decoupled from the entity_links subject graph by owner ruling; a derived-from-subject-links form may come with the #344 graph extension.';

comment on constraint "incidents_place_anchor_present_chk" on "public"."incidents" is 'Nothing-orphaned guard: at least one of location_id (legacy) / client_site_id / zone_id must be set. Flexible anchor during the staged locations retire (#7).';

comment on policy "incidents_place_reachable_select" on "public"."incidents" is 'W1 place-anchored read (#343). Additive PERMISSIVE SELECT: the site/zone-owning (client) org sees the incident via has_location_access(client_site_id, zone_id, ''client_reads_provider'') -- UNLESS is_staff_sensitive = true, in which case the widening path is suppressed (officer-H&S carve-out, owner ruling #4) and only the preserved org gate (incidents_select) returns it to the operator. ORs with incidents_select; never replaces it. Writes untouched (W1 read-only). Legacy-only (location_id-only) rows not widened -> under-reach, fail-closed. Operationally corrected / Doctrinally incomplete.';

comment on table "public"."incidents" is 'Field incidents: confrontations, property damage, welfare concerns, and on-scene events.';
