create table "public"."callout_shifts" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "on_call_period_id"   uuid                     not null,
  "officer_user_id"     uuid                     not null,
  "dispatch_job_id"     uuid,
  "minimum_pay_hours"   numeric(4,2)             not null default 3,
  "after_minimum_rate"  numeric(10,2),
  "callout_received_at" timestamp with time zone,
  "departed_at"         timestamp with time zone,
  "arrived_at"          timestamp with time zone,
  "work_started_at"     timestamp with time zone,
  "work_ended_at"       timestamp with time zone,
  "returned_at"         timestamp with time zone,
  "created_at"          timestamp with time zone not null default now(),
  constraint "callout_shifts_pkey" primary key (id),
  constraint "callout_shifts_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id),
  constraint "callout_shifts_on_call_period_id_fkey" foreign key (on_call_period_id) references public.on_call_periods(id),
  constraint "callout_shifts_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "callout_shifts_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."callout_shifts"
  enable row level security;

create policy "bob_full_read" on "public"."callout_shifts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "callout_shifts_select" on "public"."callout_shifts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."callout_shifts" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."callout_shifts" is 'Ad-hoc callout shifts. Minimum 3hr pay guaranteed. Tracks full callout timeline.';
