create table "public"."dispatch_jobs" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "service_agreement_id" uuid,
  "dispatch_resource_id" uuid,
  "location_id"          uuid,
  "client_site_id"       uuid,
  "job_type"             text                     not null,
  "priority"             text                     not null default 'normal'::text,
  "status"               text                     not null default 'pending'::text,
  "sla_minutes"          integer,
  "sla_breached"         boolean                  not null default false,
  "briefing_notes"       text,
  "outcome_notes"        text,
  "created_at"           timestamp with time zone not null default now(),
  "dispatched_at"        timestamp with time zone,
  "acknowledged_at"      timestamp with time zone,
  "en_route_at"          timestamp with time zone,
  "on_scene_at"          timestamp with time zone,
  "completed_at"         timestamp with time zone,
  "shift_id"             uuid,
  "shift_stop_id"        uuid,
  "sla_respond_by"       timestamp with time zone,
  "sla_impact_warning"   boolean                  not null default false,
  "sla_impact_report"    jsonb,
  "adhoc_inserted_at"    timestamp with time zone,
  "insert_gps_lat"       double precision,
  "insert_gps_lng"       double precision,
  constraint "dispatch_jobs_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id),
  constraint "dispatch_jobs_pkey" primary key (id),
  constraint "dispatch_jobs_priority_check" check ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
  constraint "dispatch_jobs_status_check"
    check
    ((status = ANY (ARRAY['pending'::text, 'pending_approval'::text, 'dispatched'::text, 'acknowledged'::text, 'en_route'::text, 'on_scene'::text, 'completed'::text,
    'cancelled'::text]))),
  constraint "dispatch_jobs_dispatch_resource_id_fkey" foreign key (dispatch_resource_id) references public.dispatch_resources(id),
  constraint "dispatch_jobs_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "dispatch_jobs_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id),
  constraint "dispatch_jobs_shift_id_fkey" foreign key (shift_id) references public.shifts(id) on delete set null
);

alter table "public"."dispatch_jobs"
  enable row level security;

create index idx_dispatch_jobs_client_site on public.dispatch_jobs using btree (client_site_id)
  where (client_site_id is not null);

create index idx_dispatch_jobs_live on public.dispatch_jobs using btree (dispatch_resource_id)
  where (completed_at is null);

create index idx_dispatch_jobs_resource on public.dispatch_jobs using btree (dispatch_resource_id)
  where (dispatch_resource_id is not null);

create index idx_dispatch_jobs_shift_id on public.dispatch_jobs using btree (shift_id)
  where (shift_id is not null);

create index idx_dispatch_jobs_sla_respond_by on public.dispatch_jobs using btree (sla_respond_by)
  where (sla_respond_by is not null);

create trigger dispatch_jobs_sla_clock_trigger
  after insert on public.dispatch_jobs
  for each row
  execute function public.dispatch_job_create_sla_clock();

create trigger trg_notify_dispatch_job_created
  after insert on public.dispatch_jobs
  for each row
  execute function public.notify_dispatch_job_created();

create trigger trg_validate_dispatch_job_service_agreement
  before insert or update of client_site_id, service_agreement_id on public.dispatch_jobs
  for each row
  execute function public.validate_dispatch_job_service_agreement();

create policy "bob_full_read" on "public"."dispatch_jobs"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dispatch_jobs_insert" on "public"."dispatch_jobs"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "dispatch_jobs_select" on "public"."dispatch_jobs"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "dispatch_jobs_update" on "public"."dispatch_jobs"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dispatch_jobs" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."dispatch_jobs"."briefing_notes" is 'Human-readable briefing for the responding officer. Written by field module pages.';

comment on column "public"."dispatch_jobs"."client_site_id" is 'Site the job is associated with. FK to client_sites. Written by NoiseControlPage.';

comment on column "public"."dispatch_jobs"."dispatch_resource_id" is 'FK to dispatch_resources (named patrol run / callsign). Written by field module pages when officer has an active shift.';

comment on column "public"."dispatch_jobs"."dispatched_at" is 'Timestamp when the job was dispatched to a resource. Written by field module pages.';

comment on column "public"."dispatch_jobs"."job_type" is 'Module-specific job type (e.g. noise_complaint, parking_enforcement). Written by field module pages.';

comment on column "public"."dispatch_jobs"."sla_minutes" is 'SLA target in minutes from job creation. Written by field module pages.';

comment on column "public"."dispatch_jobs"."sla_respond_by" is 'Absolute SLA deadline timestamp. Written by field module pages.';

comment on table "public"."dispatch_jobs" is 'Dispatch jobs with full lifecycle state machine. SLA tracking and client site context.';
