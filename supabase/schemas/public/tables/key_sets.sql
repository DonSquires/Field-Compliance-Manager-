create table "public"."key_sets" (
  "id"               uuid                     not null default gen_random_uuid(),
  "organization_id"  uuid                     not null,
  "site_id"          uuid,
  "patrol_route_id"  uuid,
  "name"             text                     not null,
  "description"      text,
  "key_count"        integer                  not null default 1,
  "storage_location" text,
  "is_active"        boolean                  not null default true,
  "created_at"       timestamp with time zone not null default now(),
  constraint "key_sets_pkey" primary key (id),
  constraint "key_sets_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "key_sets_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "key_sets_patrol_route_id_fkey" foreign key (patrol_route_id) references public.patrol_routes(id)
);

alter table "public"."key_sets"
  enable row level security;

create policy "bob_full_read" on "public"."key_sets"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "key_sets_select" on "public"."key_sets"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."key_sets" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."key_sets" is 'Key chains linked to patrol routes. Officers inherit key context from their roster shift.';
