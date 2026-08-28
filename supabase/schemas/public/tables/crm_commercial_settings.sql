create table "public"."crm_commercial_settings" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "service_agreement_id"   uuid                     not null,
  "billing_cycle"          text                     not null default 'monthly'::text,
  "payment_terms_days"     integer                  not null default 14,
  "currency"               text                     not null default 'NZD'::text,
  "base_rate_per_hour"     numeric(10,2),
  "overtime_rate_per_hour" numeric(10,2),
  "callout_minimum_hours"  numeric(4,2)             default 3,
  "callout_rate_per_hour"  numeric(10,2),
  "travel_rate_per_km"     numeric(6,4),
  "infringement_admin_fee" numeric(10,2),
  "invoice_email"          text,
  "purchase_order_number"  text,
  "notes"                  text,
  "created_at"             timestamp with time zone not null default now(),
  constraint "crm_commercial_settings_billing_cycle_check" check ((billing_cycle = ANY (ARRAY['weekly'::text, 'fortnightly'::text, 'monthly'::text, 'quarterly'::text]))),
  constraint "crm_commercial_settings_pkey" primary key (id),
  constraint "crm_commercial_settings_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete cascade
);

alter table "public"."crm_commercial_settings"
  enable row level security;

create policy "bob_full_read" on "public"."crm_commercial_settings"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "crm_commercial_settings_select" on "public"."crm_commercial_settings"
  for select
  to PUBLIC
  using ((exists ( select 1
   from public.service_agreements s
  where
    ((s.id = crm_commercial_settings.service_agreement_id) AND (public.org_access_allowed(s.provider_organization_id) or public.org_access_allowed(s.client_organization_id))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."crm_commercial_settings" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."crm_commercial_settings" is 'Billing and commercial configuration per service agreement.';
