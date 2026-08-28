create table "public"."observations" (
  "id"                           uuid                        not null default gen_random_uuid(),
  "organization_id"              uuid                        not null,
  "officer_id"                   uuid                        not null,
  "plate_number"                 text                        not null,
  "gps_lat"                      double precision,
  "gps_lng"                      double precision,
  "gps_point"                    public.geometry(Point,4326),
  "zone_id"                      uuid,
  "site_id"                      uuid,
  "location_id"                  uuid,
  "observed_at"                  timestamp with time zone    not null default now(),
  "photo_url"                    text,
  "photo_quality"                double precision,
  "plate_confidence"             double precision,
  "plate_source"                 text                        default 'manual'::text,
  "vehicle_make"                 text,
  "vehicle_model"                text,
  "vehicle_year"                 integer,
  "vehicle_colour"               text,
  "is_scv"                       boolean,
  "scv_certificate_number"       text,
  "is_homeless"                  boolean                     not null default false,
  "is_compliant"                 boolean,
  "compliance_reason"            text,
  "nights_this_zone"             integer,
  "nights_this_month"            integer,
  "module_key"                   text                        not null default 'freedom_camping'::text,
  "synced_at"                    timestamp with time zone,
  "offline_queued"               boolean                     not null default false,
  "created_at"                   timestamp with time zone    not null default now(),
  "embedding"                    jsonb,
  "embedding_quality"            double precision,
  "detection_bbox"               jsonb,
  "detection_confidence"         double precision,
  "sticker_presence"             boolean,
  "sticker_color"                text,
  "sticker_detection_confidence" double precision,
  "previous_observation_id"      uuid,
  "movement_moved"               boolean,
  "movement_similarity"          double precision,
  "movement_decision"            text,
  "original_photo_url"           text,
  "watermarked_photo_url"        text,
  "photo_captured_at"            timestamp with time zone,
  "photo_watermark_text"         text,
  "officer_notes"                text,
  "officer_notes_updated_at"     timestamp with time zone,
  "retention_until"              timestamp with time zone,
  "retention_reason"             text,
  "retention_hold"               boolean                     not null default false,
  "retention_hold_days"          integer,
  "external_refs"                jsonb                       not null default '{}'::jsonb,
  "enforcement_exempt"           boolean                     not null default false,
  "exemption_reason"             text,
  "compliance_status"            text,
  "client_org_id"                uuid,
  "locked_at"                    timestamp with time zone,
  constraint "observations_compliance_status_check"
    check ((compliance_status = ANY (ARRAY['compliant'::text, 'at_risk'::text, 'breach'::text, 'breach_exempt'::text, 'unknown'::text]))),
  constraint "observations_movement_decision_check" check ((movement_decision = ANY (ARRAY['moved'::text, 'stationary'::text, 'inconclusive'::text]))),
  constraint "observations_pkey" primary key (id),
  constraint "observations_plate_source_check" check ((plate_source = ANY (ARRAY['alpr'::text, 'manual'::text, 'qr'::text, 'nfc'::text, 'historical_import'::text]))),
  constraint "observations_previous_observation_id_fkey" foreign key (previous_observation_id) references public.observations(id),
  constraint "observations_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "observations_sticker_color_check" check ((sticker_color = ANY (ARRAY['blue'::text, 'green'::text, 'unknown'::text]))),
  constraint "observations_zone_id_fkey" foreign key (zone_id) references public.location_zones(id),
  constraint "observations_client_org_id_fkey" foreign key (client_org_id) references public.organizations(id),
  constraint "observations_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "observations_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id)
);

alter table "public"."observations"
  enable row level security;

create index idx_observations_client_org_id on public.observations using btree (client_org_id);

create index idx_observations_compliance on public.observations using btree (organization_id, is_compliant, observed_at desc);

create index idx_observations_enforcement_exempt on public.observations using btree (organization_id, enforcement_exempt)
  where (enforcement_exempt = true);

create index idx_observations_external_refs on public.observations using gin (external_refs);

create index idx_observations_gps_point on public.observations using gist (gps_point);

create index idx_observations_officer on public.observations using btree (officer_id, observed_at desc);

create index idx_observations_org_time on public.observations using btree (organization_id, observed_at desc);

create index idx_observations_photo_captured_at on public.observations using btree (organization_id, photo_captured_at desc);

create index idx_observations_plate_zone on public.observations using btree (plate_number, zone_id, observed_at desc);

create index idx_observations_retention on public.observations using btree (retention_until)
  where (retention_hold = false);

create index idx_observations_site on public.observations using btree (site_id)
  where (site_id is not null);

create unique index idx_observations_vehicle_log_id on public.observations using btree (organization_id, (((external_refs -> 'vehicle_log'::text) ->> 'id'::text)))
  where (external_refs ? 'vehicle_log'::text);

