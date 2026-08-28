create table "public"."retention_policies" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid,
  "module_key"      text,
  "category"        text                     not null,
  "retention_days"  integer                  not null,
  "legal_basis"     text,
  "is_active"       boolean                  not null default true,
  "effective_from"  date                     not null default CURRENT_DATE,
  "created_by"      uuid,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "retention_policies_category_check" check ((category = ANY (ARRAY['infringement'::text, 'non_infringement'::text, 'hold_default'::text]))),
  constraint "retention_policies_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "retention_policies_pkey" primary key (id),
  constraint "retention_policies_retention_days_check" check ((retention_days >= 0)),
  constraint "retention_policies_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null
);

alter table "public"."retention_policies"
  enable row level security;

create index idx_retention_policies_org on public.retention_policies using btree (organization_id)
  where (organization_id is not null);

create unique index uniq_retention_policy_full on public.retention_policies using btree (organization_id, module_key, category)
  where ((organization_id is not null) AND (module_key is not null) AND is_active);

create unique index uniq_retention_policy_org_cat on public.retention_policies using btree (organization_id, category)
  where ((organization_id is not null) AND (module_key is null) AND is_active);

create unique index uniq_retention_policy_platform on public.retention_policies using btree (category)
  where ((organization_id is null) AND (module_key is null) AND is_active);

create policy "bob_full_read" on "public"."retention_policies"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "retention_policies_select" on "public"."retention_policies"
  for select
  to PUBLIC
  using (((organization_id is null) or public.org_access_allowed(organization_id)));

create policy "retention_policies_write" on "public"."retention_policies"
  for all
  to PUBLIC
  using (((organization_id is not null) AND public.is_admin_for_org(organization_id)))
  with check (((organization_id IS NOT NULL) AND public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."retention_policies" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."retention_policies" is 'Per-council (and optional per-module) evidence retention periods. Councils differ by bylaw; periods are configurable, not hardcoded. organization_id null = platform default fallback.';
