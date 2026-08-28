create table "public"."welfare_checks" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "officer_user_id" uuid                     not null,
  "shift_id"        uuid,
  "status"          text                     not null,
  "notes"           text,
  "gps_lat"         double precision,
  "gps_lng"         double precision,
  "checked_in_at"   timestamp with time zone not null default now(),
  constraint "welfare_checks_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id),
  constraint "welfare_checks_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "welfare_checks_pkey" primary key (id),
  constraint "welfare_checks_shift_id_fkey" foreign key (shift_id) references public.shifts(id),
  constraint "welfare_checks_status_check" check ((status = ANY (ARRAY['ok'::text, 'overdue'::text, 'man_down'::text, 'sos'::text])))
);

alter table "public"."welfare_checks"
  enable row level security;

create policy "bob_full_read" on "public"."welfare_checks"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "welfare_checks_insert" on "public"."welfare_checks"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "welfare_checks_select" on "public"."welfare_checks"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."welfare_checks" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."welfare_checks" is 'Officer welfare check-in records. Overdue and man-down states trigger supervisor alerts.';
