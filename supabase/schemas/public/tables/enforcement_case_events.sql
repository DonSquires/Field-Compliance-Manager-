create table "public"."enforcement_case_events" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "case_id"         uuid                     not null,
  "event_type"      text                     not null,
  "description"     text,
  "observation_id"  uuid,
  "notice_id"       uuid,
  "infringement_id" uuid,
  "created_by"      uuid                     not null,
  "created_at"      timestamp with time zone not null default now(),
  constraint "enforcement_case_events_event_type_check"
    check
    ((event_type = ANY (ARRAY['case_opened'::text, 'verbal_warning'::text, 'written_warning'::text, 'notice_to_vacate'::text, 'infringement_issued'::text, 'tow_request'::text,
    'welfare_referral'::text, 'contact_attempt'::text, 'payment_received'::text, 'objection_received'::text, 'court_referral'::text, 'case_resolved'::text, 'note_added'::text]))),
  constraint "enforcement_case_events_pkey" primary key (id),
  constraint "enforcement_case_events_case_id_fkey" foreign key (case_id) references public.enforcement_cases(id),
  constraint "enforcement_case_events_infringement_id_fkey" foreign key (infringement_id) references public.infringement_notices(id),
  constraint "enforcement_case_events_notice_id_fkey" foreign key (notice_id) references public.notices_to_vacate(id),
  constraint "enforcement_case_events_observation_id_fkey" foreign key (observation_id) references public.observations(id),
  constraint "enforcement_case_events_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "enforcement_case_events_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."enforcement_case_events"
  enable row level security;

create index idx_enforcement_case_events_case on public.enforcement_case_events using btree (case_id, created_at);

create policy "bob_full_read" on "public"."enforcement_case_events"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "enforcement_case_events_insert" on "public"."enforcement_case_events"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "enforcement_case_events_select" on "public"."enforcement_case_events"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."enforcement_case_events" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."enforcement_case_events" is 'Immutable timeline events for enforcement cases. Append-only audit trail.';
