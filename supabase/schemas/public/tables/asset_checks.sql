create table "public"."asset_checks" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "asset_id"         uuid                     not null,
  "checked_by"       uuid,
  "check_type"       text                     not null,
  "condition"        text                     not null,
  "odometer_reading" integer,
  "fuel_level"       text,
  "defects_noted"    text,
  "action_required"  text,
  "checked_at"       timestamp with time zone not null default now(),
  constraint "asset_checks_check_type_check" check ((check_type = ANY (ARRAY['pre_shift'::text, 'post_shift'::text, 'weekly'::text, 'monthly'::text, 'defect_report'::text]))),
  constraint "asset_checks_condition_check" check ((condition = ANY (ARRAY['good'::text, 'minor_issue'::text, 'major_issue'::text, 'unserviceable'::text]))),
  constraint "asset_checks_fuel_level_check" check ((fuel_level = ANY (ARRAY['full'::text, 'three_quarter'::text, 'half'::text, 'quarter'::text, 'empty'::text]))),
  constraint "asset_checks_pkey" primary key (id),
  constraint "asset_checks_asset_id_fkey" foreign key (asset_id) references public.assets(id),
  constraint "asset_checks_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "asset_checks_checked_by_fkey" foreign key (checked_by) references public.user_profiles(id)
);

alter table "public"."asset_checks"
  enable row level security;

create policy "asset_checks_insert" on "public"."asset_checks"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "asset_checks_select" on "public"."asset_checks"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."asset_checks"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."asset_checks" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."asset_checks" is 'Pre/post shift vehicle checks, weekly inspections, and defect reports.';
