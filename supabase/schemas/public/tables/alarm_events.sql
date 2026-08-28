create table "public"."alarm_events" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "site_id"         uuid,
  "dispatch_job_id" uuid,
  "signal_type"     text                     not null,
  "panel_id"        text,
  "zone_number"     text,
  "zone_name"       text,
  "account_number"  text,
  "location_name"   text,
  "notes"           text,
  "received_at"     timestamp with time zone not null default now(),
  "created_at"      timestamp with time zone not null default now(),
  constraint "alarm_events_pkey" primary key (id),
  constraint "alarm_events_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete set null,
  constraint "alarm_events_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id) on delete set null,
  constraint "alarm_events_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade
);

alter table "public"."alarm_events"
  enable row level security;

create index idx_alarm_events_org on public.alarm_events using btree (organization_id, received_at desc);

create index idx_alarm_events_site on public.alarm_events using btree (site_id);

create policy "alarm_events_insert" on "public"."alarm_events"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "alarm_events_select" on "public"."alarm_events"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "bob_full_read" on "public"."alarm_events"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."alarm_events" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."alarm_events" is 'Alarm signals received from monitoring systems. Linked to dispatch jobs for response tracking.';
