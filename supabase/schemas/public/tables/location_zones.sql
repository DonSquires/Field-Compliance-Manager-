create table "public"."location_zones" (
  "id"                            uuid                               not null default gen_random_uuid(),
  "organization_id"               uuid                               not null,
  "name"                          text                               not null,
  "nightly_limit_consecutive"     integer,
  "nightly_limit_monthly"         integer,
  "scv_required"                  boolean                            not null default false,
  "boundary_legacy"               jsonb,
  "jurisdiction_rule_set_id"      uuid,
  "metadata"                      jsonb                              not null default '{}'::jsonb,
  "created_at"                    timestamp with time zone           not null default now(),
  "boundary"                      public.geometry(MultiPolygon,4326),
  "center_point"                  public.geometry(Point,4326),
  "radius_meters"                 integer,
  "zone_type"                     text                               not null default 'freedom_camping'::text,
  "module_key"                    text                               not null default 'freedom_camping'::text,
  "bylaw_clause"                  text,
  "bylaw_source_url"              text,
  "parent_zone_id"                uuid,
  "site_id"                       uuid,
  "is_active"                     boolean                            not null default true,
  "repeat_stay_radius_meters"     integer,
  "repeat_stay_window_nights"     integer,
  "enforcement_workflow_override" text,
  "repeat_stay_radius_m"          integer,
  "onsite_profile"                text                               not null default 'boundary'::text,
  "active_schedule"               jsonb,
  "rule_overrides"                jsonb,
  "is_adhoc"                      boolean                            not null default false,
  "parking_time_limit_minutes"    integer,
  "parking_disabled_multiplier"   numeric                            not null default 2,
  "parking_signage_photo_url"     text,
  "parking_limit_source"          text,
  "parking_limit_set_by"          uuid,
  "parking_limit_set_at"          timestamp with time zone,
  "address"                       text,
  "suburb"                        text,
  "postcode"                      text,
  "address_match_key"             text,
  "external_ref"                  text,
  "internal_client_ref"           text,
  "despatch_zone_code"            text,
  "location_id"                   uuid,
  "rule_type"                     text                               not null default 'overnight_limited'::text,
  "boundary_status"               text                               not null default 'authoritative'::text,
  "scv_exempts_restriction"       boolean                            not null default true,
  "boundary_verification"         text                               not null default 'unverified'::text,
  "boundary_verified_by"          uuid,
  "boundary_verified_at"          timestamp with time zone,
  constraint "location_zones_boundary_status_check" check ((boundary_status = ANY (ARRAY['authoritative'::text, 'provisional'::text]))),
  constraint "location_zones_boundary_verification_check" check ((boundary_verification = ANY (ARRAY['unverified'::text, 'verified'::text]))),
  constraint "location_zones_enforcement_workflow_override_check"
    check ((enforcement_workflow_override = ANY (ARRAY['admin_first'::text, 'officer_direct'::text, 'hybrid'::text]))),
  constraint "location_zones_jurisdiction_rule_set_id_fkey" foreign key (jurisdiction_rule_set_id) references public.jurisdiction_rule_sets(id),
  constraint "location_zones_onsite_profile_check" check ((onsite_profile = ANY (ARRAY['boundary'::text, 'approach_10m'::text]))),
  constraint "location_zones_parking_disabled_multiplier_check" check ((parking_disabled_multiplier >= (1)::numeric)),
  constraint "location_zones_parking_limit_source_check" check ((parking_limit_source = ANY (ARRAY['bob_signage'::text, 'manual'::text, 'rfp_seed'::text]))),
  constraint "location_zones_pkey" primary key (id),
  constraint "location_zones_parent_zone_id_fkey" foreign key (parent_zone_id) references public.location_zones(id),
  constraint "location_zones_rule_type_check"
    check ((rule_type = ANY (ARRAY['overnight_limited'::text, 'day_visit_only'::text, 'prohibited'::text, 'restricted'::text, 'unrestricted'::text]))),
  constraint "location_zones_site_id_fkey" foreign key (site_id) references public.client_sites(id),
  constraint "location_zones_zone_type_check"
    check
    ((zone_type = ANY (ARRAY['freedom_camping'::text, 'parking'::text, 'noise_control'::text, 'biosecurity'::text, 'trespass'::text, 'access_control'::text, 'general'::text,
    'patrol_route'::text]))),
  constraint "location_zones_location_id_fkey" foreign key (location_id) references public.locations(id) on delete set null,
  constraint "location_zones_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "location_zones_boundary_verified_by_fkey" foreign key (boundary_verified_by) references public.user_profiles(id),
  constraint "location_zones_parking_limit_set_by_fkey" foreign key (parking_limit_set_by) references public.user_profiles(id) on delete set null
);

