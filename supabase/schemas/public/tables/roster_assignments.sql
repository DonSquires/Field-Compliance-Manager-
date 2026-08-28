create table "public"."roster_assignments" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "roster_template_id"   uuid,
  "officer_id"           uuid                     not null,
  "patrol_route_id"      uuid,
  "site_id"              uuid,
  "service_type"         text                     not null,
  "day_of_week"          integer,
  "specific_date"        date,
  "shift"                text                     not null,
  "start_time"           time without time zone,
  "end_time"             time without time zone,
  "assignment_status"    text                     not null default 'scheduled'::text,
  "swapped_with_id"      uuid,
  "notification_sent_at" timestamp with time zone,
  "accepted_at"          timestamp with time zone,
  "declined_at"          timestamp with time zone,
  "decline_reason"       text,
  "created_by"           uuid,
  "created_at"           timestamp with time zone not null default now(),
  "external_refs"        jsonb                    not null default '{}'::jsonb,
  constraint "roster_assignments_assignment_status_check"
    check ((assignment_status = ANY (ARRAY['scheduled'::text, 'confirmed'::text, 'declined'::text, 'swapped'::text, 'cancelled'::text]))),
  constraint "roster_assignments_check" check ((((day_of_week IS NOT NULL) AND (specific_date IS NULL)) OR ((day_of_week IS NULL) AND (specific_date IS NOT NULL)))),
  constraint "roster_assignments_day_of_week_check" check (((day_of_week >= 1) AND (day_of_week <= 7))),
  constraint "roster_assignments_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "roster_assignments_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id),
  constraint "roster_assignments_pkey" primary key (id),
  constraint "roster_assignments_shift_check" check ((shift = ANY (ARRAY['day'::text, 'swing'::text, 'night'::text, 'overnight'::text]))),
  constraint "roster_assignments_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "roster_assignments_swapped_with_id_fkey" foreign key (swapped_with_id) references public.roster_assignments(id),
  constraint "roster_assignments_roster_template_id_fkey" foreign key (roster_template_id) references public.roster_templates(id) on delete set null,
  constraint "roster_assignments_created_by_fkey" foreign key (created_by) references public.user_profiles(id),
  constraint "roster_assignments_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id)
);

alter table "public"."roster_assignments"
  enable row level security;

create index idx_roster_assignments_external_refs on public.roster_assignments using gin (external_refs);

create trigger trg_notify_roster_assignment_created
  after insert on public.roster_assignments
  for each row
  execute function public.notify_roster_assignment_created();

create policy "bob_full_read" on "public"."roster_assignments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "roster_assignments_insert" on "public"."roster_assignments"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "roster_assignments_select" on "public"."roster_assignments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "roster_assignments_update" on "public"."roster_assignments"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."roster_assignments" to "anon", "authenticated", "postgres", "service_role";
