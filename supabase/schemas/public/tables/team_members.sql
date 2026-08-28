create table "public"."team_members" (
  "id"           uuid                     not null default gen_random_uuid(),
  "team_id"      uuid                     not null,
  "user_id"      uuid                     not null,
  "role_in_team" text                     not null default 'member'::text,
  "joined_at"    timestamp with time zone not null default now(),
  "left_at"      timestamp with time zone,
  "added_by"     uuid,
  constraint "team_members_pkey" primary key (id),
  constraint "team_members_role_in_team_check" check ((role_in_team = ANY (ARRAY['member'::text, 'deputy_lead'::text]))),
  constraint "team_members_team_id_user_id_key" unique (team_id, user_id),
  constraint "team_members_team_id_fkey" foreign key (team_id) references public.teams(id) on delete cascade,
  constraint "team_members_added_by_fkey" foreign key (added_by) references public.user_profiles(id) on delete set null,
  constraint "team_members_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete cascade
);

alter table "public"."team_members"
  enable row level security;

create index idx_team_members_team on public.team_members using btree (team_id);

create index idx_team_members_user on public.team_members using btree (user_id);

create policy "bob_full_read" on "public"."team_members"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "team_members_select" on "public"."team_members"
  for select
  to PUBLIC
  using (((user_id = auth.uid()) or (team_id in ( select teams.id
   from public.teams
  where (teams.team_lead_user_id = auth.uid()))) or (team_id in ( select teams.id
   from public.teams
  where public.org_access_allowed(teams.organization_id)))));

create policy "team_members_write" on "public"."team_members"
  for all
  to PUBLIC
  using (((team_id in ( select teams.id
   from public.teams
  where (teams.team_lead_user_id = auth.uid()))) or (team_id in ( select teams.id
   from public.teams
  where
    ((COALESCE(teams.scope_org_id, teams.organization_id) = ANY (public.user_managed_branch_ids())) or (teams.organization_id = ANY (public.get_descendant_organizations(( select
    user_profiles.employer_organization_id
           from public.user_profiles
          where (user_profiles.id = auth.uid()))))) or (( select user_profiles.role
           from public.user_profiles
          where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text])))))))
  with check (((team_id IN ( SELECT teams.id
   FROM public.teams
  WHERE (teams.team_lead_user_id = auth.uid()))) OR (team_id IN ( SELECT teams.id
   FROM public.teams
  WHERE
    ((COALESCE(teams.scope_org_id, teams.organization_id) = ANY (public.user_managed_branch_ids())) OR (teams.organization_id = ANY (public.get_descendant_organizations(( SELECT
    user_profiles.employer_organization_id
           FROM public.user_profiles
          WHERE (user_profiles.id = auth.uid()))))) OR (( SELECT user_profiles.role
           FROM public.user_profiles
          WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text])))))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."team_members" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."team_members" is 'Membership in teams. UNIQUE(team_id, user_id). left_at NULL = active member. #224.';
