create table "public"."staff_area_grants" (
  "id"            uuid                     not null default gen_random_uuid(),
  "user_id"       uuid                     not null,
  "scope_org_id"  uuid                     not null,
  "area"          text                     not null,
  "level"         text                     not null default 'view'::text,
  "status"        text                     not null default 'active'::text,
  "source_preset" text,
  "granted_by"    uuid,
  "created_at"    timestamp with time zone not null default now(),
  "updated_at"    timestamp with time zone not null default now(),
  constraint "staff_area_grants_level_check" check ((level = ANY (ARRAY['view'::text, 'verify'::text, 'approve'::text, 'adjust'::text, 'manage'::text]))),
  constraint "staff_area_grants_pkey" primary key (id),
  constraint "staff_area_grants_scope_org_id_fkey" foreign key (scope_org_id) references public.organizations(id) on delete cascade,
  constraint "staff_area_grants_status_check" check ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'ended'::text]))),
  constraint "staff_area_grants_user_id_scope_org_id_area_key" unique (user_id, scope_org_id, area),
  constraint "staff_area_grants_granted_by_fkey" foreign key (granted_by) references public.user_profiles(id) on delete set null,
  constraint "staff_area_grants_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."staff_area_grants"
  enable row level security;

create index idx_area_grants_scope on public.staff_area_grants using btree (scope_org_id);

create index idx_area_grants_user on public.staff_area_grants using btree (user_id);

create trigger trg_touch_area_grants
  before update on public.staff_area_grants
  for each row
  execute function public.tg_touch_updated_at();

create policy "area_grants_select" on "public"."staff_area_grants"
  for select
  to PUBLIC
  using
    (((user_id = auth.uid()) or public.is_grand_master() or (scope_org_id = ANY (public.user_managed_branch_ids())) or (scope_org_id = ANY (public.get_descendant_organizations((
    select user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid())))))));

create policy "area_grants_write" on "public"."staff_area_grants"
  for all
  to PUBLIC
  using
    ((public.is_master_or_above() or (scope_org_id = ANY (public.user_managed_branch_ids())) or (scope_org_id = ANY (public.get_descendant_organizations(( select
    user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid())))))))
  with
    check
    ((public.is_master_or_above() OR (scope_org_id = ANY (public.user_managed_branch_ids())) OR (scope_org_id = ANY (public.get_descendant_organizations(( SELECT
    user_profiles.employer_organization_id
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())))))));

create policy "bob_full_read" on "public"."staff_area_grants"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."staff_area_grants"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_area_grants" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."staff_area_grants"."scope_org_id" is 'The org this grant applies at. Resolved to the descendant subtree at read time (provider-scoped grant = whole subtree; branch-scoped = that branch).';

comment on table "public"."staff_area_grants" is 'Per-user functional-area x level access grants, scoped to a branch or provider org. The configurable access matrix (issue #3, C1). Read by the conductor egress gate and app write guards (C2).';
