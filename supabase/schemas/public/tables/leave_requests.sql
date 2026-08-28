create table "public"."leave_requests" (
  "id"              uuid                     not null default gen_random_uuid(),
  "staff_id"        uuid                     not null,
  "organization_id" uuid                     not null,
  "leave_type"      text                     not null,
  "starts_on"       date                     not null,
  "ends_on"         date                     not null,
  "status"          text                     not null default 'pending'::text,
  "reason"          text,
  "approved_by"     uuid,
  "approved_at"     timestamp with time zone,
  "notes"           text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "leave_requests_leave_type_check"
    check ((leave_type = ANY (ARRAY['annual'::text, 'sick'::text, 'bereavement'::text, 'parental'::text, 'unpaid'::text, 'other'::text]))),
  constraint "leave_requests_pkey" primary key (id),
  constraint "leave_requests_status_check" check ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'declined'::text, 'cancelled'::text]))),
  constraint "leave_requests_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "leave_requests_staff_id_fkey" foreign key (staff_id) references public.staff_profiles(id) on delete cascade,
  constraint "leave_requests_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id)
);

alter table "public"."leave_requests"
  enable row level security;

create policy "bob_full_read" on "public"."leave_requests"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "leave_requests_insert" on "public"."leave_requests"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "leave_requests_select" on "public"."leave_requests"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "leave_requests_update" on "public"."leave_requests"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."leave_requests" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."leave_requests" is 'Staff leave requests. Approved leave is visible in the roster planner to prevent scheduling conflicts.';
