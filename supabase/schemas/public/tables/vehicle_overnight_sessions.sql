create table "public"."vehicle_overnight_sessions" (
  "id"                       uuid                     not null default gen_random_uuid(),
  "organization_id"          uuid                     not null,
  "plate_number"             text                     not null,
  "zone_id"                  uuid,
  "site_id"                  uuid,
  "location_id"              uuid,
  "overnight_date"           date                     not null,
  "timezone"                 text                     not null default 'Pacific/Auckland'::text,
  "evening_observation_id"   uuid,
  "evening_seen_at"          timestamp with time zone,
  "evening_gps_lat"          double precision,
  "evening_gps_lng"          double precision,
  "evening_photo_url"        text,
  "morning_observation_id"   uuid,
  "morning_seen_at"          timestamp with time zone,
  "morning_gps_lat"          double precision,
  "morning_gps_lng"          double precision,
  "morning_photo_url"        text,
  "verification_status"      text                     not null default 'candidate_evening'::text,
  "movement_decision"        text,
  "movement_similarity"      double precision,
  "gps_distance_meters"      double precision,
  "same_position_confidence" double precision,
  "evidence_strength"        text                     not null default 'pending'::text,
  "manual_review_required"   boolean                  not null default false,
  "observation_count"        integer                  not null default 1,
  "is_scv"                   boolean,
  "is_compliant"             boolean,
  "compliance_reason"        text,
  "breach_alert_id"          uuid,
  "created_at"               timestamp with time zone not null default now(),
  "updated_at"               timestamp with time zone not null default now(),
  "client_org_id"            uuid,
  constraint "vehicle_overnight_sessions_client_org_id_fkey" foreign key (client_org_id) references public.organizations(id),
  constraint "vehicle_overnight_sessions_evening_observation_id_fkey" foreign key (evening_observation_id) references public.observations(id),
  constraint "vehicle_overnight_sessions_evidence_strength_check"
    check ((evidence_strength = ANY (ARRAY['pending'::text, 'weak'::text, 'moderate'::text, 'strong'::text, 'manual_review'::text, 'inferred'::text]))),
  constraint "vehicle_overnight_sessions_morning_observation_id_fkey" foreign key (morning_observation_id) references public.observations(id),
  constraint "vehicle_overnight_sessions_movement_decision_check" check ((movement_decision = ANY (ARRAY['stationary'::text, 'moved'::text, 'inconclusive'::text]))),
  constraint "vehicle_overnight_sessions_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "vehicle_overnight_sessions_organization_id_plate_number_zon_key" unique (organization_id, plate_number, zone_id, overnight_date),
  constraint "vehicle_overnight_sessions_pkey" primary key (id),
  constraint "vehicle_overnight_sessions_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "vehicle_overnight_sessions_verification_status_check"
    check
    ((verification_status = ANY (ARRAY['candidate_evening'::text, 'verified_overnight'::text, 'not_verified'::text, 'moved'::text, 'inconclusive'::text,
    'manual_review_required'::text]))),
  constraint "vehicle_overnight_sessions_zone_id_fkey" foreign key (zone_id) references public.location_zones(id)
);

alter table "public"."vehicle_overnight_sessions"
  enable row level security;

create index idx_vehicle_overnight_sessions_client_org_id on public.vehicle_overnight_sessions using btree (client_org_id);

create index idx_vehicle_overnight_sessions_org_date on public.vehicle_overnight_sessions using btree (organization_id, overnight_date desc);

create index idx_vehicle_overnight_sessions_plate on public.vehicle_overnight_sessions using btree (plate_number, overnight_date desc);

create index idx_vehicle_overnight_sessions_zone_status on public.vehicle_overnight_sessions using btree (zone_id, verification_status, overnight_date desc);

create policy "bob_full_read" on "public"."vehicle_overnight_sessions"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "vehicle_overnight_sessions_client_org_select" on "public"."vehicle_overnight_sessions"
  for select
  to PUBLIC
  using (public.org_access_allowed(client_org_id));

create policy "vehicle_overnight_sessions_insert" on "public"."vehicle_overnight_sessions"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "vehicle_overnight_sessions_select" on "public"."vehicle_overnight_sessions"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "vehicle_overnight_sessions_update" on "public"."vehicle_overnight_sessions"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."vehicle_overnight_sessions" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."vehicle_overnight_sessions"."evidence_strength" is 'Evidence quality grade. pending/weak/moderate/strong = live two-photo pipeline grades. manual_review = requires human review. inferred = overnight presence inferred from consecutive-day historical observations (not court-grade evidence). Added in 0330 for issue #262/#257.';

comment on table "public"."vehicle_overnight_sessions" is 'Two-photo Freedom Camping overnight verification sessions. Evening candidates are verified by morning scans after local midnight.';
