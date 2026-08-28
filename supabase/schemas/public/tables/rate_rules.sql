create table "public"."rate_rules" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "rule_kind"       text                     not null,
  "name"            text                     not null,
  "rate_type"       text                     not null,
  "amount"          numeric                  not null default 0,
  "pay_code"        text,
  "gl_account"      text,
  "role_code"       text,
  "region_code"     text,
  "service_type"    text,
  "module_key"      text,
  "job_code"        text,
  "job_type"        text,
  "client_org_id"   uuid,
  "site_id"         uuid,
  "vehicle_type"    text,
  "distance_min_km" numeric,
  "distance_max_km" numeric,
  "outside_area"    boolean,
  "day_category"    text,
  "effective_from"  date,
  "effective_to"    date,
  "priority"        integer                  not null default 0,
  "active"          boolean                  not null default true,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  "created_by"      uuid,
  "updated_by"      uuid,
  "zone_id"         uuid,
  constraint "rate_rules_client_org_id_fkey" foreign key (client_org_id) references public.organizations(id) on delete cascade,
  constraint "rate_rules_day_category_check"
    check (((day_category IS NULL) OR (day_category = ANY (ARRAY['weekday'::text, 'weekend'::text, 'public_holiday'::text, 'night'::text])))),
  constraint "rate_rules_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "rate_rules_pkey" primary key (id),
  constraint "rate_rules_rate_type_check"
    check
    ((rate_type = ANY (ARRAY['hourly'::text, 'flat'::text, 'daily'::text, 'per_km'::text, 'per_unit'::text, 'percentage'::text, 'per_hour_travel'::text, 'per_hour_allowance'::text,
    'oncall_flat'::text, 'callout'::text, 'higher_duties_flat'::text, 'per_visit'::text, 'per_notice'::text]))),
  constraint "rate_rules_rule_kind_check" check ((rule_kind = ANY (ARRAY['pay'::text, 'billing'::text]))),
  constraint "rate_rules_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null,
  constraint "rate_rules_updated_by_fkey" foreign key (updated_by) references public.user_profiles(id) on delete set null
);

alter table "public"."rate_rules"
  enable row level security;

create index idx_rate_rules_client on public.rate_rules using btree (client_org_id);

create index idx_rate_rules_effective on public.rate_rules using btree (effective_from, effective_to);

create index idx_rate_rules_lookup on public.rate_rules using btree (organization_id, rule_kind, active);

create index idx_rate_rules_org on public.rate_rules using btree (organization_id);

create index idx_rate_rules_site on public.rate_rules using btree (site_id);

create index idx_rate_rules_zone on public.rate_rules using btree (zone_id);

create trigger trg_rate_rules_touch
  before update on public.rate_rules
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."rate_rules"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."rate_rules"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "rate_rules_select" on "public"."rate_rules"
  for select
  to PUBLIC
  using ((public.is_grand_master() or (organization_id in ( select up.organization_id
   from public.user_profiles up
  where (up.id = auth.uid())))));

create policy "rate_rules_write" on "public"."rate_rules"
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

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."rate_rules" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."rate_rules"."zone_id" is 'location_zones.id targeting dimension (no hard FK: zone table varies by env). NULL = wildcard / applies to all zones. Symmetric with site_id.';
