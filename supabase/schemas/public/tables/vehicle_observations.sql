create table "public"."vehicle_observations" (
  "id"                      uuid                     not null default gen_random_uuid(),
  "organization_id"         uuid                     not null,
  "vehicle_id"              uuid,
  "plate_raw"               text                     not null,
  "plate_confidence"        real,
  "location_id"             uuid,
  "zone_id"                 uuid,
  "gps_lat"                 double precision,
  "gps_lng"                 double precision,
  "officer_user_id"         uuid,
  "patrol_id"               uuid,
  "shift_id"                uuid,
  "module_key"              text                     not null,
  "compliance_status"       text,
  "compliance_detail"       jsonb                    not null default '{}'::jsonb,
  "primary_evidence_id"     uuid,
  "previous_observation_id" uuid,
  "movement_result"         text,
  "is_offline_queued"       boolean                  not null default false,
  "synced_at"               timestamp with time zone,
  "observed_at"             timestamp with time zone not null default now(),
  "created_at"              timestamp with time zone not null default now(),
  constraint "vehicle_observations_compliance_status_check" check ((compliance_status = ANY (ARRAY['compliant'::text, 'at_risk'::text, 'breach'::text, 'unknown'::text]))),
  constraint "vehicle_observations_movement_result_check" check ((movement_result = ANY (ARRAY['moved'::text, 'stationary'::text, 'inconclusive'::text]))),
  constraint "vehicle_observations_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id),
  constraint "vehicle_observations_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "vehicle_observations_pkey" primary key (id),
  constraint "vehicle_observations_previous_observation_id_fkey" foreign key (previous_observation_id) references public.vehicle_observations(id),
  constraint "vehicle_observations_primary_evidence_id_fkey" foreign key (primary_evidence_id) references public.evidence_items(id),
  constraint "vehicle_observations_vehicle_id_fkey" foreign key (vehicle_id) references public.vehicles(id)
);

alter table "public"."vehicle_observations"
  enable row level security;

create policy "bob_full_read" on "public"."vehicle_observations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "vehicle_observations_insert" on "public"."vehicle_observations"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "vehicle_observations_select" on "public"."vehicle_observations"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "vehicle_observations_update" on "public"."vehicle_observations"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "vo_zone_reachable_select" on "public"."vehicle_observations"
  for select
  to "authenticated"
  using (public.has_location_access(null::uuid, zone_id, 'client_reads_provider'::text));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."vehicle_observations" to "anon", "authenticated", "postgres", "service_role";

comment on policy "vo_zone_reachable_select" on "public"."vehicle_observations" is 'Interrupt-tier W1 zone-anchored read (OWNER_RULINGS_ALIGNMENT_EDGES ruling 3). Additive PERMISSIVE SELECT: the zone-owning (client) org -- the latent victim''s place -- sees the observation via has_location_access(null, zone_id, ''client_reads_provider''). PLACE family (0261/0263), not task-entitlement. ORs with the preserved org path (vehicle_observations_select); never replaces it. Writes untouched (W1 read-only). NULL zone_id -> not widened (fail-closed, under-reach). Operationally corrected / Doctrinally incomplete.';

comment on table "public"."vehicle_observations" is 'Every vehicle scan/observation. Links vehicle, zone, officer, patrol, evidence, and compliance verdict.';
