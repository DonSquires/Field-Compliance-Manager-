create table "public"."patrols" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "shift_id"        uuid,
  "officer_user_id" uuid                     not null,
  "location_id"     uuid,
  "zone_id"         uuid,
  "status"          text                     not null default 'in_progress'::text,
  "started_at"      timestamp with time zone not null default now(),
  "ended_at"        timestamp with time zone,
  "notes"           text,
  "created_at"      timestamp with time zone not null default now(),
  constraint "patrols_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "patrols_pkey" primary key (id),
  constraint "patrols_status_check" check ((status = ANY (ARRAY['in_progress'::text, 'completed'::text, 'cancelled'::text]))),
  constraint "patrols_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "patrols_shift_id_fkey" foreign key (shift_id) references public.shifts(id),
  constraint "patrols_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."patrols"
  enable row level security;

create policy "bob_full_read" on "public"."patrols"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "patrols_insert" on "public"."patrols"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "patrols_select" on "public"."patrols"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "patrols_update" on "public"."patrols"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."patrols" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."patrols" is 'Patrol sessions. Links shift, officer, location, and zone.';
