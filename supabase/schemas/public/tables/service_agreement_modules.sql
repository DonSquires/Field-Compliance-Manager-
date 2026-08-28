create table "public"."service_agreement_modules" (
  "id"                       uuid    not null default gen_random_uuid(),
  "service_agreement_id"     uuid    not null,
  "module_key"               text    not null,
  "enabled"                  boolean not null default true,
  "sla_minutes"              integer,
  "allows_client_submission" boolean not null default false,
  "allows_auto_dispatch"     boolean not null default false,
  "settings"                 jsonb   not null default '{}'::jsonb,
  "standalone_scan_enabled"  boolean not null default false,
  "client_access_mode"       text    not null default 'operational'::text,
  "billing_direction"        text    not null default 'on_charge'::text,
  constraint "service_agreement_modules_billing_direction_check" check ((billing_direction = ANY (ARRAY['subscriber'::text, 'on_charge'::text]))),
  constraint "service_agreement_modules_client_access_mode_check" check ((client_access_mode = ANY (ARRAY['operational'::text, 'reports_only'::text]))),
  constraint "service_agreement_modules_pkey" primary key (id),
  constraint "service_agreement_modules_service_agreement_id_module_key_key" unique (service_agreement_id, module_key),
  constraint "service_agreement_modules_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete cascade
);

alter table "public"."service_agreement_modules"
  enable row level security;

create index idx_sam_standalone_scan on public.service_agreement_modules using btree (service_agreement_id)
  where (standalone_scan_enabled = true);

create policy "bob_full_read" on "public"."service_agreement_modules"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "service_agreement_modules_insert" on "public"."service_agreement_modules"
  for insert
  to PUBLIC
  with check ((EXISTS ( SELECT 1
   FROM public.service_agreements s
  WHERE ((s.id = service_agreement_modules.service_agreement_id) AND public.is_admin_for_org(s.provider_organization_id)))));

create policy "service_agreement_modules_select" on "public"."service_agreement_modules"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.service_agreements s
  where
    ((s.id = service_agreement_modules.service_agreement_id) AND (public.org_access_allowed(s.provider_organization_id) or public.org_access_allowed(s.client_organization_id))))));

create policy "service_agreement_modules_update" on "public"."service_agreement_modules"
  for update
  to PUBLIC
  using ((exists ( select 1
   from public.service_agreements s
  where ((s.id = service_agreement_modules.service_agreement_id) AND public.is_admin_for_org(s.provider_organization_id)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."service_agreement_modules" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."service_agreement_modules"."standalone_scan_enabled" is 'When true, this module can be used in standalone "login and scan" mode under this agreement — no dispatch_roster dependency. See issue #150.';

comment on table "public"."service_agreement_modules" is 'Per-module contract settings: SLA, client submission, auto-dispatch, and module rules.';
