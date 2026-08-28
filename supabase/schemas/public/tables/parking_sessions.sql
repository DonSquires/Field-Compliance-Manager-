create table "public"."parking_sessions" (
  "id"                uuid                     not null default gen_random_uuid(),
  "organization_id"   uuid                     not null,
  "officer_user_id"   uuid,
  "shift_id"          uuid,
  "location_id"       uuid,
  "zone_id"           uuid,
  "vehicle_id"        uuid,
  "plate"             text                     not null,
  "chalk_time"        timestamp with time zone,
  "permit_valid"      boolean,
  "permit_reference"  text,
  "compliance_status" text,
  "evidence_id"       uuid,
  "notes"             text,
  "observed_at"       timestamp with time zone not null default now(),
  "created_at"        timestamp with time zone not null default now(),
  constraint "parking_sessions_compliance_status_check" check ((compliance_status = ANY (ARRAY['compliant'::text, 'timed_out'::text, 'no_permit'::text, 'breach'::text]))),
  constraint "parking_sessions_evidence_id_fkey" foreign key (evidence_id) references public.evidence_items(id),
  constraint "parking_sessions_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "parking_sessions_pkey" primary key (id),
  constraint "parking_sessions_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "parking_sessions_shift_id_fkey" foreign key (shift_id) references public.shifts(id),
  constraint "parking_sessions_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id),
  constraint "parking_sessions_vehicle_id_fkey" foreign key (vehicle_id) references public.vehicles(id)
);

alter table "public"."parking_sessions"
  enable row level security;

create policy "bob_full_read" on "public"."parking_sessions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "parking_sessions_select" on "public"."parking_sessions"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "ps_zone_reachable_select" on "public"."parking_sessions"
  for select
  to "authenticated"
  using (public.has_location_access(null::uuid, zone_id, 'client_reads_provider'::text));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."parking_sessions" to "anon", "authenticated", "postgres", "service_role";

comment on policy "ps_zone_reachable_select" on "public"."parking_sessions" is 'Interrupt-tier W1 zone-anchored read (OWNER_RULINGS_ALIGNMENT_EDGES ruling 3; pair to vehicle_observations 0372). Additive PERMISSIVE SELECT: the zone-owning (client) org sees the parking session via has_location_access(null, zone_id, ''client_reads_provider''). PLACE family. ORs with the preserved org path (parking_sessions_select); never replaces it. Writes untouched (W1 read-only). NULL zone_id -> not widened (fail-closed, under-reach). Operationally corrected / Doctrinally incomplete.';

comment on table "public"."parking_sessions" is 'Parking enforcement chalk pass and permit check records. Links vehicle, zone, officer, and compliance verdict.';
