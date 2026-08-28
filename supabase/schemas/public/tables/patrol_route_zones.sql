create table "public"."patrol_route_zones" (
  "patrol_route_id"           uuid                     not null,
  "zone_id"                   uuid                     not null,
  "coverage_priority"         integer                  not null default 1,
  "expected_visits_per_shift" integer,
  "preferred_time_window"     text,
  "required_module"           text,
  "notes"                     text,
  "created_at"                timestamp with time zone not null default now(),
  constraint "patrol_route_zones_pkey" primary key (patrol_route_id, zone_id),
  constraint "patrol_route_zones_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "patrol_route_zones_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id) on delete cascade
);

alter table "public"."patrol_route_zones"
  enable row level security;

create index idx_patrol_route_zones_zone_id on public.patrol_route_zones using btree (zone_id);

create trigger trg_validate_prz_access
  before insert on public.patrol_route_zones
  for each row
  execute function public.validate_assignment_location_access();

create policy "bob_full_read" on "public"."patrol_route_zones"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "patrol_route_zones_delete" on "public"."patrol_route_zones"
  for delete
  to PUBLIC
  using ((exists ( select 1
   from public.patrol_routes r
  where ((r.id = patrol_route_zones.patrol_route_id) AND public.is_admin_for_org(r.organization_id)))));

create policy "patrol_route_zones_insert" on "public"."patrol_route_zones"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.patrol_routes r
  WHERE ((r.id = patrol_route_zones.patrol_route_id) AND public.is_admin_for_org(r.organization_id)))));

create policy "patrol_route_zones_select" on "public"."patrol_route_zones"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.patrol_routes r
  where ((r.id = patrol_route_zones.patrol_route_id) AND public.org_access_allowed(r.organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_route_zones" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."patrol_route_zones" is 'Many-to-many coverage between patrol routes/runs and location zones.';
