create table "public"."geo_source_registry" (
  "id"              uuid                     not null default gen_random_uuid(),
  "agency_id"       text                     not null,
  "authority_class" text                     not null default 'council'::text,
  "source_class"    text                     not null default 'arcgis_featureserver'::text,
  "base_url"        text                     not null,
  "layer_id"        integer                  not null default 0,
  "search_field"    text                     not null,
  "place_kind"      text,
  "status"          text                     not null default 'provisional'::text,
  "last_tested_at"  timestamp with time zone,
  "verified_by"     uuid,
  "notes"           text,
  "created_at"      timestamp with time zone not null default now(),
  "updated_at"      timestamp with time zone not null default now(),
  constraint "geo_source_registry_authority_class_check"
    check ((authority_class = ANY (ARRAY['council'::text, 'regional_council'::text, 'linz'::text, 'doc'::text, 'nzta'::text, 'other'::text]))),
  constraint "geo_source_registry_pkey" primary key (id),
  constraint "geo_source_registry_source_class_check" check ((source_class = ANY (ARRAY['arcgis_featureserver'::text, 'ogc_features'::text, 'wfs'::text]))),
  constraint "geo_source_registry_status_check" check ((status = ANY (ARRAY['verified'::text, 'provisional'::text, 'stale'::text, 'retired'::text]))),
  constraint "geo_source_registry_verified_by_fkey" foreign key (verified_by) references public.user_profiles(id) on delete set null
);

alter table "public"."geo_source_registry"
  enable row level security;

create index idx_geo_source_registry_authority on public.geo_source_registry using btree (authority_class, status);

create unique index uq_geo_source_registry_agency_kind_layer on public.geo_source_registry using btree (agency_id, COALESCE(place_kind, ''::text), layer_id);

create policy "bob_full_read" on "public"."geo_source_registry"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "geo_source_registry_select" on "public"."geo_source_registry"
  for select
  to PUBLIC
  using ((auth.role() = 'authenticated'::text));

create policy "geo_source_registry_write" on "public"."geo_source_registry"
  for all
  to PUBLIC
  using ((exists ( select 1
   from public.user_profiles up
  where ((up.id = auth.uid()) AND (up.role = 'grand_master'::text)))))
  with check ((EXISTS ( SELECT 1
   FROM public.user_profiles up
  WHERE ((up.id = auth.uid()) AND (up.role = 'grand_master'::text)))));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."geo_source_registry" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."geo_source_registry"."status" is 'Endpoint-verified state only (verified/provisional/stale/retired). NOT a claim that any returned polygon is the correct boundary for a place.';

comment on table "public"."geo_source_registry" is 'Platform-level discovered geospatial endpoints (council ArcGIS, LINZ, DOC, NZTA). Bob discovers once, all orgs reuse. status = ENDPOINT verification only; polygon accuracy is decided by the per-zone_type validity/area gate + human review, not here.';
