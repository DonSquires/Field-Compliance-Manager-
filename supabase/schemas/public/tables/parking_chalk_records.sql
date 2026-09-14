create table "public"."parking_chalk_records" (
  "id"                           uuid                     not null default gen_random_uuid(),
  "organization_id"              uuid                     not null,
  "plate"                        text                     not null,
  "chalked_at"                   timestamp with time zone not null default now(),
  "return_by"                    timestamp with time zone not null default now(),
  "created_at"                   timestamp with time zone not null default now(),
  "officer_id"                   uuid,
  "officer_name"                 text,
  "site_id"                      uuid,
  "location_name"                text,
  "status"                       text                     not null default 'active'::text,
  "photo_url"                    text,
  "infringement_number"          text,
  "notes"                        text,
  "resolved_at"                  timestamp with time zone,
  "bob_classification"           text,
  "bob_confidence"               real,
  "client_site_id"               uuid,
  "embedding"                    public.vector(384),
  "embedding_quality"            double precision,
  "movement_detected"            boolean,
  "movement_similarity"          double precision,
  "zone_id"                      uuid,
  "is_disabled_bay"              boolean,
  "road_marking_detected"        text,
  "sign_time_limit_minutes"      integer,
  "sign_confidence"              double precision,
  "effective_time_limit_minutes" integer,
  "inference_provider"           text,
  "vehicle_make"                 text,
  "vehicle_model"                text,
  "vehicle_colour"               text,
  "rego_status"                  text,
  "rego_expiry"                  date,
  "wof_status"                   text,
  "wof_expiry"                   date,
  "cof_status"                   text,
  "cof_expiry"                   date,
  "vehicle_compliance_flags"     jsonb,
  "updated_at"                   timestamp with time zone not null default now(),
  "photo_urls"                   jsonb                    default '[]'::jsonb,
  "geofence_context"             jsonb                    not null default '{}'::jsonb,
  "canonical_vehicle_id"         uuid,
  constraint "parking_chalk_records_canonical_vehicle_id_fkey" foreign key (canonical_vehicle_id) references public.canonical_vehicles(id) on delete set null,
  constraint "parking_chalk_records_client_site_id_fkey" foreign key (client_site_id) references public.client_sites(id) on delete set null,
  constraint "parking_chalk_records_cof_status_check" check ((cof_status = ANY (ARRAY['current'::text, 'expired'::text, 'unknown'::text]))),
  constraint "parking_chalk_records_organization_id_fkey" foreign key (organization_id) references public.organizations(id) on delete cascade,
  constraint "parking_chalk_records_pkey" primary key (id),
  constraint "parking_chalk_records_rego_status_check" check ((rego_status = ANY (ARRAY['current'::text, 'expired'::text, 'unknown'::text]))),
  constraint "parking_chalk_records_road_marking_detected_check"
    check ((road_marking_detected = ANY (ARRAY['yellow_lines'::text, 'disabled_bay'::text, 'standard'::text, 'unknown'::text]))),
  constraint "parking_chalk_records_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete set null,
  constraint "parking_chalk_records_wof_status_check" check ((wof_status = ANY (ARRAY['current'::text, 'expired'::text, 'unknown'::text]))),
  constraint "parking_chalk_records_zone_id_fkey" foreign key (zone_id) references public.location_zones(id) on delete set null,
  constraint "parking_chalk_records_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id) on delete set null
);

alter table "public"."parking_chalk_records"
  enable row level security;

create index idx_parking_chalk_records_client_site on public.parking_chalk_records using btree (client_site_id);

create index idx_parking_chalk_records_compliance_lookup on public.parking_chalk_records using btree (organization_id, plate, status, chalked_at desc)
  where (status = 'active'::text);

create index idx_parking_chalk_records_has_photos on public.parking_chalk_records using btree (((jsonb_array_length(photo_urls) > 0)));

create index idx_parking_chalk_records_plate_date on public.parking_chalk_records using btree (organization_id, plate, chalked_at);

create index idx_parking_chalk_records_zone on public.parking_chalk_records using btree (zone_id);

create index idx_pcr_org_status on public.parking_chalk_records using btree (organization_id, status);

create index idx_pcr_plate on public.parking_chalk_records using btree (plate);

create trigger trg_parking_chalk_records_updated_at
  before update on public.parking_chalk_records
  for each row
  execute function public.parking_chalk_records_set_updated_at();

create trigger trg_parking_chalk_preserve_geofence_context
  before update of geofence_context on public.parking_chalk_records
  for each row
  execute function public.preserve_scan_geofence_context();

