create table "public"."patrol_solve_cache" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "shift_id"            uuid                     not null,
  "travel_matrix"       jsonb                    not null default '[]'::jsonb,
  "solved_sequence"     jsonb                    not null default '[]'::jsonb,
  "solved_etas"         jsonb                    not null default '[]'::jsonb,
  "solved_sla_status"   jsonb                    not null default '[]'::jsonb,
  "shift_health"        text                     not null default 'on_track'::text,
  "stop_count"          integer                  not null default 0,
  "solved_at"           timestamp with time zone not null default now(),
  "cache_ttl_minutes"   integer                  not null default 10,
  "invalidated_at"      timestamp with time zone,
  "invalidation_reason" text,
  "officer_gps_lat"     double precision,
  "officer_gps_lng"     double precision,
  constraint "patrol_solve_cache_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "patrol_solve_cache_pkey" primary key (id),
  constraint "patrol_solve_cache_shift_health_check" check ((shift_health = ANY (ARRAY['on_track'::text, 'at_risk'::text, 'critical'::text, 'breached'::text]))),
  constraint "patrol_solve_cache_shift_id_key" unique (shift_id),
  constraint "patrol_solve_cache_shift_id_fkey" foreign key (shift_id) references public.shifts(id) on delete cascade
);

alter table "public"."patrol_solve_cache"
  enable row level security;

create index idx_psc_shift_id on public.patrol_solve_cache using btree (shift_id);

create policy "bob_full_read" on "public"."patrol_solve_cache"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "psc_insert" on "public"."patrol_solve_cache"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "psc_select" on "public"."patrol_solve_cache"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "psc_update" on "public"."patrol_solve_cache"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_solve_cache" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."patrol_solve_cache" is 'Cached OSRM travel matrix and OR-Tools route solution per shift. Invalidated on adhoc insertion, stop skip, or TTL expiry.';