alter table "public"."location_zones"
  enable row level security;

create index idx_location_zones_boundary_status on public.location_zones using btree (boundary_status)
  where (boundary_status = 'provisional'::text);

create index idx_location_zones_boundary on public.location_zones using gist (boundary);

create index idx_location_zones_center_point on public.location_zones using gist (center_point);

create index idx_location_zones_location_id on public.location_zones using btree (location_id);

create index idx_location_zones_org_match_key on public.location_zones using btree (organization_id, address_match_key);

create index idx_location_zones_parent on public.location_zones using btree (parent_zone_id);

create index idx_location_zones_site_id on public.location_zones using btree (site_id);

create unique index uq_location_zones_org_despatch_code on public.location_zones using btree (organization_id, despatch_zone_code)
  where (despatch_zone_code is not null);

create policy "bob_full_read" on "public"."location_zones"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "location_zones_delete" on "public"."location_zones"
  for delete
  to PUBLIC
  using (public.is_admin_for_org(organization_id));

create policy "location_zones_insert" on "public"."location_zones"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(organization_id));

create policy "location_zones_select" on "public"."location_zones"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "location_zones_update" on "public"."location_zones"
  for update
  to PUBLIC
  using (public.is_admin_for_org(organization_id))
  with check (public.is_admin_for_org(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."location_zones" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."location_zones"."active_schedule" is 'Optional time-of-day/day schedule (jsonb) when this module geofence is active. Lets the same area be e.g. freedom_camping overnight and parking 08:00-20:00 as two rows.';

comment on column "public"."location_zones"."boundary" is 'PostGIS MultiPolygon boundary (EPSG:4326). Widened from Polygon in 0279 (Q7 ruling). Used for GPS-to-zone detection and map rendering.';

comment on column "public"."location_zones"."boundary_legacy" is 'Original jsonb boundary. Kept for migration safety. Drop once all zones are re-drawn with PostGIS.';

comment on column "public"."location_zones"."boundary_status" is 'Fence provenance: authoritative (LINZ parcel polygon, or a confirmed Google-backed polygon) or provisional (point-buffer created when no polygon was found, awaiting a human to draw the real boundary). Partial index surfaces the review queue: WHERE boundary_status = ''provisional''. Mirrors client_sites.boundary_status (0133).';

comment on column "public"."location_zones"."center_point" is 'Centroid of the zone polygon. Used for fast proximity queries.';

comment on column "public"."location_zones"."despatch_zone_code" is 'Operational patrol-route despatch code (e.g. 587 Nelson, 586 Richmond, 584 Stoke, 583 Motueka). The pivot that joins a billable patrol/alarm visit (Despatch Zone in the billing feeds) to its patrol route zone. Patrol route zones use zone_type=''patrol_route''; nesting/support relationships use parent_zone_id. text because these are external identifiers, not arithmetic values.';

comment on column "public"."location_zones"."enforcement_workflow_override" is 'Per-zone enforcement workflow override. NULL = inherit the org default.';

comment on column "public"."location_zones"."is_adhoc" is 'True for ad-hoc geofences created at incident time (noise/biosecurity/smoke/alarm), distinct from pre-mapped module geofences.';

comment on column "public"."location_zones"."location_id" is 'FK to the Location ("house") this zone is a facet of. Nullable during migration; once backfilled, every zone belongs to exactly one house. The zone is the area facet of the house.';

comment on column "public"."location_zones"."onsite_profile" is 'On-site activation profile: boundary (patrol/parking/freedom/static = polygon + onsite radius) or approach_10m (alarm/noise/biosecurity/smoke = 10 m pre-attendance ring).';

comment on column "public"."location_zones"."parent_zone_id" is 'Child zones take priority over parent zones in GPS detection. Allows sub-zones within a larger area.';

comment on column "public"."location_zones"."parking_disabled_multiplier" is 'Multiplier applied to the time limit for disabled (mobility) parking. Default 2 = double the posted time. Adjustable per zone.';

comment on column "public"."location_zones"."parking_limit_source" is 'Provenance of the time limit: bob_signage (OCR + human-approved), manual (admin set), rfp_seed (seeded from the contract).';

comment on column "public"."location_zones"."parking_signage_photo_url" is 'Storage path/URL of the photographed time-limit sign that is the legal authority for the limit (court-defensible provenance).';

comment on column "public"."location_zones"."parking_time_limit_minutes" is 'Posted parking time limit in minutes (e.g. P60=60, P120=120, P150=150, P90=90). Null = metered / no fixed limit. Editable in the zone Rules editor; settable from a Bob-read signage photo.';

comment on column "public"."location_zones"."radius_meters" is 'For circular zones: radius in metres from center_point. NULL for polygon zones.';

comment on column "public"."location_zones"."repeat_stay_radius_meters" is 'Repeat-stay rule radius in metres (NCC default 500). NULL = rule disabled for this zone.';

comment on column "public"."location_zones"."repeat_stay_window_nights" is 'Repeat-stay rule window in nights: a vehicle may not return within the radius for this many nights. NULL = rule disabled.';

comment on column "public"."location_zones"."rule_overrides" is 'Optional site/geofence-level rule overrides (jsonb) applied on top of the jurisdiction (council, module) ruleset. Override wins where present.';

comment on column "public"."location_zones"."rule_type" is 'Compliance rule class. Act-aligned values (Freedom Camping Act 2011): prohibited (no camping, no SCV exception), restricted (SCV-only; see scv_exempts_restriction), unrestricted (no restriction; night-limit columns may still apply as a bylaw condition). Legacy values from 0179 (overnight_limited, day_visit_only) remain valid during transition -- reclassify per zone via the actual council bylaw (propose_freedom_camping_org_strategy), not by guessing. #74.';

comment on column "public"."location_zones"."scv_exempts_restriction" is 'For rule_type=restricted zones: whether holding a valid SCV certificate exempts a vehicle from the restriction (the normal Freedom Camping Act reading). Default true. #74.';

comment on column "public"."location_zones"."site_id" is 'Links this zone to a client site. A site can have multiple zones.';

comment on column "public"."location_zones"."zone_type" is 'Enforcement type. Determines which compliance rules and notice templates apply.';

comment on constraint "location_zones_zone_type_check" on "public"."location_zones" is 'Allowed zone types. patrol_route added 0134 for Tier-2 patrol-route service areas (four-tier geofence, 0127). Additive: existing values unchanged.';

comment on table "public"."location_zones" is 'Canonical Zone facet under a Location/House. A Zone is a SIBLING of a Site, not a child of one: the House owns shared place identity, address, finance, and scheduling context; the Site is the addressed-point facet and the Zone is the operational area facet. A Zone may cover multiple addresses, streets, beaches, or mixed land and may stand alone; site_id is only an optional compatibility/route link. Module assignment is enforced through the active service-agreement module and location links, while module_key selects the zone-specific geofence and rules.';
