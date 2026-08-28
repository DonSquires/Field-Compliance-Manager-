create table "public"."module_catalog" (
  "module_key"     text                     not null,
  "base_price"     numeric(12,2)            not null default 0,
  "per_seat_price" numeric(12,2)            not null default 0,
  "per_site_price" numeric(12,2)            not null default 0,
  "billing_period" text                     not null default 'monthly'::text,
  "currency"       text                     not null default 'NZD'::text,
  "active"         boolean                  not null default true,
  "created_at"     timestamp with time zone not null default now(),
  "updated_at"     timestamp with time zone not null default now(),
  constraint "module_catalog_billing_period_check" check ((billing_period = ANY (ARRAY['monthly'::text, 'quarterly'::text, 'annual'::text]))),
  constraint "module_catalog_pkey" primary key (module_key)
);

alter table "public"."module_catalog"
  enable row level security;

create trigger trg_module_catalog_touch
  before update on public.module_catalog
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."module_catalog"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "module_catalog_select" on "public"."module_catalog"
  for select
  to "authenticated"
  using (true);

create policy "module_catalog_write" on "public"."module_catalog"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."module_catalog" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."module_catalog" is 'Layer 1 (owner->provider) platform price list: owner-set base + per-seat + per-site price per module_key. No organization_id (applies to all providers; overridden per subscription in org_module_subscriptions). Which modules are sellable is defined by moduleManifest.ts (sellable:true), not here; this table carries only the price. Grand_master write; all authenticated read.';
