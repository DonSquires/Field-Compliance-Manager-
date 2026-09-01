create table "public"."jurisdiction_rule_sets" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "module_key"        text                     not null,
  "name"              text                     not null,
  "jurisdiction_name" text                     not null,
  "rules"             jsonb                    not null default '{}'::jsonb,
  "created_at"        timestamp with time zone not null default now(),
  constraint "jurisdiction_rule_sets_pkey" primary key (id),
  constraint "jurisdiction_rule_sets_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."jurisdiction_rule_sets"
  enable row level security;

create policy "bob_full_read" on "public"."jurisdiction_rule_sets"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "jurisdiction_rule_sets_select" on "public"."jurisdiction_rule_sets"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "jurisdiction_rule_sets_insert" on "public"."jurisdiction_rule_sets"
  for insert
  with check (public.is_admin_for_org(organization_id));

create policy "jurisdiction_rule_sets_update" on "public"."jurisdiction_rule_sets"
  for update
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

create policy "jurisdiction_rule_sets_delete" on "public"."jurisdiction_rule_sets"
  for delete
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."jurisdiction_rule_sets" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."jurisdiction_rule_sets" is 'Jurisdiction-specific legal/operational rules per module. Supports councils, government, and private enterprise.';
