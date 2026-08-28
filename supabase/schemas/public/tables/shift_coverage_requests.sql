create table "public"."shift_coverage_requests" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "shift_template_id"    uuid,
  "shift_date"           date                     not null,
  "start_time"           time without time zone   not null,
  "end_time"             time without time zone   not null,
  "site_id"              uuid,
  "patrol_route_id"      uuid,
  "required_staff_count" integer                  not null default 1,
  "required_credentials" text[]                   not null default '{}'::text[],
  "status"               text                     not null default 'open'::text,
  "urgency"              text                     not null default 'normal'::text,
  "claimed_by"           uuid,
  "claimed_at"           timestamp with time zone,
  "filled_at"            timestamp with time zone,
  "notes"                text,
  "created_by"           uuid                     not null,
  "created_at"           timestamp with time zone not null default now(),
  constraint "shift_coverage_requests_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "shift_coverage_requests_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id),
  constraint "shift_coverage_requests_pkey" primary key (id),
  constraint "shift_coverage_requests_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "shift_coverage_requests_status_check" check ((status = ANY (ARRAY['open'::text, 'claimed'::text, 'filled'::text, 'cancelled'::text]))),
  constraint "shift_coverage_requests_urgency_check" check ((urgency = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
  constraint "shift_coverage_requests_shift_template_id_fkey" foreign key (shift_template_id) references public.shift_templates(id),
  constraint "shift_coverage_requests_claimed_by_fkey" foreign key (claimed_by) references public.user_profiles(id),
  constraint "shift_coverage_requests_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."shift_coverage_requests"
  enable row level security;

create index idx_shift_coverage_date on public.shift_coverage_requests using btree (shift_date);

create index idx_shift_coverage_org on public.shift_coverage_requests using btree (organization_id);

create index idx_shift_coverage_status on public.shift_coverage_requests using btree (status);

create index idx_shift_coverage_urgency on public.shift_coverage_requests using btree (urgency)
  where (urgency = ANY (ARRAY['high'::text, 'urgent'::text]));

create trigger trg_notify_shift_coverage_open_created
  after insert on public.shift_coverage_requests
  for each row
  execute function public.notify_shift_coverage_open_created();

create policy "bob_full_read" on "public"."shift_coverage_requests"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "shift_coverage_insert" on "public"."shift_coverage_requests"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "shift_coverage_select" on "public"."shift_coverage_requests"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "shift_coverage_update" on "public"."shift_coverage_requests"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."shift_coverage_requests" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."shift_coverage_requests" is 'Open shifts needing coverage. Staff can claim these. Supports credential-aware matching.';
