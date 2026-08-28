create table "public"."shift_templates" (
  "id"                   uuid                     not null default gen_random_uuid(),
  "organization_id"      uuid                     not null,
  "name"                 text                     not null,
  "description"          text,
  "shift_type"           text                     not null,
  "start_time"           time without time zone   not null,
  "end_time"             time without time zone   not null,
  "recurrence_type"      text                     not null default 'weekly'::text,
  "active_days"          integer[]                not null default '{1,2,3,4,5,6,7}'::integer[],
  "required_staff_count" integer                  not null default 1,
  "site_id"              uuid,
  "patrol_route_id"      uuid,
  "required_credentials" text[]                   not null default '{}'::text[],
  "is_active"            boolean                  not null default true,
  "effective_from"       date,
  "effective_to"         date,
  "color"                text                     default '#D32F2F'::text,
  "notes"                text,
  "created_by"           uuid,
  "created_at"           timestamp with time zone not null default now(),
  constraint "shift_templates_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "shift_templates_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id),
  constraint "shift_templates_pkey" primary key (id),
  constraint "shift_templates_recurrence_type_check" check ((recurrence_type = ANY (ARRAY['daily'::text, 'weekly'::text, 'fortnightly'::text, 'monthly'::text, 'custom'::text]))),
  constraint "shift_templates_shift_type_check" check ((shift_type = ANY (ARRAY['day'::text, 'swing'::text, 'night'::text, 'overnight'::text, 'split'::text]))),
  constraint "shift_templates_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "shift_templates_created_by_fkey" foreign key (created_by) references public.user_profiles(id)
);

alter table "public"."shift_templates"
  enable row level security;

create index idx_shift_templates_org on public.shift_templates using btree (organization_id);

create index idx_shift_templates_route on public.shift_templates using btree (patrol_route_id)
  where (patrol_route_id is not null);

create index idx_shift_templates_site on public.shift_templates using btree (site_id)
  where (site_id is not null);

create policy "bob_full_read" on "public"."shift_templates"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "shift_templates_delete" on "public"."shift_templates"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "shift_templates_insert" on "public"."shift_templates"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "shift_templates_select" on "public"."shift_templates"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "shift_templates_update" on "public"."shift_templates"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."shift_templates" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."shift_templates" is 'Recurring shift patterns. Used to generate actual shifts with coverage requirements and credential validation.';
