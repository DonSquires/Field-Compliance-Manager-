create table "public"."client_site_patrol_config" (
  "id"                             uuid                     not null default gen_random_uuid(),
  "organization_id"                uuid                     not null,
  "site_id"                        uuid,
  "patrol_route_id"                uuid,
  "module_key"                     text                     not null,
  "active_days"                    integer[]                not null default '{1,2,3,4,5,6,7}'::integer[],
  "visits_per_shift"               integer                  not null default 1,
  "min_gap_between_visits_minutes" integer                  not null default 60,
  "time_window_type"               text                     not null default 'fixed'::text,
  "window_start"                   time without time zone,
  "window_end"                     time without time zone,
  "sunrise_offset_minutes"         integer                  not null default 0,
  "sunset_offset_minutes"          integer                  not null default 0,
  "active_months"                  integer[]                not null default '{}'::integer[],
  "dwell_minutes"                  integer                  not null default 15,
  "sla_arrive_within_minutes"      integer                  not null default 30,
  "sla_depart_within_minutes"      integer                  not null default 45,
  "preferred_stop_order"           integer                  not null default 0,
  "officer_instructions"           text,
  "required_actions"               jsonb                    not null default '[]'::jsonb,
  "active"                         boolean                  not null default true,
  "created_at"                     timestamp with time zone not null default now(),
  "updated_at"                     timestamp with time zone not null default now(),
  "zone_id"                        uuid,
  constraint "client_site_patrol_config_dwell_minutes_check" check ((dwell_minutes >= 1)),
  constraint "client_site_patrol_config_module_key_check"
    check
    ((module_key = ANY (ARRAY['freedom_camping'::text, 'parking_enforcement'::text, 'noise_control'::text, 'biosecurity'::text, 'smoke_complaints'::text, 'static_guarding'::text,
    'access_control'::text, 'ems'::text, 'alarm_response'::text, 'welfare_check'::text, 'general_patrol'::text]))),
  constraint "client_site_patrol_config_pkey" primary key (id),
  constraint "client_site_patrol_config_site_id_patrol_route_id_module_ke_key" unique (site_id, patrol_route_id, module_key),
  constraint "client_site_patrol_config_time_window_type_check" check ((time_window_type = ANY (ARRAY['fixed'::text, 'sunrise_sunset'::text, 'seasonal'::text]))),
  constraint "client_site_patrol_config_visits_per_shift_check" check ((visits_per_shift >= 1)),
  constraint "cspc_place_xor" check (((site_id IS NOT NULL) <> (zone_id IS NOT NULL))),
  constraint "client_site_patrol_config_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "client_site_patrol_config_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "client_site_patrol_config_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "client_site_patrol_config_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id) on delete set null
);

alter table "public"."client_site_patrol_config"
  enable row level security;

create index idx_cspc_org_active on public.client_site_patrol_config using btree (organization_id, active);

create index idx_cspc_patrol_route_id on public.client_site_patrol_config using btree (patrol_route_id);

create index idx_cspc_site_id on public.client_site_patrol_config using btree (site_id);

create index idx_cspc_zone_id on public.client_site_patrol_config using btree (zone_id);

create policy "bob_full_read" on "public"."client_site_patrol_config"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "cspc_delete" on "public"."client_site_patrol_config"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "cspc_insert" on "public"."client_site_patrol_config"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "cspc_select" on "public"."client_site_patrol_config"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "cspc_update" on "public"."client_site_patrol_config"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

create policy "gm_full_access" on "public"."client_site_patrol_config"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."client_site_patrol_config" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."client_site_patrol_config"."zone_id" is 'The zone this stop config attends, when the stop is a ZONE rather than a SITE (unified stop model, !709). Exactly one of site_id / zone_id is set (cspc_place_xor). A zone stop carries its module(s) just like a site stop.';

comment on table "public"."client_site_patrol_config" is 'Per-site visit schedule configured in CRM. Defines days, visits/shift, time window, seasonal rules, module, dwell time, and SLA. Read by the patrol route builder to assemble shift stops.';
