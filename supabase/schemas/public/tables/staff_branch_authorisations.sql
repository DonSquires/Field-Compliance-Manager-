create table "public"."staff_branch_authorisations" (
  "id"              uuid                     not null default gen_random_uuid(),
  "user_id"         uuid                     not null,
  "branch_org_id"   uuid                     not null,
  "role_at_branch"  text                     not null default 'officer'::text,
  "module_access"   text[]                   not null default '{}'::text[],
  "can_be_rostered" boolean                  not null default true,
  "status"          text                     not null default 'active'::text,
  "authorised_by"   uuid,
  "starts_on"       date,
  "ends_on"         date,
  "created_at"      timestamp with time zone not null default now(),
  constraint "staff_branch_authorisations_branch_org_id_fkey" foreign key (branch_org_id) references public.organizations(id) on delete cascade,
  constraint "staff_branch_authorisations_pkey" primary key (id),
  constraint "staff_branch_authorisations_status_check" check ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'ended'::text]))),
  constraint "staff_branch_authorisations_user_id_branch_org_id_key" unique (user_id, branch_org_id),
  constraint "staff_branch_authorisations_authorised_by_fkey" foreign key (authorised_by) references public.user_profiles(id) on delete set null,
  constraint "staff_branch_authorisations_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."staff_branch_authorisations"
  enable row level security;

create index idx_sba_branch on public.staff_branch_authorisations using btree (branch_org_id);

create index idx_sba_user on public.staff_branch_authorisations using btree (user_id);

create trigger trg_sync_authorised_org_ids
  after insert or delete or update on public.staff_branch_authorisations
  for each row
  execute function public.sync_authorised_org_ids();

create policy "bob_full_read" on "public"."staff_branch_authorisations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."staff_branch_authorisations"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "sba_select" on "public"."staff_branch_authorisations"
  for select
  to PUBLIC
  using
    (((user_id = auth.uid()) or (branch_org_id = ANY (public.user_managed_branch_ids())) or (branch_org_id = ANY (public.get_descendant_organizations(( select
    user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid())))))));

create policy "sba_write" on "public"."staff_branch_authorisations"
  for all
  to PUBLIC
  using (((branch_org_id = ANY (public.user_managed_branch_ids())) or (branch_org_id = ANY (public.get_descendant_organizations(( select user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid()))))) or (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text]))))
  with check (((branch_org_id = ANY (public.user_managed_branch_ids())) OR (branch_org_id = ANY (public.get_descendant_organizations(( SELECT user_profiles.employer_organization_id
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid()))))) OR (( SELECT user_profiles.role
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text]))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_branch_authorisations" to "anon", "authenticated", "postgres", "service_role";
