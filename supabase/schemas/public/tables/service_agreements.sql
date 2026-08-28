create table "public"."service_agreements" (
  "id"                            uuid                     not null default gen_random_uuid(),
  "provider_organization_id"      uuid                     not null,
  "client_organization_id"        uuid                     not null,
  "name"                          text                     not null,
  "starts_on"                     date,
  "ends_on"                       date,
  "visibility_policy"             jsonb                    not null default '{}'::jsonb,
  "created_at"                    timestamp with time zone not null default now(),
  "client_portal_access_mode"     text                     default 'transparency_only'::text,
  "client_portal_reports_enabled" boolean                  not null default true,
  "client_portal_finance_enabled" boolean                  not null default false,
  "allows_client_submission"      boolean                  not null default false,
  "allows_auto_dispatch"          boolean                  not null default false,
  "enabled_modules"               text[]                   default '{}'::text[],
  "monthly_report_template_code"  text,
  "external_refs"                 jsonb                    not null default '{}'::jsonb,
  "default_share_contract_price"  boolean                  not null default false,
  "default_share_actual_cost"     boolean                  not null default false,
  "agreement_type"                text                     not null default 'operational'::text,
  "invitation_status"             text                     not null default 'not_invited'::text,
  constraint "chk_invitation_status_vocab" check ((invitation_status = ANY (ARRAY['not_invited'::text, 'invited'::text, 'accepted'::text, 'declined'::text, 'expired'::text]))),
  constraint "service_agreements_agreement_type_check" check ((agreement_type = ANY (ARRAY['financial'::text, 'operational'::text]))),
  constraint "service_agreements_client_organization_id_fkey" foreign key (client_organization_id) references public.organizations(id),
  constraint "service_agreements_client_portal_access_mode_check"
    check ((client_portal_access_mode = ANY (ARRAY['transparency_only'::text, 'full_modules'::text, 'scan_only'::text]))),
  constraint "service_agreements_pkey" primary key (id),
  constraint "service_agreements_provider_organization_id_fkey" foreign key (provider_organization_id) references public.organizations(id)
);

alter table "public"."service_agreements"
  enable row level security;

create index idx_service_agreements_external_refs on public.service_agreements using gin (external_refs);

create index idx_service_agreements_invitation_status on public.service_agreements using btree (invitation_status)
  where (invitation_status <> 'not_invited'::text);

create policy "bob_full_read" on "public"."service_agreements"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."service_agreements"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "master_manage_agreements_insert" on "public"."service_agreements"
  for insert
  to "authenticated"
  with check ((public.is_master_for_org(provider_organization_id) OR public.is_master_for_org(client_organization_id)));

create policy "master_manage_agreements_update" on "public"."service_agreements"
  for update
  to "authenticated"
  using ((public.is_master_for_org(provider_organization_id) or public.is_master_for_org(client_organization_id)))
  with check ((public.is_master_for_org(provider_organization_id) OR public.is_master_for_org(client_organization_id)));

create policy "service_agreements_insert" on "public"."service_agreements"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(provider_organization_id));

create policy "service_agreements_select" on "public"."service_agreements"
  for select
  to PUBLIC
  using ((public.org_access_allowed(provider_organization_id) or public.org_access_allowed(client_organization_id)));

create policy "service_agreements_update" on "public"."service_agreements"
  for update
  to PUBLIC
  using (public.is_admin_for_org(provider_organization_id))
  with check (public.is_admin_for_org(provider_organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."service_agreements" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."service_agreements"."agreement_type" is 'financial = Iron Eagle->org platform subscription (Layer 1); operational = provider->client fieldwork (Layer 2).';

comment on column "public"."service_agreements"."client_portal_access_mode" is 'transparency_only: client sees reports only. full_modules: client can submit jobs, view live map, etc. scan_only: client uses standalone scan modules only (no dispatch/roster). See issue #150.';

comment on column "public"."service_agreements"."default_share_actual_cost" is 'Default: share actual cost (open-book) with the client org. Overridable per location. False by default.';

comment on column "public"."service_agreements"."default_share_contract_price" is 'Default: share contract price with the client org for locations under this agreement. Overridable per location in service_agreement_locations.';

comment on column "public"."service_agreements"."enabled_modules" is 'Array of module keys enabled for this agreement (e.g. {patrol, static_guard, alarm_response})';

comment on column "public"."service_agreements"."external_refs" is 'Generic external system reference IDs. E.g. {"wilsar": {"bureau_id": "FSG-NCC", "bureau_name": "NELSON CITY COUNCIL SECURITY CONTRACT"}}';

comment on column "public"."service_agreements"."monthly_report_template_code" is 'Template code selecting the monthly report assembler (e.g. ncc_monthly_facilities_v1). NULL = no monthly pack.';

comment on table "public"."service_agreements" is 'Contract layer. Defines provider/client relationship, data sharing, and module scope.';
