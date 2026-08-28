create table "public"."jurisdiction_template_overrides" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "jurisdiction_key" text                     not null,
  "decision_type"    text                     not null,
  "template_body"    text,
  "required_fields"  text[],
  "is_active"        boolean                  not null default true,
  "created_at"       timestamp with time zone not null default now(),
  "updated_at"       timestamp with time zone not null default now(),
  constraint "jurisdiction_template_overrides_pkey" primary key (id),
  constraint "jurisdiction_template_overrides_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."jurisdiction_template_overrides"
  enable row level security;

create index idx_jto_org on public.jurisdiction_template_overrides using btree (organization_id);

create unique index uq_jto_org_jurisdiction_decision on public.jurisdiction_template_overrides using btree (organization_id, jurisdiction_key, decision_type)
  where is_active;

create policy "bob_full_read" on "public"."jurisdiction_template_overrides"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "jto_org_select" on "public"."jurisdiction_template_overrides"
  for select
  to "authenticated"
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update
  on table "public"."jurisdiction_template_overrides"
  to "anon", "authenticated", "postgres", "service_role";
