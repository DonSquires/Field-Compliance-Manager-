create table "public"."crm_contacts" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "first_name"      text                     not null,
  "last_name"       text                     not null,
  "role_title"      text,
  "email"           text,
  "phone"           text,
  "mobile"          text,
  "is_primary"      boolean                  not null default false,
  "is_emergency"    boolean                  not null default false,
  "notes"           text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "crm_contacts_pkey" primary key (id),
  constraint "crm_contacts_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."crm_contacts"
  enable row level security;

create policy "bob_full_read" on "public"."crm_contacts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "crm_contacts_delete" on "public"."crm_contacts"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "crm_contacts_insert" on "public"."crm_contacts"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "crm_contacts_select" on "public"."crm_contacts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "crm_contacts_update" on "public"."crm_contacts"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

create policy "gm_full_access" on "public"."crm_contacts"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "master_manage_contacts_insert" on "public"."crm_contacts"
  for insert
  to "authenticated"
  with check (public.is_master_for_org(organization_id));

create policy "master_manage_contacts_update" on "public"."crm_contacts"
  for update
  to "authenticated"
  using (public.is_master_for_org(organization_id))
  with check (public.is_master_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."crm_contacts" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."crm_contacts" is 'People associated with a client or service provider. Multiple contacts per org.';
