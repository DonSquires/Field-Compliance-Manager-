create table "public"."persons" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid,
  "display_name"         text,
  "date_of_birth"        date,
  "person_record_id"     uuid,
  "welfare_flag"         boolean                  not null default false,
  "welfare_notes"        text,
  "created_at"           timestamp with time zone not null default now(),
  "updated_at"           timestamp with time zone not null default now(),
  "homeless_status"      text                     not null default 'none'::text,
  "homeless_verified_at" timestamp with time zone,
  "homeless_notes"       text,
  constraint "persons_homeless_status_check" check ((homeless_status = ANY (ARRAY['none'::text, 'claiming'::text, 'investigating'::text, 'confirmed'::text]))),
  constraint "persons_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "persons_person_record_id_fkey" foreign key (person_record_id) references public.person_records(id),
  constraint "persons_pkey" primary key (id)
);

alter table "public"."persons"
  enable row level security;

create policy "bob_full_read" on "public"."persons"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "persons_insert" on "public"."persons"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "persons_select" on "public"."persons"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "persons_update" on "public"."persons"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."persons" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."persons"."homeless_status" is 'Independent homeless status for the person (e.g. living in a tent/vehicle), separate from any vehicle. Lifecycle: none -> claiming -> investigating -> confirmed.';

comment on column "public"."persons"."organization_id" is 'Origin/first-seen org (nullable). persons is now a platform-canonical identity (#9); substantive org-scoped intelligence (flags, interactions, observations) lives elsewhere and is org-scoped for Privacy Act compliance.';

comment on table "public"."persons" is 'Canonical person registry. Used for trespass, welfare, repeat offender, and access control.';
