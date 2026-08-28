create table "public"."org_rate_settings" (
  "organization_id"                uuid                     not null,
  "gst_rate"                       numeric                  not null default 0.15,
  "invoice_prefix"                 text                     not null default 'INV'::text,
  "payment_terms_days"             integer                  not null default 20,
  "currency"                       text                     not null default 'NZD'::text,
  "pay_policy"                     text                     not null default 'max_of_both'::text,
  "overtime_multiplier"            numeric                  not null default 1.5,
  "double_multiplier"              numeric                  not null default 2.0,
  "target_margin_pct"              numeric                  not null default 0,
  "rounding"                       text                     not null default 'cent'::text,
  "created_at"                     timestamp with time zone not null default now(),
  "updated_at"                     timestamp with time zone not null default now(),
  "default_platform_fee_treatment" text                     not null default 'passthrough'::text,
  constraint "org_rate_settings_default_fee_treatment_chk"
    check ((default_platform_fee_treatment = ANY (ARRAY['passthrough'::text, 'passthrough_marked_up'::text, 'absorb'::text]))),
  constraint "org_rate_settings_pay_policy_check" check ((pay_policy = ANY (ARRAY['fixed_rate'::text, 'site_rate'::text, 'max_of_both'::text]))),
  constraint "org_rate_settings_pkey" primary key (organization_id),
  constraint "org_rate_settings_rounding_check" check ((rounding = ANY (ARRAY['none'::text, 'cent'::text, 'dollar'::text]))),
  constraint "org_rate_settings_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."org_rate_settings"
  enable row level security;

create trigger trg_org_rate_settings_touch
  before update on public.org_rate_settings
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."org_rate_settings"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."org_rate_settings"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "ors_select" on "public"."org_rate_settings"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))));

create policy "ors_write" on "public"."org_rate_settings"
  for all
  to PUBLIC
  using ((public.is_grand_master() or ((organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid()))) AND (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))))
  with check ((public.is_grand_master() OR ((organization_id IN ( SELECT up.organization_id
   FROM public.user_profiles up
  WHERE (up.id = auth.uid()))) AND (( SELECT user_profiles.role
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text, 'admin'::text, 'admin_officer'::text])))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."org_rate_settings" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."org_rate_settings"."default_platform_fee_treatment" is 'B6 (#2): default platform_fee_treatment applied to NEW Layer 2 quotes for this provider. passthrough (default) | passthrough_marked_up | absorb. Per-quote value still overridable on the quote.';
