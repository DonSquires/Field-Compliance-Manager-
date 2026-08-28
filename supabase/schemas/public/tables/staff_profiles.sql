create table "public"."staff_profiles" (
  "id"                         uuid                     not null,
  "organization_id"            uuid                     not null,
  "employee_number"            text,
  "employment_type"            text                     not null default 'permanent'::text,
  "start_date"                 date,
  "end_date"                   date,
  "emergency_contact_name"     text,
  "emergency_contact_phone"    text,
  "emergency_contact_relation" text,
  "date_of_birth"              date,
  "payroll_id"                 text,
  "tax_code"                   text,
  "bank_account"               text,
  "uniform_size"               text,
  "notes"                      text,
  "created_at"                 timestamp with time zone not null default now(),
  "user_id"                    uuid,
  "work_ready"                 boolean                  not null default false,
  "external_refs"              jsonb                    not null default '{}'::jsonb,
  constraint "staff_profiles_employment_type_check"
    check ((employment_type = ANY (ARRAY['permanent'::text, 'part_time'::text, 'casual'::text, 'contractor'::text, 'volunteer'::text]))),
  constraint "staff_profiles_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "staff_profiles_pkey" primary key (id),
  constraint "staff_profiles_id_fkey" foreign key (id) references public.user_profiles(id),
  constraint "staff_profiles_user_id_fkey" foreign key (user_id) references public.user_profiles(id) on delete set null
);

alter table "public"."staff_profiles"
  enable row level security;

create index idx_staff_profiles_external_refs on public.staff_profiles using gin (external_refs);

create index idx_staff_profiles_user_id on public.staff_profiles using btree (user_id);

create policy "bob_full_read" on "public"."staff_profiles"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."staff_profiles"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "staff_profiles_insert" on "public"."staff_profiles"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "staff_profiles_select" on "public"."staff_profiles"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "staff_profiles_update" on "public"."staff_profiles"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_profiles" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."staff_profiles"."external_refs" is 'Generic external system reference IDs. E.g. {"deputy": {"employee_id": "521735", "payroll_export_code": "356310000|MPP"}}';

comment on table "public"."staff_profiles" is 'Extended employment profile for staff. Covers employment type, emergency contact, payroll, and uniform.';
