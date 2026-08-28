create table "public"."preset_assignments" (
  "id"           uuid                     not null default gen_random_uuid(),
  "user_id"      uuid                     not null,
  "preset_id"    uuid                     not null,
  "scope_org_id" uuid                     not null,
  "status"       text                     not null default 'active'::text,
  "assigned_by"  uuid,
  "created_at"   timestamp with time zone not null default now(),
  "updated_at"   timestamp with time zone not null default now(),
  constraint "preset_assignments_pkey" primary key (id),
  constraint "preset_assignments_preset_id_fkey" foreign key (preset_id) references public.access_presets(id) on delete cascade,
  constraint "preset_assignments_scope_org_id_fkey" foreign key (scope_org_id) references public.organizations(id) on delete cascade,
  constraint "preset_assignments_status_check" check ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'ended'::text]))),
  constraint "preset_assignments_user_id_preset_id_scope_org_id_key" unique (user_id, preset_id, scope_org_id),
  constraint "preset_assignments_assigned_by_fkey" foreign key (assigned_by) references public.user_profiles(id) on delete set null,
  constraint "preset_assignments_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."preset_assignments"
  enable row level security;

create index idx_preset_assignments_preset on public.preset_assignments using btree (preset_id);

create index idx_preset_assignments_user on public.preset_assignments using btree (user_id);

create trigger trg_touch_preset_assignments
  before update on public.preset_assignments
  for each row
  execute function public.tg_touch_updated_at();

create policy "bob_full_read" on "public"."preset_assignments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."preset_assignments"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "preset_assignments_select" on "public"."preset_assignments"
  for select
  to PUBLIC
  using
    (((user_id = auth.uid()) or public.is_grand_master() or (scope_org_id = ANY (public.user_managed_branch_ids())) or (scope_org_id = ANY (public.get_descendant_organizations((
    select user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid())))))));

create policy "preset_assignments_write" on "public"."preset_assignments"
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

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."preset_assignments" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."preset_assignments" is 'Links a user to an access preset at an org scope. Effective grants resolve LIVE from the preset, so preset edits cascade to all holders (issue #3, C3).';
