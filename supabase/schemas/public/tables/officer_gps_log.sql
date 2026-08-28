create table "public"."officer_gps_log" (
  "id"               uuid                        not null default gen_random_uuid(),
  "organization_id"  uuid                        not null,
  "officer_id"       uuid                        not null,
  "gps_point"        public.geometry(Point,4326) not null,
  "gps_lat"          double precision            not null,
  "gps_lng"          double precision            not null,
  "detected_zone_id" uuid,
  "activity_type"    text                        not null default 'gps_update'::text,
  "accuracy_meters"  double precision,
  "heading"          double precision,
  "speed_kmh"        double precision,
  "created_at"       timestamp with time zone    not null default now(),
  constraint "officer_gps_log_activity_type_check"
    check ((activity_type = ANY (ARRAY['gps_update'::text, 'shift_start'::text, 'shift_end'::text, 'scan'::text, 'welfare_checkin'::text, 'sos'::text, 'checkpoint_scan'::text]))),
  constraint "officer_gps_log_detected_zone_id_fkey" foreign key (detected_zone_id) references public.location_zones(id),
  constraint "officer_gps_log_pkey" primary key (id),
  constraint "officer_gps_log_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "officer_gps_log_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id)
);

alter table "public"."officer_gps_log"
  enable row level security;

create index idx_officer_gps_log_officer on public.officer_gps_log using btree (officer_id, created_at desc);

create index idx_officer_gps_log_org_time on public.officer_gps_log using btree (organization_id, created_at desc);

create index idx_officer_gps_log_point on public.officer_gps_log using gist (gps_point);

create trigger officer_gps_log_point_trigger
  before insert on public.officer_gps_log
  for each row
  execute function public.officer_gps_log_set_point();

create policy "bob_full_read" on "public"."officer_gps_log"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "officer_gps_log_insert" on "public"."officer_gps_log"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "officer_gps_log_select" on "public"."officer_gps_log"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."officer_gps_log" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."officer_gps_log" is 'GPS heartbeat from officers. Used for live map, welfare, zone detection, and patrol audit.';
