create table "public"."staff_reporting" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "user_id"            uuid                     not null,
  "reports_to_user_id" uuid                     not null,
  "scope_org_id"       uuid                     not null,
  "relationship_type"  text                     not null default 'line_manager'::text,
  "effective_from"     date                     not null default CURRENT_DATE,
  "effective_to"       date,
  "set_by"             uuid,
  "set_at"             timestamp with time zone not null default now(),
  "notes"              text,
  "created_at"         timestamp with time zone not null default now(),
  constraint "staff_reporting_no_self" check ((user_id <> reports_to_user_id)),
  constraint "staff_reporting_pkey" primary key (id),
  constraint "staff_reporting_relationship_type_check" check ((relationship_type = ANY (ARRAY['line_manager'::text, 'functional_manager'::text]))),
  constraint "staff_reporting_scope_org_id_fkey" foreign key (scope_org_id) references public.organizations(id) on delete cascade,
  constraint "staff_reporting_reports_to_user_id_fkey" foreign key (reports_to_user_id) references public.user_profiles(id) on delete cascade,
  constraint "staff_reporting_set_by_fkey" foreign key (set_by) references public.user_profiles(id) on delete set null,
  constraint "staff_reporting_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."staff_reporting"
  enable row level security;

create unique index idx_staff_reporting_active_line_mgr on public.staff_reporting using btree (user_id, scope_org_id)
  where ((relationship_type = 'line_manager'::text) AND (effective_to is null));

create index idx_staff_reporting_reports_to_live on public.staff_reporting using btree (reports_to_user_id)
  where (effective_to is null);

create index idx_staff_reporting_reports_to on public.staff_reporting using btree (reports_to_user_id);

create index idx_staff_reporting_scope on public.staff_reporting using btree (scope_org_id);

create index idx_staff_reporting_user on public.staff_reporting using btree (user_id);

create policy "bob_full_read" on "public"."staff_reporting"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "staff_reporting_select" on "public"."staff_reporting"
  for select
  to PUBLIC
  using
    (((user_id = auth.uid()) or (reports_to_user_id = auth.uid()) or (scope_org_id = ANY (public.user_managed_branch_ids())) or (scope_org_id = ANY
    (public.get_descendant_organizations(( select user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid()))))) or (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = 'grand_master'::text)));

create policy "staff_reporting_write" on "public"."staff_reporting"
  for all
  to PUBLIC
  using (((scope_org_id = ANY (public.user_managed_branch_ids())) or (scope_org_id = ANY (public.get_descendant_organizations(( select user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid()))))) or (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text]))))
  with check (((scope_org_id = ANY (public.user_managed_branch_ids())) OR (scope_org_id = ANY (public.get_descendant_organizations(( SELECT user_profiles.employer_organization_id
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid()))))) OR (( SELECT user_profiles.role
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text]))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_reporting" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."staff_reporting" is 'Person-level supervisor/manager link, scoped per org/branch. One active line_manager per (user, scope_org). functional_manager is schema-only in v1 (UI deferred). #224.';
