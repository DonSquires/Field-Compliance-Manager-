create table "public"."zone_signage_evidence" (
  "id"              uuid                     not null default gen_random_uuid(),
  "organization_id" uuid                     not null,
  "zone_id"         uuid                     not null,
  "officer_id"      uuid                     not null,
  "photo_url"       text                     not null,
  "sign_type"       text                     not null default 'freedom_camping'::text,
  "gps_lat"         double precision,
  "gps_lng"         double precision,
  "notes"           text,
  "captured_at"     timestamp with time zone not null default now(),
  constraint "zone_signage_evidence_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id),
  constraint "zone_signage_evidence_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "zone_signage_evidence_pkey" primary key (id),
  constraint "zone_signage_evidence_sign_type_check"
    check
    ((sign_type = ANY (ARRAY['freedom_camping'::text, 'no_camping'::text, 'parking'::text, 'no_parking'::text, 'noise_control'::text, 'biosecurity'::text, 'trespass'::text,
    'other'::text]))),
  constraint "zone_signage_evidence_zone_id_fkey" foreign key (zone_id) references public.location_zones(id)
);

alter table "public"."zone_signage_evidence"
  enable row level security;

create index idx_zone_signage_evidence_zone on public.zone_signage_evidence using btree (zone_id, captured_at desc);

create policy "bob_full_read" on "public"."zone_signage_evidence"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "zone_signage_evidence_insert" on "public"."zone_signage_evidence"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "zone_signage_evidence_select" on "public"."zone_signage_evidence"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."zone_signage_evidence" to "anon", "authenticated", "postgres", "service_role";

comment on table "public"."zone_signage_evidence" is 'Photos of posted signage at zone boundaries. Required for court-ready evidence package.';
