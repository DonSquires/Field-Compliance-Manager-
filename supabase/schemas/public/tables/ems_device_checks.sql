create table "public"."ems_device_checks" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "device_id"           uuid                     not null,
  "officer_user_id"     uuid,
  "signal_quality"      text,
  "physical_condition"  text,
  "participant_present" boolean,
  "tamper_observed"     boolean                  not null default false,
  "notes"               text,
  "gps_lat"             double precision,
  "gps_lng"             double precision,
  "checked_at"          timestamp with time zone not null default now(),
  constraint "ems_device_checks_pkey" primary key (id),
  constraint "ems_device_checks_signal_quality_check" check ((signal_quality = ANY (ARRAY['strong'::text, 'weak'::text, 'no_signal'::text]))),
  constraint "ems_device_checks_device_id_fkey" foreign key (device_id) references public.ems_devices(id),
  constraint "ems_device_checks_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "ems_device_checks_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."ems_device_checks"
  enable row level security;

create policy "bob_full_read" on "public"."ems_device_checks"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ems_device_checks_select" on "public"."ems_device_checks"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."ems_device_checks" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."ems_device_checks" is 'EMS device welfare and compliance checks. Tamper observations trigger alert workflow.';
