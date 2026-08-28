create table "public"."patrol_route_sites" (
  "patrol_route_id"           uuid                     not null,
  "site_id"                   uuid                     not null,
  "coverage_priority"         integer                  not null default 1,
  "expected_visits_per_shift" integer,
  "preferred_time_window"     text,
  "required_module"           text,
  "notes"                     text,
  "created_at"                timestamp with time zone not null default now(),
  "preferred_stop_order"      integer                  not null default 0,
  "dwell_minutes"             integer                  not null default 15,
  "sla_arrive_within_minutes" integer                  not null default 30,
  constraint "patrol_route_sites_pkey" primary key (patrol_route_id, site_id),
  constraint "patrol_route_sites_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "patrol_route_sites_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id) on delete cascade
);

alter table "public"."patrol_route_sites"
  enable row level security;

create index idx_patrol_route_sites_site_id on public.patrol_route_sites using btree (site_id);

create trigger trg_validate_prs_access
  before insert on public.patrol_route_sites
  for each row
  execute function public.validate_assignment_location_access();

create policy "bob_full_read" on "public"."patrol_route_sites"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."patrol_route_sites"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "patrol_route_sites_delete" on "public"."patrol_route_sites"
  for delete
  to PUBLIC
  using ((exists ( select 1
   from public.patrol_routes r
  where ((r.id = patrol_route_sites.patrol_route_id) AND public.is_admin_for_org(r.organization_id)))));

create policy "patrol_route_sites_insert" on "public"."patrol_route_sites"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.patrol_routes r
  WHERE ((r.id = patrol_route_sites.patrol_route_id) AND public.is_admin_for_org(r.organization_id)))));

create policy "patrol_route_sites_select" on "public"."patrol_route_sites"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.patrol_routes r
  where ((r.id = patrol_route_sites.patrol_route_id) AND public.org_access_allowed(r.organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_route_sites" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."patrol_route_sites" is 'Many-to-many coverage between patrol routes/runs and client sites.';
