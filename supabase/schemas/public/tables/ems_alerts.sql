create table "public"."ems_alerts" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "device_id"       uuid                     not null,
  "alert_type"      text                     not null,
  "severity"        text                     not null,
  "status"          text                     not null default 'active'::text,
  "outcome"         text,
  "responded_by"    uuid,
  "acknowledged_at" timestamp with time zone,
  "resolved_at"     timestamp with time zone,
  "triggered_at"    timestamp with time zone not null default now(),
  constraint "ems_alerts_alert_type_check" check ((alert_type = ANY (ARRAY['tamper'::text, 'zone_breach'::text, 'missed_check_in'::text, 'low_battery'::text, 'other'::text]))),
  constraint "ems_alerts_outcome_check"
    check ((outcome = ANY (ARRAY['false_alarm'::text, 'physical_damage'::text, 'deliberate_tamper'::text, 'device_fault'::text, 'other'::text]))),
  constraint "ems_alerts_pkey" primary key (id),
  constraint "ems_alerts_severity_check" check ((severity = ANY (ARRAY['standard'::text, 'high'::text, 'critical'::text]))),
  constraint "ems_alerts_status_check" check ((status = ANY (ARRAY['active'::text, 'acknowledged'::text, 'resolved'::text, 'false_alarm'::text]))),
  constraint "ems_alerts_device_id_fkey" foreign key (device_id) references public.ems_devices(id),
  constraint "ems_alerts_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "ems_alerts_responded_by_fkey" foreign key (responded_by) references public.user_profiles(id)
);

alter table "public"."ems_alerts"
  enable row level security;

create policy "bob_full_read" on "public"."ems_alerts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "ems_alerts_select" on "public"."ems_alerts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."ems_alerts" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."ems_alerts" is 'EMS tamper, zone breach, missed check-in, and low battery alerts with response lifecycle.';
