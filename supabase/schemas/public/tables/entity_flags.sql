create table "public"."entity_flags" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "entity_type"     text                     not null,
  "entity_id"       uuid                     not null,
  "flag_type"       text                     not null,
  "alert_level"     text,
  "reason"          text,
  "active"          boolean                  not null default true,
  "raised_by"       uuid,
  "raised_at"       timestamp with time zone not null default now(),
  "resolved_at"     timestamp with time zone,
  "created_at"      timestamp with time zone not null default now(),
  constraint "entity_flags_alert_level_check" check ((alert_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
  constraint "entity_flags_entity_type_check" check ((entity_type = ANY (ARRAY['vehicle'::text, 'person'::text, 'place'::text, 'staff'::text]))),
  constraint "entity_flags_pkey" primary key (id),
  constraint "entity_flags_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "entity_flags_raised_by_fkey" foreign key (raised_by) references public.user_profiles(id) on delete set null
);

alter table "public"."entity_flags"
  enable row level security;

create index idx_entity_flags_entity on public.entity_flags using btree (entity_type, entity_id)
  where active;

create index idx_entity_flags_org on public.entity_flags using btree (organization_id, active);

create policy "bob_full_read" on "public"."entity_flags"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "entity_flags_select" on "public"."entity_flags"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "entity_flags_write" on "public"."entity_flags"
  for all
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."entity_flags" to "anon", "authenticated", "postgres", "service_role";

comment on policy "entity_flags_write" on "public"."entity_flags" is 'Write access (INSERT/UPDATE/DELETE) for entity_flags. Uses org_access_allowed() which covers all authenticated users within the org hierarchy. Officers create flags via ReportButton; admins manage flags via VehicleFlagsPage (now EntityFlagsPage). Replaces the separate vehicle_flags (0070), person_flags (0005), and location_flags (0103) write policies.';

comment on table "public"."entity_flags" is 'Org-scoped of-interest status (VOI/POI/LOI/trespass/welfare) keyed to a canonical entity. Replaces standalone vehicle_flags/person_flags/location_flags (retired in 0115 after 0114 backfill). Substantive flag detail stays org-scoped (Privacy Act).';
