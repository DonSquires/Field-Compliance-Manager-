create table "public"."zone_closures" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "zone_id"           uuid                     not null,
  "closure_type"      text                     not null default 'temporary_closure'::text,
  "status"            text                     not null default 'active'::text,
  "effective_from"    date                     not null default CURRENT_DATE,
  "effective_to"      date,
  "reason"            text,
  "resolution_notes"  text,
  "notice_bundle_url" text,
  "created_by"        uuid,
  "lifted_by"         uuid,
  "lifted_at"         timestamp with time zone,
  "created_at"        timestamp with time zone not null default now(),
  "updated_at"        timestamp with time zone not null default now(),
  constraint "zone_closures_closure_type_check" check ((closure_type = ANY (ARRAY['prohibited'::text, 'restricted'::text, 'temporary_closure'::text]))),
  constraint "zone_closures_created_by_fkey" foreign key (created_by) references public.user_profiles(id),
  constraint "zone_closures_lifted_by_fkey" foreign key (lifted_by) references public.user_profiles(id),
  constraint "zone_closures_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "zone_closures_pkey" primary key (id),
  constraint "zone_closures_status_check" check ((status = ANY (ARRAY['scheduled'::text, 'active'::text, 'lifted'::text]))),
  constraint "zone_closures_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete cascade
);

alter table "public"."zone_closures"
  enable row level security;

create index idx_zone_closures_org_status on public.zone_closures using btree (organization_id, status, effective_from desc);

create index idx_zone_closures_zone on public.zone_closures using btree (zone_id, status);

create policy "bob_full_read" on "public"."zone_closures"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "zone_closures_insert" on "public"."zone_closures"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "zone_closures_select" on "public"."zone_closures"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "zone_closures_update" on "public"."zone_closures"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."zone_closures" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."zone_closures" is 'Temporary closures, prohibited and restricted area overlays per zone. Effective dates + reason + resolution + notice bundle reference. History kept.';
