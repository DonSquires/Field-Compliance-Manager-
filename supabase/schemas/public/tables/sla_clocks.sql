create table "public"."sla_clocks" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "service_agreement_id" uuid,
  "obligation_id"        uuid,
  "dispatch_job_id"      uuid,
  "alarm_event_id"       uuid,
  "site_id"              uuid,
  "started_at"           timestamp with time zone not null default now(),
  "target_minutes"       integer,
  "arrived_at"           timestamp with time zone,
  "elapsed_minutes"      integer,
  "status"               text                     not null default 'running'::text,
  "notes"                text,
  "created_at"           timestamp with time zone not null default now(),
  "updated_at"           timestamp with time zone not null default now(),
  constraint "sla_clocks_alarm_event_id_fkey" foreign key (alarm_event_id) references public.alarm_events(id) on delete set null,
  constraint "sla_clocks_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id) on delete set null,
  constraint "sla_clocks_obligation_id_fkey" foreign key (obligation_id) references public.agreement_obligations(id) on delete set null,
  constraint "sla_clocks_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "sla_clocks_pkey" primary key (id),
  constraint "sla_clocks_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id) on delete set null,
  constraint "sla_clocks_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete set null,
  constraint "sla_clocks_status_check" check ((status = ANY (ARRAY['running'::text, 'met'::text, 'breached'::text, 'cancelled'::text])))
);

alter table "public"."sla_clocks"
  enable row level security;

create index idx_sla_clocks_agreement on public.sla_clocks using btree (service_agreement_id, started_at desc);

create index idx_sla_clocks_dispatch on public.sla_clocks using btree (dispatch_job_id)
  where (dispatch_job_id is not null);

create index idx_sla_clocks_org_status on public.sla_clocks using btree (organization_id, status, started_at desc);

create trigger trg_notify_sla_breach
  after update on public.sla_clocks
  for each row
  execute function public.notify_sla_breach();

create policy "bob_full_read" on "public"."sla_clocks"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "sla_clocks_insert" on "public"."sla_clocks"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "sla_clocks_select" on "public"."sla_clocks"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "sla_clocks_update" on "public"."sla_clocks"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."sla_clocks" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."sla_clocks" is 'SLA response clocks. One per dispatch/alarm event: started_at -> arrived_at, verdict met/breached vs target_minutes. Feeds the obligation dashboard + report packs.';
