create table "public"."org_module_subscriptions" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "module_key"      text                     not null,
  "base_price"      numeric(12,2),
  "per_seat_price"  numeric(12,2),
  "per_site_price"  numeric(12,2),
  "discount_pct"    numeric(5,2)             not null default 0,
  "billing_period"  text,
  "currency"        text,
  "status"          text                     not null default 'active'::text,
  "started_at"      date                     not null default CURRENT_DATE,
  "ended_at"        date,
  "effective_from"  date,
  "effective_to"    date,
  "notes"           text,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  "created_by"      uuid,
  "updated_by"      uuid,
  constraint "org_module_subscriptions_billing_period_check"
    check (((billing_period IS NULL) OR (billing_period = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text])))),
  constraint "org_module_subscriptions_discount_pct_check" check (((discount_pct >= (0)::numeric) AND (discount_pct <= (100)::numeric))),
  constraint "org_module_subscriptions_organization_id_module_key_key" unique (organization_id, module_key),
  constraint "org_module_subscriptions_pkey" primary key (id),
  constraint "org_module_subscriptions_status_check" check ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'cancelled'::text]))),
  constraint "org_module_subscriptions_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "org_module_subscriptions_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null,
  constraint "org_module_subscriptions_updated_by_fkey" foreign key (updated_by) references public.user_profiles(id) on delete set null
);

alter table "public"."org_module_subscriptions"
  enable row level security;

create index idx_org_module_subs_lookup on public.org_module_subscriptions using btree (organization_id, module_key, status);

create index idx_org_module_subs_org on public.org_module_subscriptions using btree (organization_id);

create trigger trg_org_module_subs_touch
  before update on public.org_module_subscriptions
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."org_module_subscriptions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "org_module_subs_select" on "public"."org_module_subscriptions"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))));

create policy "org_module_subs_write" on "public"."org_module_subscriptions"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."org_module_subscriptions" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."org_module_subscriptions" is 'Layer 1 (owner->provider) subscription lines: what each provider org is actually charged per module (per-provider price overrides + discount applied after the resolved price, else inherits module_catalog). effective_from/to version price changes. Aligned to organization_modules enablement. Grand_master write; provider reads its own.';
