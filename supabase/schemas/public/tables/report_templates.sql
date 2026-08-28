create table "public"."report_templates" (
  "id"              uuid  not null default gen_random_uuid(),
  "organization_id" uuid  not null,
  "module_key"      text  not null,
  "template_code"   text  not null,
  "name"            text  not null,
  "output_policy"   jsonb not null default '{}'::jsonb,
  constraint "report_templates_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "report_templates_organization_id_template_code_key" unique (organization_id, template_code),
  constraint "report_templates_pkey" primary key (id)
);

alter table "public"."report_templates"
  enable row level security;

create policy "bob_full_read" on "public"."report_templates"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "report_templates_select" on "public"."report_templates"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."report_templates" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."report_templates" is 'Report templates per module. Controls output format and client visibility.';
