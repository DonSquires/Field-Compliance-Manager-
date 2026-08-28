create table "public"."crm_jurisdiction_configs" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "organization_id"       uuid                     not null,
  "jurisdiction_name"     text                     not null,
  "jurisdiction_type"     text                     not null,
  "fca_authority"         boolean                  not null default false,
  "rma_authority"         boolean                  not null default false,
  "biosecurity_authority" boolean                  not null default false,
  "trespass_authority"    boolean                  not null default true,
  "lga_authority"         boolean                  not null default false,
  "bylaw_name"            text,
  "bylaw_year"            integer,
  "bylaw_url"             text,
  "infringement_amount"   numeric(10,2)            default 200.00,
  "payment_url"           text,
  "objections_email"      text,
  "payment_deadline_days" integer                  default 28,
  "legal_contact_name"    text,
  "legal_contact_email"   text,
  "legal_contact_phone"   text,
  "notes"                 text,
  "created_at"            timestamp with time zone not null default now(),
  constraint "crm_jurisdiction_configs_jurisdiction_type_check"
    check
    ((jurisdiction_type = ANY (ARRAY['district_council'::text, 'city_council'::text, 'regional_council'::text, 'government_agency'::text, 'private_enterprise'::text,
    'hospital'::text, 'education'::text, 'other'::text]))),
  constraint "crm_jurisdiction_configs_pkey" primary key (id),
  constraint "crm_jurisdiction_configs_organization_id_fkey" foreign key (organization_id) references public.organizations(id)
);

alter table "public"."crm_jurisdiction_configs"
  enable row level security;

create policy "bob_full_read" on "public"."crm_jurisdiction_configs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "crm_jurisdiction_configs_insert" on "public"."crm_jurisdiction_configs"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "crm_jurisdiction_configs_select" on "public"."crm_jurisdiction_configs"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "crm_jurisdiction_configs_update" on "public"."crm_jurisdiction_configs"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."crm_jurisdiction_configs" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."crm_jurisdiction_configs" is 'Legal authority and bylaw configuration per organisation. Governs which notices can be issued and what legal basis applies.';
