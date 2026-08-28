create table "public"."ems_devices" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "device_serial"    text                     not null,
  "person_id"        uuid,
  "anchor_address"   text,
  "anchor_gps_lat"   double precision,
  "anchor_gps_lng"   double precision,
  "agency_reference" text,
  "fit_conditions"   jsonb                    not null default '{}'::jsonb,
  "status"           text                     not null default 'active'::text,
  "fitted_by"        uuid,
  "fitted_at"        timestamp with time zone,
  "removed_at"       timestamp with time zone,
  "removal_reason"   text,
  "created_at"       timestamp with time zone not null default now(),
  constraint "ems_devices_device_serial_key" unique (device_serial),
  constraint "ems_devices_pkey" primary key (id),
  constraint "ems_devices_status_check" check ((status = ANY (ARRAY['active'::text, 'removed'::text, 'fault'::text, 'tampered'::text]))),
  constraint "ems_devices_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "ems_devices_person_id_fkey" foreign key (person_id) references public.persons(id),
  constraint "ems_devices_fitted_by_fkey" foreign key (fitted_by) references public.user_profiles(id)
);

alter table "public"."ems_devices"
  enable row level security;

create policy "bob_full_read" on "public"."ems_devices"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ems_devices_select" on "public"."ems_devices"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."ems_devices" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."ems_devices" is 'Electronic monitoring devices. Fitted to participants under bail or sentence supervision.';
