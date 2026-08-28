create table "public"."timesheets" (
  "id"                      uuid                     not null default gen_random_uuid(),
  "organization_id"         uuid                     not null,
  "staff_id"                uuid                     not null,
  "shift_id"                uuid,
  "period_start"            date                     not null,
  "period_end"              date                     not null,
  "scheduled_hours"         numeric(6,2),
  "actual_hours"            numeric(6,2),
  "overtime_hours"          numeric(6,2)             not null default 0,
  "status"                  text                     not null default 'draft'::text,
  "approved_by"             uuid,
  "approved_at"             timestamp with time zone,
  "notes"                   text,
  "created_at"              timestamp with time zone not null default now(),
  "submitted_at"            timestamp with time zone,
  "payroll_export_batch_id" uuid,
  constraint "timesheets_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "timesheets_payroll_export_batch_fk" foreign key (payroll_export_batch_id) references public.payroll_export_batches(id) on delete set null,
  constraint "timesheets_pkey" primary key (id),
  constraint "timesheets_shift_id_fkey" foreign key (shift_id) references public.shifts(id),
  constraint "timesheets_staff_id_fkey" foreign key (staff_id) references public.staff_profiles(id),
  constraint "timesheets_status_check" check ((status = ANY (ARRAY['draft'::text, 'submitted'::text, 'approved'::text, 'rejected'::text, 'paid'::text]))),
  constraint "timesheets_approved_by_fkey" foreign key (approved_by) references public.user_profiles(id)
);

alter table "public"."timesheets"
  enable row level security;

create policy "bob_full_read" on "public"."timesheets"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."timesheets"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "timesheets_insert" on "public"."timesheets"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "timesheets_officer_insert" on "public"."timesheets"
  for insert
  to PUBLIC
  with check ((staff_id IN ( SELECT sp.id
   FROM public.staff_profiles sp
  WHERE (sp.user_id = auth.uid()))));

create policy "timesheets_officer_self" on "public"."timesheets"
  for select
  to PUBLIC
  using ((staff_id in ( select sp.id
   from public.staff_profiles sp
  where (sp.user_id = auth.uid()))));

create policy "timesheets_select" on "public"."timesheets"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "timesheets_update" on "public"."timesheets"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."timesheets" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."timesheets" is 'Timesheet records per staff member per period. Feeds into invoicing and payroll export.';
