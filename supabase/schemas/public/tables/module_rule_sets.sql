create table "public"."module_rule_sets" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "organization_id"       uuid                     not null,
  "module_key"            text                     not null,
  "name"                  text                     not null,
  "evidence_requirements" jsonb                    not null default '[]'::jsonb,
  "approval_policy"       jsonb                    not null default '{}'::jsonb,
  "report_template_code"  text,
  "created_at"            timestamp with time zone not null default now(),
  constraint "module_rule_sets_pkey" primary key (id),
  constraint "module_rule_sets_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."module_rule_sets"
  enable row level security;

create policy "bob_full_read" on "public"."module_rule_sets"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "module_rule_sets_select" on "public"."module_rule_sets"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."module_rule_sets" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."module_rule_sets" is 'Operational rules per module: evidence requirements, approval policy, report templates.';
