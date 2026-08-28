create table "public"."site_financial_config" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "organization_id"       uuid                     not null,
  "site_id"               uuid                     not null,
  "service_agreement_id"  uuid,
  "billing_model"         text                     not null default 'hourly'::text,
  "hourly_rate"           numeric(10,2),
  "per_visit_rate"        numeric(10,2),
  "flat_rate_monthly"     numeric(10,2),
  "per_notice_rate"       numeric(10,2),
  "callout_rate"          numeric(10,2),
  "minimum_hours"         numeric(4,2)             default 2,
  "gst_registered"        boolean                  not null default true,
  "gst_rate"              numeric(5,4)             not null default 0.15,
  "billing_cycle"         text                     not null default 'monthly'::text,
  "payment_terms_days"    integer                  not null default 14,
  "invoice_email"         text,
  "purchase_order_number" text,
  "notes"                 text,
  "active"                boolean                  not null default true,
  "created_at"            timestamp with time zone not null default now(),
  "updated_at"            timestamp with time zone not null default now(),
  "zone_id"               uuid,
  constraint "site_financial_config_billing_cycle_check" check ((billing_cycle = ANY (ARRAY['weekly'::text, 'fortnightly'::text, 'monthly'::text, 'quarterly'::text]))),
  constraint "site_financial_config_billing_model_check"
    check ((billing_model = ANY (ARRAY['hourly'::text, 'per_visit'::text, 'flat_rate'::text, 'per_notice'::text, 'mixed'::text]))),
  constraint "site_financial_config_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "site_financial_config_pkey" primary key (id),
  constraint "site_financial_config_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete set null,
  constraint "site_financial_config_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "site_financial_config_site_id_service_agreement_id_key" unique (site_id, service_agreement_id),
  constraint "site_financial_config_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade
);

alter table "public"."site_financial_config"
  enable row level security;

create index idx_sfc_site_id on public.site_financial_config using btree (site_id);

create index idx_sfc_zone_id on public.site_financial_config using btree (zone_id)
  where (zone_id is not null);

create policy "bob_full_read" on "public"."site_financial_config"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "sfc_insert" on "public"."site_financial_config"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "sfc_select" on "public"."site_financial_config"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "sfc_update" on "public"."site_financial_config"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."site_financial_config" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."site_financial_config"."zone_id" is 'Zone this finance config applies to (site XOR zone). Extends the table from site-only to site-or-zone (epic #179).';

comment on table "public"."site_financial_config" is 'Per-site billing configuration. Defines billing model, rates, and invoice settings per site.';
