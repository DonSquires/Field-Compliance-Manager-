create table "public"."welfare_alerts" (
  "id"                    uuid                     not null default gen_random_uuid(),
  "organization_id"       uuid                     not null,
  "officer_user_id"       uuid                     not null,
  "shift_id"              uuid,
  "alert_type"            text                     not null,
  "gps_lat"               double precision,
  "gps_lng"               double precision,
  "acknowledged_by"       uuid,
  "acknowledged_at"       timestamp with time zone,
  "resolved_at"           timestamp with time zone,
  "triggered_at"          timestamp with time zone not null default now(),
  "status"                text                     not null default 'pending'::text,
  "escalation_level"      integer                  not null default 1,
  "escalated_at"          timestamp with time zone,
  "acknowledgement_notes" text,
  "resolution_notes"      text,
  "resolved_by"           uuid,
  "officer_phone"         text,
  "last_activity_at"      timestamp with time zone,
  "gps_accuracy"          double precision,
  "notes"                 text,
  constraint "welfare_alerts_acknowledged_by_fkey" foreign key (acknowledged_by) references public.user_profiles(id),
  constraint "welfare_alerts_alert_type_check"
    check
    ((alert_type = ANY (ARRAY['overdue'::text, 'man_down'::text, 'sos'::text, 'armed_danger'::text, 'inactivity'::text, 'gps_lost'::text, 'missed'::text, 'manual'::text,
    'investigation_overdue'::text, 'check_in'::text]))),
  constraint "welfare_alerts_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id),
  constraint "welfare_alerts_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "welfare_alerts_pkey" primary key (id),
  constraint "welfare_alerts_resolved_by_fkey" foreign key (resolved_by) references public.user_profiles(id),
  constraint "welfare_alerts_shift_id_fkey" foreign key (shift_id) references public.shifts(id)
);

alter table "public"."welfare_alerts"
  enable row level security;

create policy "bob_full_read" on "public"."welfare_alerts"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "welfare_alerts_insert" on "public"."welfare_alerts"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "welfare_alerts_select" on "public"."welfare_alerts"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "welfare_alerts_update" on "public"."welfare_alerts"
  for update
  to PUBLIC
  using (((officer_user_id = auth.uid()) or public.is_admin_for_org(organization_id)))
  with check (((officer_user_id = auth.uid()) OR public.is_admin_for_org(organization_id)));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."welfare_alerts" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."welfare_alerts" is 'Escalated welfare alerts. SOS and armed_danger trigger emergency broadcast and supervisor notification.';
