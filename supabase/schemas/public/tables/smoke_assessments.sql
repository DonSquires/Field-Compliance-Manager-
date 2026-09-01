create table "public"."smoke_assessments" (
  "id"                  uuid                     not null default gen_random_uuid(),
  "organization_id"     uuid                     not null,
  "dispatch_job_id"     uuid,
  "officer_user_id"     uuid,
  "location_id"         uuid,
  "complaint_source"    text,
  "smoke_source_type"   text,
  "checklist"           jsonb                    not null default '{}'::jsonb,
  "bob_recommendation"  text,
  "action_taken"        text,
  "is_out_of_hours"     boolean                  not null default false,
  "scene_description"   text,
  "assessed_at"         timestamp with time zone not null default now(),
  "created_at"          timestamp with time zone not null default now(),
  "officer_id"          uuid,
  "officer_name"        text,
  "site_id"             uuid,
  "smoke_source"        text,
  "source_confirmed"    boolean                  not null default false,
  "bob_classification"  text,
  "bob_confidence"      real,
  "severity"            text,
  "action"              text,
  "notice_number"       text,
  "legal_basis"         text                     default 'RMA s.17A'::text,
  "follow_up_required"  boolean                  not null default false,
  "status"              text                     not null default 'open'::text,
  "notes"               text,
  "photo_urls"          jsonb                    default '[]'::jsonb,
  "address"             text,
  "complaint_address"   text,
  "complainant_site_id" uuid,
  "gps_lat"             double precision,
  "gps_lng"             double precision,
  constraint "smoke_assessments_action_taken_check"
    check ((action_taken = ANY (ARRAY['no_action'::text, 'verbal_warning'::text, 'abatement_notice'::text, 'infringement_notice'::text, 'prosecution_referral'::text]))),
  constraint "smoke_assessments_complainant_site_id_fkey" foreign key (complainant_site_id) references public.client_sites(id) on delete set null,
  constraint "smoke_assessments_complaint_source_check" check ((complaint_source = ANY (ARRAY['neighbour'::text, 'council_hotline'::text, 'self_report'::text, 'other'::text]))),
  constraint "smoke_assessments_dispatch_job_id_fkey" foreign key (dispatch_job_id) references public.dispatch_jobs(id),
  constraint "smoke_assessments_organization_id_fkey" foreign key (organization_id) references public.organizations(id),
  constraint "smoke_assessments_pkey" primary key (id),
  constraint "smoke_assessments_site_id_fkey" foreign key (site_id) references public.client_sites(id) on delete set null,
  constraint "smoke_assessments_smoke_source_type_check"
    check
    ((smoke_source_type = ANY (ARRAY['domestic_solid_fuel'::text, 'industrial'::text, 'vehicle_exhaust'::text, 'agricultural'::text, 'nuisance_burning'::text, 'unknown'::text]))),
  constraint "smoke_assessments_officer_id_fkey" foreign key (officer_id) references public.user_profiles(id) on delete set null,
  constraint "smoke_assessments_officer_user_id_fkey" foreign key (officer_user_id) references public.user_profiles(id)
);

alter table "public"."smoke_assessments"
  enable row level security;

create index idx_sa_complainant_site_id on public.smoke_assessments using btree (complainant_site_id)
  where (complainant_site_id is not null);

create index idx_sa_complaint_address on public.smoke_assessments using btree (organization_id, complaint_address)
  where (complaint_address is not null);

create index idx_sa_org_status on public.smoke_assessments using btree (organization_id, status);

create index idx_smoke_assessments_has_photos on public.smoke_assessments using btree (((jsonb_array_length(photo_urls) > 0)));

create policy "bob_full_read" on "public"."smoke_assessments"
  for select
  to "authenticated"
  using ((( select auth.uid() as uid) = '00000000-0000-0000-0000-00000000b0b0'::uuid));

create policy "sa_insert" on "public"."smoke_assessments"
  for insert
  to PUBLIC
  with check (public.org_access_allowed(organization_id));

create policy "sa_select" on "public"."smoke_assessments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

create policy "sa_task_entitlement_select" on "public"."smoke_assessments"
  for select
  to "authenticated"
  using (public.user_has_task_entitlement(auth.uid(), p_smoke_assessment_id => id));

create policy "sa_update" on "public"."smoke_assessments"
  for update
  to PUBLIC
  using (public.org_access_allowed(organization_id))
  with check (public.org_access_allowed(organization_id));

create policy "smoke_assessments_select" on "public"."smoke_assessments"
  for select
  to PUBLIC
  using (public.org_access_allowed(organization_id));

grant delete, insert, maintain, references, select, trigger, truncate, update on table "public"."smoke_assessments" to "anon", "authenticated", "postgres", "service_role";

comment on column "public"."smoke_assessments"."address" is 'Free-text complaint address entered by the officer. Added in 0236 — the SmokeControlPage UI was built against this column but it never existed live (same drift class as photo_urls/0033).';

comment on column "public"."smoke_assessments"."complainant_site_id" is 'Optional FK to client_sites for the harmed/protected party''s property. Distinct from site_id (the smoke SOURCE property). complaint_source is classification text, NOT this anchor. Enables pattern detection (e.g. repeat complaints from the same address). Write-contract slice 1; mirrors noise_assessments.complainant_site_id (0238).';

comment on column "public"."smoke_assessments"."complaint_address" is 'The harmed/protected party''s address (where the affected party is located). Distinct from the source-side address column (the property producing the smoke). complaint_source is classification text (e.g. "neighbour"), NOT this anchor. Write-contract slice 1; mirrors noise_assessments.complaint_address (0238).';

comment on column "public"."smoke_assessments"."photo_urls" is 'Array of photo storage paths with metadata: [{"id": "...", "name": "...", "storage_path": "...", "uploaded_at": "...", "metadata": {"gps_latitude": 0, "gps_longitude": 0, "gps_accuracy": 0, "address": "...", "zone": "...", "officer_id": "...", "officer_name": "..."}}]';

comment on policy "sa_task_entitlement_select" on "public"."smoke_assessments" is 'ACCESS_MODEL.md keystone composition (same as observations 0325 / noise 0368). Additive PERMISSIVE SELECT: a reader sees a smoke assessment when they hold a LIVE TASK BASIS on it (0324 user_has_task_entitlement, SECURITY DEFINER via 0326). ORs with the preserved org path (sa_select); never replaces it. Writes untouched. Read anchor is the live task basis, not a raw address -- complainant_site_id/complaint_address (0335) remain the W2 record-side anchor. Fail-direction: under-reach. Operationally corrected / Doctrinally incomplete.';

comment on table "public"."smoke_assessments" is 'Smoke complaint assessments. 6-step workflow with Bob AI source classification and abatement notices.';
