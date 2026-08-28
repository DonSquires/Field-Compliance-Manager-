create table "public"."roster_templates" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "name"            text                     not null,
  "description"     text,
  "template_type"   text                     not null default 'weekly'::text,
  "effective_from"  date,
  "effective_to"    date,
  "is_active"       boolean                  not null default true,
  "created_at"      timestamp with time zone not null default now(),
  constraint "roster_templates_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "roster_templates_pkey" primary key (id),
  constraint "roster_templates_template_type_check" check ((template_type = ANY (ARRAY['weekly'::text, 'fortnightly'::text, 'monthly'::text])))
);

alter table "public"."roster_templates"
  enable row level security;

create policy "bob_full_read" on "public"."roster_templates"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "roster_templates_insert" on "public"."roster_templates"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "roster_templates_select" on "public"."roster_templates"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."roster_templates" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."roster_templates" is 'Weekly/fortnightly/monthly roster patterns. Officers are assigned to patrol routes on a recurring schedule.';
