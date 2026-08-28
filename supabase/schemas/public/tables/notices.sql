create table "public"."notices" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "breach_id"       uuid,
  "vehicle_id"      uuid,
  "person_id"       uuid,
  "location_id"     uuid,
  "officer_user_id" uuid,
  "notice_type"     text                     not null,
  "notice_number"   text,
  "legal_basis"     text,
  "fine_amount"     numeric(10,2),
  "comply_by"       timestamp with time zone,
  "status"          text                     not null default 'draft'::text,
  "authorized_by"   text,
  "authorized_at"   timestamp with time zone,
  "issued_at"       timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  constraint "notices_breach_id_fkey" foreign key (breach_id) references public.breach_records(id),
  constraint "notices_notice_type_check"
    check
    ((notice_type = ANY (ARRAY['warning'::text, 'infringement'::text, 'notice_to_vacate'::text, 'abatement'::text, 'direction'::text, 'enforcement'::text, 'biosecurity'::text,
    'smoke'::text]))),
  constraint "notices_pkey" primary key (id),
  constraint "notices_status_check" check ((status = ANY (ARRAY['draft'::text, 'issued'::text, 'paid'::text, 'under_dispute'::text, 'withdrawn'::text, 'overdue'::text]))),
  constraint "notices_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "notices_person_id_fkey" foreign key (person_id) references public.persons(id),
  constraint "notices_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id),
  constraint "notices_vehicle_id_fkey" foreign key (vehicle_id) references public.vehicles(id)
);

alter table "public"."notices"
  enable row level security;

create policy "bob_full_read" on "public"."notices"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "notices_insert" on "public"."notices"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "notices_select" on "public"."notices"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "notices_update" on "public"."notices"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."notices" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."notices" is 'All notice types: warning, infringement, NTV, abatement, direction, enforcement, biosecurity, smoke.';
