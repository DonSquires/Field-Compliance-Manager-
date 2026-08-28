create table "public"."shifts" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "organization_id"       uuid                     not null,
  "officer_user_id"       uuid                     not null,
  "service_type"          text                     not null,
  "location_id"           uuid,
  "zone_id"               uuid,
  "scheduled_start"       timestamp with time zone not null,
  "scheduled_end"         timestamp with time zone not null,
  "actual_start"          timestamp with time zone,
  "actual_end"            timestamp with time zone,
  "status"                text                     not null default 'scheduled'::text,
  "notes"                 text,
  "created_at"            timestamp with time zone not null default now(),
  "patrol_route_id"       uuid,
  "generated_at"          timestamp with time zone,
  "shift_health"          text,
  "osrm_matrix_cached_at" timestamp with time zone,
  "total_stops"           integer                  not null default 0,
  "completed_stops"       integer                  not null default 0,
  "external_refs"         jsonb                    not null default '{}'::jsonb,
  constraint "shifts_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "shifts_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id),
  constraint "shifts_pkey" primary key (id),
  constraint "shifts_shift_health_check" check ((shift_health = ANY (ARRAY['on_track'::text, 'at_risk'::text, 'critical'::text, 'breached'::text]))),
  constraint "shifts_status_check"
    check ((status = ANY (ARRAY['scheduled'::text, 'published'::text, 'accepted'::text, 'declined'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text]))),
  constraint "shifts_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "shifts_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."shifts"
  enable row level security;

create index idx_shifts_external_refs on public.shifts using gin (external_refs);

create index idx_shifts_officer on public.shifts using btree (officer_user_id);

create index idx_shifts_patrol_route_id on public.shifts using btree (patrol_route_id);

create policy "bob_full_read" on "public"."shifts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "shifts_insert" on "public"."shifts"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "shifts_select" on "public"."shifts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "shifts_update" on "public"."shifts"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."shifts" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."shifts"."external_refs" is 'Generic external system reference IDs. E.g. {"deputy": {"timesheet_id": "59199448"}}';

comment on column "public"."shifts"."patrol_route_id" is 'Optional named patrol route/run assigned to this shift. Used for mobile patrols covering multiple sites/zones.';

comment on table "public"."shifts" is 'Officer shift records. Links officer, service type, location, and roster status.';
