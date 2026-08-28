create table "public"."client_sites" (
  "id"                     uuid                          not null default gen_random_uuid(),
  "client_organization_id" uuid                          not null,
  "service_agreement_id"   uuid,
  "name"                   text                          not null,
  "address"                text,
  "metadata"               jsonb                         not null default '{}'::jsonb,
  "site_code"              text,
  "site_type"              text,
  "gps_lat"                double precision,
  "gps_lng"                double precision,
  "risk_level"             text,
  "site_brief"             text,
  "access_instructions"    text,
  "hs_notes"               text,
  "jurisdiction_config_id" uuid,
  "active"                 boolean                       not null default true,
  "created_at"             timestamp with time zone      not null default now(),
  "boundary"               public.geometry(Polygon,4326),
  "center_point"           public.geometry(Point,4326),
  "prompt_radius_meters"   integer                       not null default 30,
  "onsite_radius_meters"   integer                       not null default 10,
  "site_origin"            text                          not null default 'contracted'::text,
  "module_title"           text,
  "ownership_status"       text                          not null default 'resolved'::text,
  "ownership_signals"      jsonb,
  "address_match_key"      text,
  "external_ref"           text,
  "internal_client_ref"    text,
  "boundary_status"        text                          not null default 'authoritative'::text,
  "location_id"            uuid,
  "external_refs"          jsonb                         not null default '{}'::jsonb,
  "boundary_verification"  text                          not null default 'unverified'::text,
  "boundary_verified_by"   uuid,
  "boundary_verified_at"   timestamp with time zone,
  "organization_id"        uuid,
  constraint "client_sites_boundary_status_check" check ((boundary_status = ANY (ARRAY['authoritative'::text, 'provisional'::text]))),
  constraint "client_sites_boundary_verification_check" check ((boundary_verification = ANY (ARRAY['unverified'::text, 'verified'::text]))),
  constraint "client_sites_ownership_status_check" check ((ownership_status = ANY (ARRAY['resolved'::text, 'needs_review'::text]))),
  constraint "client_sites_pkey" primary key (id),
  constraint "client_sites_risk_level_check" check ((risk_level = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
  constraint "client_sites_site_origin_check" check ((site_origin = ANY (ARRAY['contracted'::text, 'enforcement'::text, 'alarm'::text, 'adhoc'::text]))),
  constraint "client_sites_site_type_check"
    check
    ((site_type = ANY (ARRAY['freedom_camping_area'::text, 'parking_area'::text, 'commercial_premises'::text, 'residential_complex'::text, 'government_facility'::text,
    'hospital'::text, 'education_facility'::text, 'industrial_site'::text, 'public_space'::text, 'other'::text]))),
  constraint "client_sites_jurisdiction_config_id_fkey" foreign key (jurisdiction_config_id) references public.crm_jurisdiction_configs(id),
  constraint "client_sites_location_id_fkey" foreign key (location_id) references public.locations(id) on delete set null,
  constraint "client_sites_client_organization_id_fkey" foreign key (client_organization_id) references public.organizations(id),
  constraint "client_sites_service_agreement_id_fkey" foreign key (service_agreement_id) references public.service_agreements(id),
  constraint "client_sites_boundary_verified_by_fkey" foreign key (boundary_verified_by) references public.user_profiles(id)
);

alter table "public"."client_sites"
  enable row level security;

alter table "public"."client_sites"
  add constraint "client_sites_geo_required_chk" check (((center_point IS NOT NULL) OR (boundary IS NOT NULL))) not valid;

create index idx_client_sites_address_match_key on public.client_sites using btree (address_match_key);

create index idx_client_sites_boundary_status on public.client_sites using btree (boundary_status)
  where (boundary_status = 'provisional'::text);

create index idx_client_sites_boundary on public.client_sites using gist (boundary);

create index idx_client_sites_center_point on public.client_sites using gist (center_point);

create index idx_client_sites_external_refs on public.client_sites using gin (external_refs);

create index idx_client_sites_location_id on public.client_sites using btree (location_id);

create index idx_client_sites_org_external_ref on public.client_sites using btree (client_organization_id, external_ref);

create unique index idx_client_sites_owner_site_code on public.client_sites using btree (client_organization_id, site_code)
  where (site_code is not null);

create trigger trg_autolink_client_site_service_agreement
  before insert or update on public.client_sites
  for each row
  execute function public.autolink_client_site_service_agreement();

create trigger trg_ensure_site_financial_config_from_site
  after insert or update of service_agreement_id on public.client_sites
  for each row
  execute function public.ensure_site_financial_config_from_site();

create trigger trg_sync_client_sites_org_ids
  before insert or update on public.client_sites
  for each row
  execute function public.sync_client_sites_org_ids();

create trigger trg_sync_service_agreement_location_from_site
  after insert or update of service_agreement_id on public.client_sites
  for each row
  execute function public.sync_service_agreement_location_from_site();

create policy "bob_full_read" on "public"."client_sites"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "client_sites_agreement_select" on "public"."client_sites"
  for select
  to PUBLIC
  using ((public.has_location_access(id, null::uuid, 'provider_reads_client'::text) or public.has_location_access(id, null::uuid, 'client_reads_provider'::text)));

create policy "client_sites_insert" on "public"."client_sites"
  for insert
  to PUBLIC
  with check (public.is_admin_for_org(client_organization_id));

create policy "client_sites_select" on "public"."client_sites"
  for select
  to PUBLIC
  using (public.org_access_allowed(client_organization_id));

create policy "client_sites_update" on "public"."client_sites"
  for update
  to PUBLIC
  using (public.is_admin_for_org(client_organization_id))
  with check (public.is_admin_for_org(client_organization_id));

create policy "gm_full_access" on "public"."client_sites"
  for all
  to "authenticated"
  using (public.is_grand_master())
  with check (public.is_grand_master());

create policy "master_manage_sites_insert" on "public"."client_sites"
  for insert
  to "authenticated"
  with check (public.is_master_for_org(client_organization_id));

create policy "master_manage_sites_update" on "public"."client_sites"
  for update
  to "authenticated"
  using (public.is_master_for_org(client_organization_id))
  with check (public.is_master_for_org(client_organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."client_sites" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."client_sites"."address_match_key" is 'Normalised address key for de-duplication so repeat/enforcement addresses resolve to one site (shared safety history).';

comment on column "public"."client_sites"."boundary" is 'PostGIS polygon boundary for the client site. Used for geofence prompts, auto on-site, and patrol routing.';

comment on column "public"."client_sites"."boundary_status" is 'Fence provenance: authoritative (LINZ parcel/building or confirmed polygon) or provisional (point-buffer created for urgent dispatch, awaiting human refinement). Partial index surfaces the provisional review queue. #19.';

comment on column "public"."client_sites"."center_point" is 'Centroid of the site boundary. Used for proximity and map centering.';

comment on column "public"."client_sites"."client_organization_id" is 'The organisation that OWNS this site/place (the PLACE axis of the two-axis ownership model). Legacy name: under Model A a "client" is a contextual role per service_agreement, not a permanent property - this column is OWNERSHIP of the place, not a fixed client relationship. A different org may operate here via a service_agreement_locations contract (see has_location_access, 0270). Read it as owner_organization_id.';

comment on column "public"."client_sites"."external_ref" is 'External source Client ID (import matching).';

comment on column "public"."client_sites"."external_refs" is 'Generic external system reference IDs. E.g. {"wilsar": {"client_id": "NCC200"}, "deputy": {"location_code": "6947"}}';

comment on column "public"."client_sites"."internal_client_ref" is 'External source Internal ClientId (import matching).';

comment on column "public"."client_sites"."location_id" is 'FK to the Location ("house") this site is a facet of. Nullable during migration; once backfilled, every site belongs to exactly one house. The site is the addressed-point facet of the house.';

comment on column "public"."client_sites"."module_title" is 'Display title for enforcement-origin sites, e.g. "Noise Control - 12 Example St".';

comment on column "public"."client_sites"."onsite_radius_meters" is 'Distance to auto-mark officer on-site (default 10 m).';

comment on column "public"."client_sites"."ownership_signals" is 'Signals used to resolve ownership (governing jurisdiction, job module, dispatch context) for admin adjudication.';

comment on column "public"."client_sites"."ownership_status" is 'resolved = organization_id is final; needs_review = ad-hoc ownership was ambiguous and an admin must confirm.';

comment on column "public"."client_sites"."prompt_radius_meters" is 'Distance to surface required modules (default 30 m).';

comment on column "public"."client_sites"."site_origin" is 'How the site entered the system: contracted (client site), enforcement (address subject to noise/biosecurity/smoke), alarm (alarm-response address), or adhoc.';

comment on constraint "client_sites_geo_required_chk" on "public"."client_sites" is 'Sites must have geospatial anchor data (center_point and/or boundary). Introduced in 0100 as NOT VALID; validate after clean seed.';

comment on table "public"."client_sites" is 'THE SITE TABLE. Despite the legacy name "client_sites", this is NOT "client-owned sites" - it is the SITE FACET of a Location ("house") under the House/Location model (migration 0145). A Location (locations) is the physical place; a Site (this table, the addressed point) and Zone(s) (location_zones, the area) are SIBLING FACETS of that house, linked via the nullable location_id FK. The name was kept (not renamed) deliberately to avoid a wide-blast rename across RPCs/RLS/edge-functions/frontend/Bob-knowledge; read it as "sites". Canonical model: docs/ORG_SERVICE_MODEL.md + the house_location_model Bob knowledge card. See also 0145, 0261 (location_contract_model), 0270 (has_location_access).';
