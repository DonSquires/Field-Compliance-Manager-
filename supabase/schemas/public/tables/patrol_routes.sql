create table "public"."patrol_routes" (
  "id"                        uuid                     not null default gen_random_uuid(),
  "organization_id"           uuid                     not null,
  "site_id"                   uuid,
  "name"                      text                     not null,
  "route_code"                text,
  "description"               text,
  "route_type"                text                     not null default 'patrol'::text,
  "default_shift"             text,
  "default_start_time"        time without time zone,
  "default_end_time"          time without time zone,
  "expected_duration_minutes" integer,
  "checkpoint_mode"           text                     not null default 'sequential'::text,
  "min_checkpoints_required"  integer,
  "active_days"               integer[]                not null default '{1,2,3,4,5,6,7}'::integer[],
  "is_active"                 boolean                  not null default true,
  "color"                     text                     default '#D32F2F'::text,
  "created_at"                timestamp with time zone not null default now(),
  "call_sign"                 text,
  "guards_required"           integer                  not null default 1,
  "assignment_type"           text,
  "parent_assignment_id"      uuid,
  constraint "patrol_routes_assignment_type_check" check ((assignment_type = ANY (ARRAY['general_patrol'::text, 'client_patrol'::text, 'specialty_patrol'::text, 'static'::text]))),
  constraint "patrol_routes_checkpoint_mode_check" check ((checkpoint_mode = ANY (ARRAY['sequential'::text, 'any_order'::text, 'random'::text, 'none'::text]))),
  constraint "patrol_routes_default_shift_check" check ((default_shift = ANY (ARRAY['day'::text, 'swing'::text, 'night'::text, 'overnight'::text]))),
  constraint "patrol_routes_guards_required_check" check ((guards_required >= 1)),
  constraint "patrol_routes_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "patrol_routes_pkey" primary key (id),
  constraint "patrol_routes_parent_assignment_id_fkey" foreign key (parent_assignment_id) references public.patrol_routes(id) on delete set null,
  constraint "patrol_routes_route_type_check" check ((route_type = ANY (ARRAY['patrol'::text, 'mobile'::text, 'static'::text, 'roving'::text, 'response'::text]))),
  constraint "patrol_routes_site_id_fkey" foreign key (site_id) references public.client_sites(id)
);

alter table "public"."patrol_routes"
  enable row level security;

create index idx_patrol_routes_parent on public.patrol_routes using btree (parent_assignment_id)
  where (parent_assignment_id is not null);

create policy "bob_full_read" on "public"."patrol_routes"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "gm_full_access" on "public"."patrol_routes"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "patrol_routes_insert" on "public"."patrol_routes"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "patrol_routes_select" on "public"."patrol_routes"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "patrol_routes_update" on "public"."patrol_routes"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrol_routes" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."patrol_routes"."assignment_type" is 'Assignment type for dispatch routing and channel grouping: general_patrol | client_patrol | specialty_patrol | static. Epic #190 R1.';

comment on column "public"."patrol_routes"."call_sign" is 'Base call sign for this assignment (e.g. Alpha). Child positions sequence from this (Alpha 1, Alpha 2). Epic #190 R1.';

comment on column "public"."patrol_routes"."guards_required" is 'Number of staffable positions under this assignment. 1 = single guard (static or solo patrol). Epic #190 R1.';

comment on column "public"."patrol_routes"."parent_assignment_id" is 'Self-referencing FK: child position points to its parent assignment. Null = top-level assignment. Epic #190 R1.';

comment on table "public"."patrol_routes" is 'Permanent named patrol templates. Linked to sites and zones. Assigned to officers via roster.';
