create table "public"."staff_availability" (
  "id"                uuid                     not null default gen_random_uuid(),
  "staff_id"          uuid                     not null,
  "organization_id"   uuid                     not null,
  "day_of_week"       integer,
  "specific_date"     date,
  "available_from"    time without time zone,
  "available_to"      time without time zone,
  "all_day"           boolean                  not null default false,
  "availability_type" text                     not null default 'available'::text,
  "notes"             text,
  "created_at"        timestamp with time zone not null default now(),
  constraint "staff_availability_availability_type_check" check ((availability_type = ANY (ARRAY['available'::text, 'preferred'::text, 'unavailable'::text, 'leave'::text]))),
  constraint "staff_availability_check" check ((((day_of_week IS NOT NULL) AND (specific_date IS NULL)) OR ((day_of_week IS NULL) AND (specific_date IS NOT NULL)))),
  constraint "staff_availability_day_of_week_check" check (((day_of_week >= 1) AND (day_of_week <= 7))),
  constraint "staff_availability_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "staff_availability_pkey" primary key (id),
  constraint "staff_availability_staff_id_fkey" foreign key (staff_id) references public.staff_profiles(id) on delete cascade
);

alter table "public"."staff_availability"
  enable row level security;

create policy "bob_full_read" on "public"."staff_availability"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "staff_availability_insert" on "public"."staff_availability"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "staff_availability_select" on "public"."staff_availability"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "staff_availability_update" on "public"."staff_availability"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."staff_availability" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."staff_availability" is 'Standing availability patterns. Used by roster planner for intelligent shift assignment.';
