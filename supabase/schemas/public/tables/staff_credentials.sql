create table "public"."staff_credentials" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "staff_id"              uuid                     not null,
  "organization_id"       uuid                     not null,
  "credential_type"       text                     not null,
  "credential_number"     text,
  "issuing_authority"     text,
  "issued_date"           date,
  "expiry_date"           date,
  "authorized_activities" text[]                   not null default '{}'::text[],
  "document_storage_path" text,
  "verified"              boolean                  not null default false,
  "verified_by"           uuid,
  "verified_at"           timestamp with time zone,
  "notes"                 text,
  "created_at"            timestamp with time zone not null default now(),
  constraint "staff_credentials_credential_type_check"
    check
    ((credential_type = ANY (ARRAY['certificate_of_authority'::text, 'warrant_of_authority'::text, 'drivers_licence'::text, 'first_aid'::text, 'security_licence'::text,
    'firearms_licence'::text, 'noise_control_warrant'::text, 'biosecurity_warrant'::text, 'other'::text]))),
  constraint "staff_credentials_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "staff_credentials_pkey" primary key (id),
  constraint "staff_credentials_staff_id_fkey" foreign key (staff_id) references public.staff_profiles(id) on delete cascade,
  constraint "staff_credentials_verified_by_fkey" foreign key (verified_by) references public.user_profiles(id)
);

alter table "public"."staff_credentials"
  enable row level security;

create policy "bob_full_read" on "public"."staff_credentials"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."staff_credentials"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "staff_credentials_insert" on "public"."staff_credentials"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "staff_credentials_select" on "public"."staff_credentials"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "staff_credentials_update" on "public"."staff_credentials"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_credentials" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."staff_credentials" is 'Certificates of Authority, Warrants, licences, and other credentials. Determines what enforcement actions an officer can take.';
