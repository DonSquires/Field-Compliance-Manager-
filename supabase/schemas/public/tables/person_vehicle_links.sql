create table "public"."person_vehicle_links" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "person_id"       uuid                     not null,
  "vehicle_id"      uuid                     not null,
  "linked_at"       timestamp with time zone not null default now(),
  "linked_by"       uuid,
  "notes"           text,
  constraint "person_vehicle_links_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "person_vehicle_links_pkey" primary key (id),
  constraint "person_vehicle_links_person_id_fkey" foreign key (person_id) references public.persons(id),
  constraint "person_vehicle_links_linked_by_fkey" foreign key (linked_by) references public.user_profiles(id),
  constraint "person_vehicle_links_vehicle_id_fkey" foreign key (vehicle_id) references public.vehicles(id)
);

alter table "public"."person_vehicle_links"
  enable row level security;

create policy "bob_full_read" on "public"."person_vehicle_links"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "person_vehicle_links_select" on "public"."person_vehicle_links"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."person_vehicle_links" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."person_vehicle_links" is 'Links a known person to a vehicle plate.';