create policy "bob_full_read" on "public"."parking_chalk_records"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "pcr_insert" on "public"."parking_chalk_records"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "pcr_select" on "public"."parking_chalk_records"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "pcr_update" on "public"."parking_chalk_records"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."parking_chalk_records" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."parking_chalk_records"."bob_classification" is 'Bob AI classification result for parking violation detection from photo evidence';

comment on column "public"."parking_chalk_records"."bob_confidence" is 'Bob AI confidence score (0-100) for the classification result';

comment on column "public"."parking_chalk_records"."client_site_id" is 'Canonical site anchor (client_sites.id). Populated when the officer selects a known site during chalk recording. Nullable — free-text location_name remains for ad-hoc locations without a registered site.';

comment on column "public"."parking_chalk_records"."cof_status" is 'Certificate of Fitness status at time of chalk: current, expired, unknown.';

comment on column "public"."parking_chalk_records"."effective_time_limit_minutes" is 'Effective time limit applied to this record. Resolved by priority: sign OCR > zone default > org default (parking_module_config.default_time_limit_minutes).';

comment on column "public"."parking_chalk_records"."embedding" is '384D MobileNetV3 embedding (pgvector). Used for movement detection via cosine similarity between first-pass and return-pass scans of the same vehicle.';

comment on column "public"."parking_chalk_records"."embedding_quality" is 'Quality score (0–1) of the embedding extraction. Low values indicate poor photo quality or obstructed view.';

comment on column "public"."parking_chalk_records"."inference_provider" is 'Which inference provider produced the results: e.g. "local" (on-device ONNX) or "classify_photo" (server-side pipeline).';

comment on column "public"."parking_chalk_records"."geofence_context" is 'Immutable-at-capture snapshot of resolve_context and is_zone_closed evidence used by the parking scan. Geometry answers where; rules and closure overlays answer what.';

comment on column "public"."parking_chalk_records"."is_disabled_bay" is 'Whether the parking bay is a designated disabled bay, detected from road markings or signage by the inference pipeline.';

comment on column "public"."parking_chalk_records"."movement_detected" is 'Whether the vehicle moved between scans. true = moved (not overstaying), false = stationary, null = not yet checked.';

comment on column "public"."parking_chalk_records"."movement_similarity" is 'Cosine similarity (0–1) between first-pass and return-pass embeddings. Lower values suggest the vehicle moved.';

comment on column "public"."parking_chalk_records"."photo_urls" is 'Array of photo storage paths with metadata: [{"id": "...", "name": "...", "storage_path": "...", "uploaded_at": "...", "metadata": {"gps_latitude": 0, "gps_longitude": 0, "gps_accuracy": 0, "address": "...", "zone": "...", "officer_id": "...", "officer_name": "..."}}]';

comment on column "public"."parking_chalk_records"."rego_status" is 'Registration status at time of chalk: current, expired, unknown.';

comment on column "public"."parking_chalk_records"."road_marking_detected" is 'Road marking classification from inference: yellow_lines, disabled_bay, standard, or unknown.';

comment on column "public"."parking_chalk_records"."sign_confidence" is 'Confidence score (0–1) of the signage OCR time-limit extraction.';

comment on column "public"."parking_chalk_records"."sign_time_limit_minutes" is 'Parking time limit in minutes extracted from signage via OCR. Null if no sign detected or OCR failed.';

comment on column "public"."parking_chalk_records"."updated_at" is 'Last modification timestamp. Auto-set by trigger on every UPDATE. Added in 0233 for audit trail completeness.';

comment on column "public"."parking_chalk_records"."vehicle_colour" is 'Vehicle colour as detected by the inference pipeline. Stored as free text to accommodate multi-tone descriptions.';

comment on column "public"."parking_chalk_records"."vehicle_compliance_flags" is 'Array of compliance flags detected at scan time, e.g. ["expired_rego", "expired_wof"].';

comment on column "public"."parking_chalk_records"."vehicle_make" is 'Vehicle make (e.g. Toyota, Ford) as detected by the inference pipeline.';

comment on column "public"."parking_chalk_records"."vehicle_model" is 'Vehicle model (e.g. Corolla, Ranger) as detected by the inference pipeline.';

comment on column "public"."parking_chalk_records"."wof_status" is 'Warrant of Fitness status at time of chalk: current, expired, unknown.';

comment on column "public"."parking_chalk_records"."zone_id" is 'Geofence anchor — the location_zones row the vehicle was parked in at scan time. Used for zone-specific time limits and repeat-offender queries.';

comment on index "public"."idx_parking_chalk_records_compliance_lookup" is 'Partial index for evaluate_parking_compliance RPC: fast lookup of active chalk records by org+plate, ordered by chalked_at desc. 0233 P1 fix.';

comment on table "public"."parking_chalk_records" is 'Parking chalk pass records. Tracks tyre marks, return times, and overstay status.';
