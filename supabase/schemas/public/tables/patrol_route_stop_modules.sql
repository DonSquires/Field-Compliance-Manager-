create table "public"."patrol_route_stop_modules" (
  "id"                            uuid                     not null default gen_random_uuid(),
  "organization_id"               uuid                     not null,
  "patrol_config_id"              uuid                     not null,
  "module_key"                    text                     not null,
  "module_config"                 jsonb                    not null default '{}'::jsonb,
  "is_required"                   boolean                  not null default true,
  "display_order"                 integer                  not null default 0,
  "active"                        boolean                  not null default true,
  "created_at"                    timestamp with time zone not null default now(),
  "updated_at"                    timestamp with time zone not null default now(),
  "service_agreement_module_id"   uuid,
  "service_agreement_location_id" uuid,
  constraint "patrol_route_stop_modules_module_key_check"
    check
    ((module_key = ANY (ARRAY['freedom_camping'::text, 'parking_enforcement'::text, 'noise_control'::text, 'biosecurity'::text, 'smoke_complaints'::text, 'static_guarding'::text,
    'access_control'::text, 'ems'::text, 'alarm_response'::text, 'welfare_check'::text, 'general_patrol'::text]))),
  constraint "patrol_route_stop_modules_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "patrol_route_stop_modules_patrol_config_id_fkey" foreign key (patrol_config_id) references public.client_site_patrol_config(id) on delete cascade,
  constraint "patrol_route_stop_modules_patrol_config_id_module_key_key" unique (patrol_config_id, module_key),
  constraint "patrol_route_stop_modules_pkey" primary key (id),
  constraint "patrol_route_stop_modules_service_agreement_location_id_fkey" foreign key (service_agreement_location_id) references public.service_agreement_locations(id) on delete
    set null,
  constraint "patrol_route_stop_modules_service_agreement_module_id_fkey" foreign key (service_agreement_module_id) references public.service_agreement_modules(id) on delete
    set null
);

alter table "public"."patrol_route_stop_modules"
  enable row level security;

create index idx_prsm_config on public.patrol_route_stop_modules using btree (patrol_config_id);

create index idx_prsm_org_active on public.patrol_route_stop_modules using btree (organization_id, active);

create index idx_prsm_sal on public.patrol_route_stop_modules using btree (service_agreement_location_id)
  where (service_agreement_location_id is not null);

create index idx_prsm_sam on public.patrol_route_stop_modules using btree (service_agreement_module_id)
  where (service_agreement_module_id is not null);

create policy "bob_full_read" on "public"."patrol_route_stop_modules"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "prsm_delete" on "public"."patrol_route_stop_modules"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "prsm_insert" on "public"."patrol_route_stop_modules"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "prsm_select" on "public"."patrol_route_stop_modules"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "prsm_update" on "public"."patrol_route_stop_modules"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_route_stop_modules" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."patrol_route_stop_modules"."service_agreement_location_id" is 'The authorising service_agreement_location (place-contract) for this plan-time module. Names the place-level contract that authorises this stop. Nullable for back-compat. Set at plan-time config alongside service_agreement_module_id.';

comment on column "public"."patrol_route_stop_modules"."service_agreement_module_id" is 'The authorising service_agreement_module for this plan-time module task. Set at plan-time config; inherited into shift_stop_modules at generation. Nullable for back-compat (existing rows pre-date this column). Exactly ONE authorising contract per stop-module attendance (single FK, not a junction). Owner ruling 2026-08-15: contract attribution at MODULE grain.';

comment on table "public"."patrol_route_stop_modules" is 'Plan-time module assignment for a patrol stop config (unified stop model, !709). One or MORE modules per stop; the route stays module-agnostic. Legacy client_site_patrol_config.module_key is kept for dual-write until Phase 4 deprecation.';
