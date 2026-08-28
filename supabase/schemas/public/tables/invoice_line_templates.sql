create table "public"."invoice_line_templates" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "site_id"          uuid,
  "description"      text                     not null,
  "unit_price"       numeric(10,2)            not null,
  "default_quantity" numeric(8,2)             not null default 1,
  "unit_label"       text                     not null default 'unit'::text,
  "sort_order"       integer                  not null default 0,
  "active"           boolean                  not null default true,
  "created_at"       timestamp with time zone not null default now(),
  constraint "invoice_line_templates_pkey" primary key (id),
  constraint "invoice_line_templates_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete cascade,
  constraint "invoice_line_templates_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."invoice_line_templates"
  enable row level security;

create policy "bob_full_read" on "public"."invoice_line_templates"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ilt_insert" on "public"."invoice_line_templates"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "ilt_select" on "public"."invoice_line_templates"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ilt_update" on "public"."invoice_line_templates"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."invoice_line_templates" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."invoice_line_templates" is 'Reusable line item templates per site for quick invoice generation.';
