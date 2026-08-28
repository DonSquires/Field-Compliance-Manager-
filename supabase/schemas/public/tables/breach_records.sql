create table "public"."breach_records" (
  "id"                     uuid                     not null default gen_random_uuid(),
  "organization_id"        uuid                     not null,
  "vehicle_id"             uuid,
  "vehicle_observation_id" uuid,
  "location_id"            uuid,
  "zone_id"                uuid,
  "officer_user_id"        uuid,
  "module_key"             text                     not null,
  "breach_type"            text                     not null,
  "status"                 text                     not null default 'active'::text,
  "bob_triage_summary"     text,
  "detected_at"            timestamp with time zone not null default now(),
  "actioned_at"            timestamp with time zone,
  "created_at"             timestamp with time zone not null default now(),
  constraint "breach_records_pkey" primary key (id),
  constraint "breach_records_status_check" check ((status = ANY (ARRAY['active'::text, 'pending_review'::text, 'actioned'::text, 'resolved'::text, 'rejected'::text]))),
  constraint "breach_records_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "breach_records_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "breach_records_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id),
  constraint "breach_records_vehicle_observation_id_fkey" foreign key (vehicle_observation_id) references public.vehicle_observations(id),
  constraint "breach_records_vehicle_id_fkey" foreign key (vehicle_id) references public.vehicles(id)
);

alter table "public"."breach_records"
  enable row level security;

create policy "bob_full_read" on "public"."breach_records"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "br_zone_reachable_select" on "public"."breach_records"
  for select
  to "authenticated"
  using (public.has_location_access(null::uuid, zone_id, 'client_reads_provider'::text));

create policy "breach_records_insert" on "public"."breach_records"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "breach_records_select" on "public"."breach_records"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "breach_records_update" on "public"."breach_records"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."breach_records" to "anon", "authenticated", "postgres", "service_role";

comment on policy "br_zone_reachable_select" on "public"."breach_records" is 'W1 zone-anchored read (ledger Bucket B; place family, same as interrupt-tier 0372/0373). Additive PERMISSIVE SELECT: the zone-owning (client) org sees the breach via has_location_access(null, zone_id, ''client_reads_provider''). PLACE family, NOT task-entitlement (task_assignments has no breach_record_id). ORs with the preserved org path (breach_records_select); never replaces it. Writes untouched (W1 read-only). zone_id is the chosen anchor (declared FK; location_id is not re-anchorable). NULL zone_id -> not widened (fail-closed, under-reach). Operationally corrected / Doctrinally incomplete.';

comment on table "public"."breach_records" is 'Detected compliance breaches. Links vehicle, observation, location, officer, and module.';
