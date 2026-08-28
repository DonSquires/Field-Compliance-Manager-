create table "public"."dispatch_resources" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "name"                text                     not null,
  "callsign"            text,
  "service_type"        text                     not null,
  "location_id"         uuid,
  "assigned_officer_id" uuid,
  "status"              text                     not null default 'available'::text,
  "created_at"          timestamp with time zone not null default now(),
  constraint "dispatch_resources_pkey" primary key (id),
  constraint "dispatch_resources_status_check" check ((status = ANY (ARRAY['available'::text, 'busy'::text, 'offline'::text]))),
  constraint "dispatch_resources_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "dispatch_resources_assigned_officer_id_fkey" foreign key (assigned_officer_id) references public.user_profiles(id)
);

alter table "public"."dispatch_resources"
  enable row level security;

create index idx_dispatch_resources_officer on public.dispatch_resources using btree (assigned_officer_id)
  where (assigned_officer_id is not null);

create policy "bob_full_read" on "public"."dispatch_resources"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "dispatch_resources_delete" on "public"."dispatch_resources"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "dispatch_resources_insert" on "public"."dispatch_resources"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "dispatch_resources_select" on "public"."dispatch_resources"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "dispatch_resources_update" on "public"."dispatch_resources"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."dispatch_resources" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."dispatch_resources" is 'Named patrol runs / callsigns. Jobs dispatch to a resource (not an officer); the roster resolves which officer is on the run. SELECT org-scoped; write admin.';
