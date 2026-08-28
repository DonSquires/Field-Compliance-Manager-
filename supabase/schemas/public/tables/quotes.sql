create table "public"."quotes" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "provider_org_id"        uuid                     not null,
  "client_org_id"          uuid,
  "client_name"            text,
  "title"                  text                     not null default 'Service quote'::text,
  "status"                 text                     not null default 'draft'::text,
  "currency"               text                     not null default 'NZD'::text,
  "target_margin_pct"      numeric(5,2)             not null default 0,
  "discount_pct"           numeric(5,2)             not null default 0,
  "gst_rate"               numeric(5,4)             not null default 0.15,
  "platform_fee_treatment" text                     not null default 'passthrough'::text,
  "total_cost"             numeric(12,2)            not null default 0,
  "subtotal_charge"        numeric(12,2)            not null default 0,
  "discount_amount"        numeric(12,2)            not null default 0,
  "gst_amount"             numeric(12,2)            not null default 0,
  "total_charge"           numeric(12,2)            not null default 0,
  "valid_until"            date,
  "notes"                  text,
  "accepted_at"            timestamp with time zone,
  "accepted_by"            uuid,
  "service_agreement_id"   uuid,
  "created_at"             timestamp with time zone not null default now(),
  "updated_at"             timestamp with time zone not null default now(),
  "created_by"             uuid,
  "updated_by"             uuid,
  constraint "quotes_client_org_id_fkey" foreign key (client_org_id) references public.organizations(id) on delete set null,
  constraint "quotes_discount_pct_check" check (((discount_pct >= (0)::numeric) AND (discount_pct <= (100)::numeric))),
  constraint "quotes_pkey" primary key (id),
  constraint "quotes_platform_fee_treatment_check" check ((platform_fee_treatment = ANY (ARRAY['passthrough'::text, 'passthrough_marked_up'::text, 'absorb'::text]))),
  constraint "quotes_provider_org_id_fkey" foreign key (provider_org_id) references public.organizations(id) on delete cascade,
  constraint "quotes_status_check" check ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'declined'::text, 'expired'::text]))),
  constraint "quotes_target_margin_pct_check" check (((target_margin_pct >= (0)::numeric) AND (target_margin_pct < (100)::numeric))),
  constraint "quotes_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete set null,
  constraint "quotes_accepted_by_fkey" foreign key (accepted_by) references public.user_profiles(id) on delete set null,
  constraint "quotes_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null,
  constraint "quotes_updated_by_fkey" foreign key (updated_by) references public.user_profiles(id) on delete set null
);

alter table "public"."quotes"
  enable row level security;

create index idx_quotes_client on public.quotes using btree (client_org_id);

create index idx_quotes_provider on public.quotes using btree (provider_org_id);

create index idx_quotes_status on public.quotes using btree (provider_org_id, status);

create trigger trg_quotes_touch
  before update on public.quotes
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."quotes"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."quotes"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "quotes_select" on "public"."quotes"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (provider_org_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))));

create policy "quotes_write" on "public"."quotes"
  for all
  to PUBLIC
  using ((public.is_grand_master() or ((provider_org_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))) AND (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))))
  with check ((public.is_grand_master() OR ((provider_org_id IN ( SELECT up.organization_id
   FROM public.user_profiles up
  WHERE (up.id = auth.uid()))) AND (( SELECT user_profiles.role
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."quotes" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."quotes" is 'Layer 2 (provider->client) quote/proposal. Cost-vs-charge with target margin + client discount; platform_fee_treatment controls how the Layer-1 platform module fee surfaces (default passthrough = own client line at cost). On accept (B5) it writes crm_commercial_settings + site_financial_config and links a service_agreement. Provider-scoped RLS + grand_master.';
