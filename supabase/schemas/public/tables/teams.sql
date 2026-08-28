create table "public"."teams" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "name"              text                     not null,
  "description"       text,
  "team_lead_user_id" uuid,
  "scope_org_id"      uuid,
  "status"            text                     not null default 'active'::text,
  "created_by"        uuid,
  "created_at"        timestamp with time zone not null default now(),
  "updated_at"        timestamp with time zone not null default now(),
  constraint "teams_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "teams_pkey" primary key (id),
  constraint "teams_scope_org_id_fkey" foreign key (scope_org_id) references public.organizations(id) on delete set null,
  constraint "teams_status_check" check ((status = ANY (ARRAY['active'::text, 'archived'::text]))),
  constraint "teams_created_by_fkey" foreign key (created_by) references public.user_profiles(id) on delete set null,
  constraint "teams_team_lead_user_id_fkey" foreign key (team_lead_user_id) references public.user_profiles(id) on delete set null
);

alter table "public"."teams"
  enable row level security;

create index idx_teams_lead on public.teams using btree (team_lead_user_id)
  where (team_lead_user_id is not null);

create index idx_teams_org on public.teams using btree (organization_id);

create index idx_teams_scope on public.teams using btree (scope_org_id)
  where (scope_org_id is not null);

create policy "bob_full_read" on "public"."teams"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "teams_select" on "public"."teams"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "teams_write" on "public"."teams"
  for all
  to PUBLIC
  using
    (((team_lead_user_id = auth.uid()) or (COALESCE(scope_org_id, organization_id) = ANY (public.user_managed_branch_ids())) or (organization_id = ANY
    (public.get_descendant_organizations(( select user_profiles.employer_organization_id
   from public.user_profiles
  where (user_profiles.id = auth.uid()))))) or (( select user_profiles.role
   from public.user_profiles
  where (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text]))))
  with
    check
    (((team_lead_user_id = auth.uid()) OR (COALESCE(scope_org_id, organization_id) = ANY (public.user_managed_branch_ids())) OR (organization_id = ANY
    (public.get_descendant_organizations(( SELECT user_profiles.employer_organization_id
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid()))))) OR (( SELECT user_profiles.role
   FROM public.user_profiles
  WHERE (user_profiles.id = auth.uid())) = ANY (ARRAY['grand_master'::text, 'master'::text]))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."teams" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."teams" is 'Named user groups with a team lead. scope_org_id NULL = org-wide team (Q6). Team lead is NOT auto the line manager (Q1). #224.';
