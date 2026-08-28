create table "public"."officer_field_reports" (
  "id"                 uuid                     not null default gen_random_uuid(),
  "organization_id"    uuid                     not null,
  "officer_id"         uuid                     not null,
  "shift_id"           uuid,
  "location_name"      text,
  "gps_lat"            double precision,
  "gps_lng"            double precision,
  "site_id"            uuid,
  "zone_id"            uuid,
  "title"              text                     not null,
  "description"        text                     not null,
  "immediate_action"   text,
  "follow_up_required" boolean                  not null default false,
  "follow_up_notes"    text,
  "photo_urls"         text[]                   default '{}'::text[],
  "persons_involved"   jsonb                    default '[]'::jsonb,
  "reviewed_by"        uuid,
  "reviewed_at"        timestamp with time zone,
  "review_notes"       text,
  "reported_at"        timestamp with time zone not null default now(),
  "created_at"         timestamp with time zone not null default now(),
  "updated_at"         timestamp with time zone not null default now(),
  "address"            text,
  constraint "officer_field_reports_pkey" primary key (id),
  constraint "officer_field_reports_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "officer_field_reports_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "officer_field_reports_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "officer_field_reports_shift_id_fkey" foreign key (shift_id) references public.shifts(id),
  constraint "officer_field_reports_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id),
  constraint "officer_field_reports_reviewed_by_fkey" foreign key (reviewed_by) references public.user_profiles(id)
);

alter table "public"."officer_field_reports"
  enable row level security;

alter table "public"."officer_field_reports"
  add column "severity" public.report_severity not null default 'low'::public.report_severity;

alter table "public"."officer_field_reports"
  add column "status" public.report_status not null default 'submitted'::public.report_status;

alter table "public"."officer_field_reports"
  add column "report_type" public.report_type not null;

create policy "bob_full_read" on "public"."officer_field_reports"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "officer_insert_field_reports" on "public"."officer_field_reports"
  for insert
  to PUBLIC
  with check ((public.org_access_allowed(organization_id) AND (officer_id = auth.uid())));

create policy "officer_update_field_reports" on "public"."officer_field_reports"
  for update
  to PUBLIC
  using ((public.org_access_allowed(organization_id) AND ((officer_id = auth.uid()) or public.is_admin_for_org(organization_id))));

create policy "org_access_officer_field_reports" on "public"."officer_field_reports"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."officer_field_reports" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."officer_field_reports"."address" is 'Physical address of the report. Complements existing gps_lat/lng + location_name + site_id so every report is fully location-anchored.';
