create table "public"."staff_skills" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "staff_id"             uuid                     not null,
  "organization_id"      uuid                     not null,
  "skill_name"           text                     not null,
  "skill_category"       text,
  "proficiency_level"    text,
  "certified"            boolean                  not null default false,
  "certification_expiry" date,
  "notes"                text,
  "created_at"           timestamp with time zone not null default now(),
  constraint "staff_skills_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "staff_skills_pkey" primary key (id),
  constraint "staff_skills_proficiency_level_check" check ((proficiency_level = ANY (ARRAY['basic'::text, 'competent'::text, 'proficient'::text, 'expert'::text]))),
  constraint "staff_skills_skill_category_check"
    check ((skill_category = ANY (ARRAY['enforcement'::text, 'technical'::text, 'medical'::text, 'language'::text, 'driving'::text, 'equipment'::text, 'other'::text]))),
  constraint "staff_skills_staff_id_fkey" foreign key (staff_id) references public.staff_profiles(id) on delete cascade
);

alter table "public"."staff_skills"
  enable row level security;

create policy "bob_full_read" on "public"."staff_skills"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "staff_skills_insert" on "public"."staff_skills"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "staff_skills_select" on "public"."staff_skills"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "staff_skills_update" on "public"."staff_skills"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_skills" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."staff_skills" is 'Skills and qualifications per staff member. Used for roster matching and site coverage planning.';