create index idx_observations_zone on public.observations using btree (zone_id, observed_at desc);

create trigger observations_gps_point_trigger
  before insert or update on public.observations
  for each row
  execute function public.observations_set_gps_point();

create trigger trg_observations_lock_on_completion
  before update on public.observations
  for each row
  execute function public.tg_observations_lock_on_completion();

create trigger trg_observations_post_lock_enforce
  before update on public.observations
  for each row
  execute function public.tg_observations_enforce_lock();

create policy "bob_full_read" on "public"."observations"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "observations_client_org_select" on "public"."observations"
  for select
  to PUBLIC
  using (public.org_access_allowed(client_org_id));

create policy "observations_insert" on "public"."observations"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "observations_select" on "public"."observations"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "observations_task_entitlement_select" on "public"."observations"
  for select
  to "authenticated"
  using (public.user_has_task_entitlement(auth.uid(), id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."observations" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."observations"."compliance_status" is 'Officer-facing tri-state+ verdict written by process-officer-scan (Step 8a). breach_exempt = non-compliant AND enforcement_exempt (distinct from both compliant and breach -- see homeless-exemption KPI). This column did not previously exist even though the application code already wrote this key on every insert -- fixes a live schema gap, not a new write path. #74.';

comment on column "public"."observations"."embedding" is '384D MobileNetV3 embedding as JSONB array. Used for movement detection via cosine similarity.';

comment on column "public"."observations"."enforcement_exempt" is 'True when enforcement is suppressed for this observation independent of the compliance verdict (e.g. a confirmed homeless_claims record). Does NOT change is_compliant/compliance_reason -- the true rule outcome is always recorded; this only controls whether a notice is issued. #74.';

comment on column "public"."observations"."exemption_reason" is 'Why enforcement_exempt is true, e.g. ''confirmed_homeless''. Null when enforcement_exempt is false. #74.';

comment on column "public"."observations"."external_refs" is 'Generic external system reference IDs for this observation. Keys are source system names (e.g. vehicle_log, deputy, wilsar), values are objects of field->value pairs. Used by the governed batch-import pipeline for lineage and idempotency. E.g. {"vehicle_log": {"id": "14036", "title": "Bendigo"}}.';

comment on column "public"."observations"."locked_at" is 'Set once when the observation capture is complete and the fact record is sealed. NULL = pending completion. NOT NULL = locked. Set by trigger on photo_captured_at transitioning from NULL to NOT NULL. Never updated after set.';

comment on column "public"."observations"."movement_moved" is 'Movement detection result. true=vehicle moved since last scan, false=stationary, null=not checked.';

comment on column "public"."observations"."officer_notes" is 'Officer-entered scene notes and observations captured from scan detail review.';

comment on column "public"."observations"."officer_notes_updated_at" is 'Timestamp when officer_notes was last updated.';

comment on column "public"."observations"."original_photo_url" is 'Private storage path/URL for the original unmodified scan photo.';

comment on column "public"."observations"."photo_captured_at" is 'Timestamp associated with the captured evidence photo.';

comment on column "public"."observations"."photo_watermark_text" is 'Exact text rendered into the watermarked evidence photo for audit reproducibility.';

comment on column "public"."observations"."plate_source" is 'How the plate was captured: alpr, manual, qr, nfc (live scans, 0009), historical_import (batch CSV backfill, 0243, #163).';

comment on column "public"."observations"."previous_observation_id" is 'Reference observation used for movement comparison. NULL if first scan of this plate in this zone.';

comment on column "public"."observations"."retention_hold" is 'True = never auto-purge while held (e.g. abandoned vehicle, dispute pending).';

comment on column "public"."observations"."retention_until" is 'When this evidence record may be purged. Computed from the applicable retention_policies row when status is set (infringement / non_infringement / hold). Never hardcoded.';

comment on column "public"."observations"."sticker_presence" is 'SCV sticker detection. true=present, false=absent, null=inconclusive (requires manual review).';

comment on column "public"."observations"."watermarked_photo_url" is 'Private storage path/URL for the evidence-grade watermarked scan photo.';

comment on policy "observations_task_entitlement_select" on "public"."observations" is 'ACCESS_MODEL.md step 3/4 keystone. Additive SELECT path: a reader sees an observation when they hold a LIVE TASK BASIS on it (0324 user_has_task_entitlement). PERMISSIVE -- ORs with the preserved org paths (observations_select, observations_client_org_select), never replaces them. No outer location wrapper (0324 resolves presence/location via its signals). Writes untouched. Perf deferred (ruling A): live observations is empty today.';

comment on table "public"."observations" is 'Central fact table. Every officer scan creates one row. All enforcement traces back here.';
