create table "public"."service_agreement_locations" (
  "id"                           uuid                     not null default gen_random_uuid(),
  "service_agreement_id"         uuid                     not null,
  "site_id"                      uuid,
  "zone_id"                      uuid,
  "share_contract_price"         boolean,
  "share_actual_cost"            boolean,
  "standalone_scan_enabled"      boolean                  not null default false,
  "status"                       text                     not null default 'active'::text,
  "created_by"                   uuid,
  "created_at"                   timestamp with time zone not null default now(),
  "updated_at"                   timestamp with time zone not null default now(),
  "head_contractor_org_id"       uuid,
  "subcontract_attribution_mode" text                     not null default 'whitelabel'::text,
  constraint "sal_site_xor_zone" check ((((site_id IS NOT NULL) AND (zone_id IS NULL)) OR ((site_id IS NULL) AND (zone_id IS NOT NULL)))),
  constraint "service_agreement_locations_head_contractor_org_id_fkey" foreign key (head_contractor_org_id) references public.organizations(id),
  constraint "service_agreement_locations_pkey" primary key (id),
  constraint "service_agreement_locations_service_agreement_id_site_id_key" unique (service_agreement_id, site_id),
  constraint "service_agreement_locations_service_agreement_id_zone_id_key" unique (service_agreement_id, zone_id),
  constraint "service_agreement_locations_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "service_agreement_locations_status_check" check ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'ended'::text]))),
  constraint "service_agreement_locations_subcontract_attribution_mode_check"
    check ((subcontract_attribution_mode = ANY (ARRAY['whitelabel'::text, 'partner_network'::text, 'disclosed'::text]))),
  constraint "service_agreement_locations_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade,
  constraint "service_agreement_locations_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete cascade,
  constraint "service_agreement_locations_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."service_agreement_locations"
  enable row level security;

create index idx_sal_agreement on public.service_agreement_locations using btree (service_agreement_id);

create index idx_sal_head_contractor on public.service_agreement_locations using btree (head_contractor_org_id)
  where (head_contractor_org_id is not null);

create index idx_sal_site on public.service_agreement_locations using btree (site_id)
  where (site_id is not null);

create index idx_sal_status on public.service_agreement_locations using btree (status);

create index idx_sal_zone on public.service_agreement_locations using btree (zone_id)
  where (zone_id is not null);

create trigger trg_touch_sal
  before update on public.service_agreement_locations
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."service_agreement_locations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."service_agreement_locations"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "sal_select" on "public"."service_agreement_locations"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (exists ( select 1
   from public.service_agreements sa
  where
    ((sa.id = service_agreement_locations.service_agreement_id) AND (public.org_access_allowed(sa.provider_organization_id) or
    public.org_access_allowed(sa.client_organization_id)))))));

create policy "sal_write" on "public"."service_agreement_locations"
  for all
  to PUBLIC
  using ((public.is_grand_master() or (exists ( select 1
   from public.service_agreements sa
  where ((sa.id = service_agreement_locations.service_agreement_id) AND public.org_access_allowed(sa.provider_organization_id) AND (( select user_profiles.role
           from public.user_profiles
          where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))))))
  with check ((public.is_grand_master() OR (EXISTS ( SELECT 1
   FROM public.service_agreements sa
  WHERE ((sa.id = service_agreement_locations.service_agreement_id) AND public.org_access_allowed(sa.provider_organization_id) AND (( SELECT user_profiles.role
           FROM public.user_profiles
          WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."service_agreement_locations" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."service_agreement_locations" is 'Location-level contract layer (epic #179). Anchors a service agreement to a specific site or zone. One location can have multiple agreements (different providers for different modules). Visibility settings (share_contract_price, share_actual_cost) override the agreement-level defaults. Self-managed locations use site_services directly and do not need a row here.';
