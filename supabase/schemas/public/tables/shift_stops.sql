create table "public"."shift_stops" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "organization_id"        uuid                     not null,
  "shift_id"               uuid                     not null,
  "patrol_config_id"       uuid,
  "site_id"                uuid,
  "zone_id"                uuid,
  "module_key"             text                     not null,
  "stop_order"             integer                  not null default 0,
  "visit_number"           integer                  not null default 1,
  "is_adhoc"               boolean                  not null default false,
  "dispatch_job_id"        uuid,
  "sla_window_open"        timestamp with time zone,
  "sla_arrive_by"          timestamp with time zone not null,
  "sla_depart_by"          timestamp with time zone,
  "required_dwell_minutes" integer                  not null default 15,
  "estimated_arrival_at"   timestamp with time zone,
  "estimated_departure_at" timestamp with time zone,
  "travel_distance_metres" integer,
  "travel_time_seconds"    integer,
  "sla_status"             text                     not null default 'on_track'::text,
  "actual_arrived_at"      timestamp with time zone,
  "actual_departed_at"     timestamp with time zone,
  "status"                 text                     not null default 'pending'::text,
  "officer_notes"          text,
  "arrived_gps_lat"        double precision,
  "arrived_gps_lng"        double precision,
  "created_at"             timestamp with time zone not null default now(),
  "updated_at"             timestamp with time zone not null default now(),
  "external_dispatch_id"   text,
  "external_refs"          jsonb                    not null default '{}'::jsonb,
  constraint "shift_stops_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "shift_stops_patrol_config_id_fkey" foreign key (patrol_config_id) references public.client_site_patrol_config(id) on delete set null,
  constraint "shift_stops_pkey" primary key (id),
  constraint "shift_stops_place_xor" check (((site_id IS NOT NULL) <> (zone_id IS NOT NULL))),
  constraint "shift_stops_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "shift_stops_sla_status_check" check ((sla_status = ANY (ARRAY['on_track'::text, 'at_risk'::text, 'breached'::text, 'completed'::text, 'skipped'::text]))),
  constraint "shift_stops_status_check" check ((status = ANY (ARRAY['pending'::text, 'en_route'::text, 'on_scene'::text, 'completed'::text, 'skipped'::text, 'cancelled'::text]))),
  constraint "shift_stops_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "shift_stops_shift_id_fkey" foreign key (shift_id) references public.shifts(id) on delete cascade
);

alter table "public"."shift_stops"
  enable row level security;

create unique index idx_shift_stops_external_dispatch_id on public.shift_stops using btree (organization_id, external_dispatch_id)
  where (external_dispatch_id is not null);

create index idx_shift_stops_external_refs on public.shift_stops using gin (external_refs);

create index idx_shift_stops_shift_id on public.shift_stops using btree (shift_id);

create index idx_shift_stops_shift on public.shift_stops using btree (shift_id);

create index idx_shift_stops_site_id on public.shift_stops using btree (site_id);

create index idx_shift_stops_site on public.shift_stops using btree (site_id)
  where (site_id is not null);

create index idx_shift_stops_sla on public.shift_stops using btree (shift_id, sla_status);

create index idx_shift_stops_status on public.shift_stops using btree (shift_id, status);

create index idx_shift_stops_zone on public.shift_stops using btree (zone_id)
  where (zone_id is not null);

create policy "bob_full_read" on "public"."shift_stops"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "shift_stops_insert" on "public"."shift_stops"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "shift_stops_select" on "public"."shift_stops"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "shift_stops_update" on "public"."shift_stops"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."shift_stops" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."shift_stops"."external_dispatch_id" is 'External dispatch/job ID from the source billing system (e.g. Wilsar Internal DespatchId: 59199448). Used for per-visit billing reconciliation.';

comment on column "public"."shift_stops"."external_refs" is 'Generic external system reference IDs for this patrol visit. E.g. {"wilsar": {"dispatch_id": "59199448", "client_id": "NCC200", "visit_charge_exgst": "6.05", "status": "Completed"}}';

comment on column "public"."shift_stops"."zone_id" is 'The zone attended at this stop, when the stop is a ZONE rather than a SITE (unified stop model, !709). Exactly one of site_id / zone_id is set (shift_stops_place_xor).';

comment on table "public"."shift_stops" is 'Materialised stop list per shift. Generated from client_site_patrol_config when shift is published. SLA windows locked at generation. Updated live by the patrol engine.';
